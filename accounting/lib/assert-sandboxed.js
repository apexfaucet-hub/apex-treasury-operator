'use strict';
// ACCOUNT LAYER: refuse to run outside the sandbox (2026-09-29, Fable review finding 3: "nothing enforces the sandbox,
// and the self-test cannot fail"). Every account and policy tool calls assertSandboxed() before it does anything.
// Each probe is built so that the two outcomes are DIFFERENT errors, so a probe can never pass by accident:
//   interfaces in /proc/self/net/dev:          sandboxed -> only 'lo',              not sandboxed -> eth0 etc.
//   TCP 127.0.0.1:22 (the host's sshd):         sandboxed -> ECONNREFUSED (own lo),  not sandboxed -> CONNECTED
//   unix /run/dbus/system_bus_socket:           sandboxed -> ENOENT (empty /run),    not sandboxed -> CONNECTED
//   TCP 1.1.1.1:443:                            sandboxed -> ENETUNREACH,            not sandboxed -> CONNECTED
// No probe talks to a real service, and no probe opens a key: paths are checked with access(), never read.
const fs = require('fs');
const net = require('net');

// PUBLISHED COPY: the exact list of secret paths on our server is not in this repository (it is a map of where keys
// live). It is read from an unpublished, root-owned file: one absolute path per line, '#' for comments. See
// accounting/secret-paths.example.json for the shape. A missing or empty list FAILS the probe: an empty list would pass.
const PATHS_FILE = process.env.ACCOUNT_SECRET_PATHS || '/usr/local/sbin/apex-account/secret-paths.json';
function loadSecretPaths() { try { return JSON.parse(fs.readFileSync(PATHS_FILE, 'utf8')); } catch (e) { return null; } }
const SECRET_CONF = loadSecretPaths();
const SECRET_PROBES = (SECRET_CONF && Array.isArray(SECRET_CONF.probes)) ? SECRET_CONF.probes : [];

// Opens one connection, resolves with the error code (or TIMEOUT / CONNECTED), and always tears the socket and the
// timer down: a dropped SYN would otherwise keep the process alive for minutes.
const expectErr = (opts) => new Promise((resolve) => {
  let done = false, s = null, t = null;
  const fin = (code) => { if (done) return; done = true; clearTimeout(t); try { s && s.destroy(); } catch (e) {} resolve(code); };
  t = setTimeout(() => fin('TIMEOUT'), 1500);
  try { s = net.createConnection(opts); s.on('error', (e) => fin(e.code || e.message)); s.on('connect', () => fin('CONNECTED')); } catch (e) { fin(e.code || e.message); }
});

async function probe() {
  const out = [];
  const add = (name, ok, detail) => out.push({ name, ok, detail });
  const uid = process.getuid();
  add('runs as its own uid, not claudeuser (1000) or root', uid !== 1000 && uid !== 0, 'uid ' + uid);
  let foreign = 0;
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try { const m = /Uid:\s+(\d+)/.exec(fs.readFileSync('/proc/' + d + '/status', 'utf8')); if (m && Number(m[1]) !== uid) foreign++; } catch (e) {}
    }
  } catch (e) { foreign = -1; }
  add("no other user's process is visible in /proc", foreign === 0, foreign + ' visible');
  add('secret-path list loaded (' + PATHS_FILE + ')', SECRET_PROBES.length > 0, SECRET_PROBES.length ? SECRET_PROBES.length + ' paths' : 'missing or empty: refusing to pass by accident');
  const reachable = SECRET_PROBES.filter((p) => { try { fs.accessSync(p, fs.constants.R_OK); return true; } catch (e) { return false; } });
  add('no key or secret path is reachable (' + SECRET_PROBES.length + ' probed with access())', reachable.length === 0, reachable.join(', ') || 'none');
  // Network (v4, review A1): the sandbox has its OWN network namespace holding only 'lo'. Each probe below gives a
  // different answer inside and outside, so none can pass by accident.
  let ifaces = [];
  try { ifaces = fs.readFileSync('/proc/self/net/dev', 'utf8').split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean); } catch (e) { ifaces = ['unreadable']; }
  add('its network namespace holds only loopback (no route anywhere)', ifaces.length === 1 && ifaces[0] === 'lo', ifaces.join(','));
  // host services: sshd always listens on the host's 127.0.0.1:22; inside the private namespace nothing does
  const lo = await expectErr({ host: '127.0.0.1', port: 22 });
  add("the host's loopback services are unreachable (sshd :22 as the witness)", lo === 'ECONNREFUSED' || lo === 'EPERM' || lo === 'TIMEOUT', lo);
  // host unix sockets: D-Bus lives in the host's /run, which the sandbox replaces with an empty tmpfs
  const bus = await expectErr({ path: '/run/dbus/system_bus_socket' });
  add('host unix sockets are unreachable (D-Bus as the witness; bot buses live under the hidden /home)', bus === 'ENOENT' || bus === 'EAFNOSUPPORT', bus);
  // the internet, directly: only the egress proxy's socket leads out
  const inet = await expectErr({ host: '1.1.1.1', port: 443 });
  add('no direct internet (1.1.1.1:443 as the witness; only the egress proxy leads out)', ['ENETUNREACH', 'EHOSTUNREACH', 'EPERM', 'TIMEOUT'].includes(inet), inet);
  // (the host's own addresses: unreachable by construction in a private namespace; the probes above prove it without
  // handing the origin IP to the sandbox - review 3 L1)
  // /dev/shm is the host's (review 2 #9); /root must be the sandbox's empty tmpfs, not the real /root
  let shm = false; try { fs.writeFileSync('/dev/shm/.account-probe', 'x'); shm = true; fs.unlinkSync('/dev/shm/.account-probe'); } catch (e) {}
  add('cannot write the shared /dev/shm', !shm, shm ? 'WROTE /dev/shm' : 'refused');
  let tmpfs = false; try { tmpfs = fs.statfsSync('/root').type === 0x01021994; } catch (e) {}
  add('/root is the sandbox tmpfs (only the allowlist is mounted in it)', tmpfs, tmpfs ? 'tmpfs' : 'NOT a tmpfs');
  let wrote = false; try { fs.writeFileSync('/root/apex-faucet/data/.account-write-probe', 'x'); wrote = true; fs.unlinkSync('/root/apex-faucet/data/.account-write-probe'); } catch (e) {}
  add('cannot write outside its own directories', !wrote, wrote ? 'WROTE to data/' : 'refused');
  let ownOk = false; try { const f = '/root/apex-faucet/data/protected/account/.write-probe'; fs.writeFileSync(f, 'x'); fs.unlinkSync(f); ownOk = true; } catch (e) {}
  add('can write its own directory', ownOk, ownOk ? 'ok' : 'refused');
  return out;
}

async function assertSandboxed() {
  const r = await probe();
  const bad = r.filter((x) => !x.ok);
  if (bad.length) {
    console.error('REFUSING TO RUN: not inside the account sandbox (sudo tools/account-run.sh /usr/bin/node <script>)');
    for (const b of bad) console.error('  - ' + b.name + ': ' + b.detail);
    process.exit(1);
  }
  return r;
}

module.exports = { assertSandboxed, probe, SECRET_PROBES };
