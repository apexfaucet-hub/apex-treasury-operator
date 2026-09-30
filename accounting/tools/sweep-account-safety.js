#!/usr/bin/env node
'use strict';
// SWEEP: a TRIPWIRE for the account layer (and the shadow policy gate), not a guarantee (Fable review 2 #6: 12 of 13
// deliberately obfuscated bypasses pass a token scan). The guarantee is the sandbox itself (no key is mounted, no socket,
// no local address). This catches honest mistakes and drift. Run as root so it can see what the sandbox must NOT see.
// Installed root-owned in /usr/local/sbin/apex-account (source: tools/sweep-account-safety.js; install: tools/account-install.sh).
//   1. code: no signing, no key loading, no send method anywhere in lib/account, lib/policy, tools/account-*, tools/policy-*
//      (comments are stripped first, so a comment that NAMES the danger is fine and a call is not)
//   2. every tool calls assertSandboxed() as the first statement of its main function
//   3. the wrapper still carries every isolation property
//   4. no allowlisted path is, or contains, a key-shaped file or a secret-named file
//   5. the account and policy directories belong to apex-account, mode 700
// Exit 1 on any failure. `--selftest` plants one fault of each kind in temporary copies and requires each to be caught.
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP = '/root/apex-faucet';
const CODE_DIRS = [APP + '/lib/account', APP + '/lib/policy'];
const TOOL_GLOBS = [/^account-.*\.js$/, /^policy-.*\.js$/];
// Checked on TOKENS, not text: identifiers and real string literals. Comments and regex literals are skipped, so a scanner
// that names a danger in a pattern (lib/policy's own tests) is fine, and a call or a path string is not.
const BANNED_IDENT = new Set(['fromSecretKey', 'fromSeed', 'privateKeyToAccount', 'mnemonicToAccount', 'fromMnemonic', 'secretKey', 'privateKey',
  'signTransaction', 'signAllTransactions', 'signMessage', 'createWalletClient', 'sendTransaction', 'sendRawTransaction', 'sendAndConfirmTransaction',
  'sendAndConfirmRawTransaction', 'simulateTransaction', 'requestAirdrop']);
const BANNED_STRING = [
  ['a send method', /^(sendTransaction|sendRawTransaction|simulateTransaction|requestAirdrop|eth_sendRawTransaction|eth_sendTransaction|eth_sign\w*|personal_sign)$/],
  ['a key path', /^\/(root|home)\/.*(\/keys(\/|$)|\/wallets?(\/|$)|keypair[^/]*\.json$|-wallet\.json$|\/\.env|\/\.[a-z0-9-]*(key|token)(\.json)?$|\.secret$|\/\.ssh|authority\.json$)/],
  ['a localhost service', /(^|\/\/)(127\.0\.0\.1|localhost)([:/]|$)|\.sock$/],
  // review 3 L3: --disallow-code-generation-from-strings stops eval/new Function, not the vm module
  ['a code-from-string module', /^(node:)?vm$/],
];
const BANNED_JOIN = /^(keys|wallets?|\.env|\.ssh)$/;   // a path.join(...) segment
// Allowed exceptions, each with the reason: the sandbox guard probes a non-existent socket and 127.0.0.1:1 on purpose,
// and lists the secret paths it proves unreachable (with access(), never read).
const EXCEPT = [[/lib\/account\/assert-sandboxed\.js$/, 'a localhost service'], [/lib\/account\/assert-sandboxed\.js$/, 'a key path'],
  // the launcher's bridge and the self-test's proxy probes use 127.0.0.1 INSIDE the sandbox's own empty network namespace
  // (PrivateNetwork=yes), where nothing else exists, and the egress proxy's socket, which is the sandbox's only way out
  [/lib\/account\/launch\.js$/, 'a localhost service'], [/lib\/account\/sandbox-selftest\.js$/, 'a localhost service']];

// Minimal JS tokenizer: strings, templates, comments, regex literals (the usual "what came before" rule), identifiers.
function tokens(src) {
  const out = []; let i = 0, prev = null;
  const regexOk = () => !prev || (prev.t === 'p' && !/^[)\]}]$/.test(prev.v)) || (prev.t === 'id' && /^(return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/.test(prev.v));
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1, v = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') { v += src[j + 1]; j += 2; continue; } if (c === '`' && src[j] === '$' && src[j + 1] === '{') { let d = 1; j += 2; while (j < src.length && d) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; } v += '\u0000'; continue; } v += src[j++]; }
      out.push(prev = { t: 's', v }); i = j + 1; continue;
    }
    if (c === '/' && regexOk()) {
      let j = i + 1, cls = false;
      while (j < src.length && (src[j] !== '/' || cls) && src[j] !== '\n') { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      j++; while (/[a-z]/i.test(src[j] || '')) j++;
      out.push(prev = { t: 'r', v: src.slice(i, j) }); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (/[\w$]/.test(src[j] || '')) j++; out.push(prev = { t: 'id', v: src.slice(i, j) }); i = j; continue; }
    if (/[0-9]/.test(c)) { let j = i; while (/[\w.]/.test(src[j] || '')) j++; out.push(prev = { t: 'n', v: src.slice(i, j) }); i = j; continue; }
    out.push(prev = { t: 'p', v: c }); i++;
  }
  return out;
}
const WRAPPER_MUST = ['User=apex-account', 'ProtectHome=tmpfs', 'ProtectSystem=strict', 'ProtectProc=invisible', 'ProcSubset=pid',
  'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'PrivateTmp=yes', 'BindReadOnlyPaths',
  'InaccessiblePaths=/dev/shm', 'readlink -e', '--disallow-code-generation-from-strings',
  // v4 (review A1): no network namespace of its own to escape from, the proxy socket as the only way out
  'PrivateNetwork=yes', 'IPAddressDeny=any', 'IPAddressAllow=localhost', 'TemporaryFileSystem=/run', 'BindReadOnlyPaths=/run/apex-account-egress',
  'NODE_USE_ENV_PROXY=1', 'lib/account/launch.js', 'proxy.sock',
  // review 3: bounded resources, a per-step time limit, named step units; no host address handed in
  'MemoryMax=1G', 'MemorySwapMax=0', 'TasksMax=64', 'TimeoutStartSec=$T', 'apex-account-step-'];
const INSTALLED = '/usr/local/sbin/apex-account';
const TRUSTED = ['account-run.sh', 'account-cycle.sh', 'sweep-account-safety.js', 'sandbox-allow.txt', 'sandbox-paths.txt',
  'egress-proxy.js', 'egress-allow.txt', 'account-extract.sql', 'account-extract.sh', 'validate-summary.js', 'account-site-fetch.sh', 'account-cycle-post.sh'];
const SOURCES = { 'account-run.sh': 'tools/account-run.src.sh', 'account-cycle.sh': 'tools/account-cycle.src.sh', 'sweep-account-safety.js': 'tools/sweep-account-safety.js',
  'sandbox-allow.txt': 'lib/account/sandbox-allow.txt', 'sandbox-paths.txt': 'lib/account/sandbox-paths.txt',
  'egress-proxy.js': 'tools/account-installed/egress-proxy.js', 'egress-allow.txt': 'tools/account-installed/egress-allow.txt',
  'account-extract.sql': 'tools/account-installed/account-extract.sql', 'account-extract.sh': 'tools/account-installed/account-extract.sh',
  'validate-summary.js': 'tools/account-installed/validate-summary.js', 'account-site-fetch.sh': 'tools/account-installed/account-site-fetch.sh',
  'account-cycle-post.sh': 'tools/account-installed/account-cycle-post.sh' };
const SECRET_NAME = /(^\.env|key|secret|token|seed|mnemonic|keypair|wallet.*\.json$|authority.*\.json$|\.pem$|id_rsa|id_ed25519)/i;
const KEY_SHAPE = [/\[\s*(\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/, /"(secretKey|privateKey|private_key|secret|mnemonic|seed)"\s*:\s*"[^"]{20,}"/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => {
    let inS = null;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (inS) { if (c === '\\') i++; else if (c === inS) inS = null; continue; }
      if (c === '"' || c === "'" || c === '`') inS = c;
      else if (c === '/' && l[i + 1] === '/') return l.slice(0, i);
    }
    return l;
  }).join('\n');
}
const walk = (d, out) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p, out); else out.push(p); } return out; };

function codeFiles(appRoot) {
  const out = [];
  for (const d of CODE_DIRS.map((x) => x.replace(APP, appRoot))) if (fs.existsSync(d)) walk(d, out);
  for (const f of fs.readdirSync(appRoot + '/tools')) if (TOOL_GLOBS.some((g) => g.test(f))) out.push(appRoot + '/tools/' + f);
  return out.filter((f) => f.endsWith('.js'));
}

function sweep(opts) {
  const appRoot = opts.appRoot || APP, fails = [], notes = [];
  const fail = (m) => fails.push(m);
  // 1 + 2
  for (const f of codeFiles(appRoot)) {
    const rel = path.relative(appRoot, f);
    const src = fs.readFileSync(f, 'utf8').replace(/^#!.*\n/, '');
    const tk = tokens(src);
    const skip = (what) => EXCEPT.some(([fre, w]) => fre.test(f) && w === what);
    for (let k = 0; k < tk.length; k++) {
      const x = tk[k];
      if (x.t === 'id' && BANNED_IDENT.has(x.v)) fail(rel + ': uses ' + x.v);
      if (x.t === 's') for (const [what, re] of BANNED_STRING) if (!skip(what) && re.test(x.v)) fail(rel + ': ' + what + ' ("' + x.v.slice(0, 60) + '")');
      if (x.t === 'id' && x.v === 'join' && tk[k - 1] && tk[k - 1].v === '.' && tk[k + 1] && tk[k + 1].v === '(') {
        for (let q = k + 2, d = 1; q < tk.length && d; q++) { if (tk[q].v === '(') d++; else if (tk[q].v === ')') d--; else if (tk[q].t === 's' && BANNED_JOIN.test(tk[q].v)) fail(rel + ': path.join into "' + tk[q].v + '"'); }
      }
    }
    if (/\/tools\//.test(f)) {
      // every "(async () => {" in a tool must begin with "await ... assertSandboxed(" (the review passed a file whose SECOND
      // main had no guard, and one that merely declared a variable named assertSandboxed)
      let mains = 0, bad = 0;
      for (let k = 0; k + 6 < tk.length; k++) {
        if (!(tk[k].v === '(' && tk[k + 1].v === 'async' && tk[k + 2].v === '(' && tk[k + 3].v === ')' && tk[k + 4].v === '=' && tk[k + 5].v === '>' && tk[k + 6].v === '{')) continue;
        mains++;
        const first = tk.slice(k + 7, k + 30).map((t) => t.v); const semi = first.indexOf(';'); const st = first.slice(0, semi < 0 ? 23 : semi);
        const gi = st.indexOf('assertSandboxed');
        if (st[0] !== 'await' || gi < 0 || st[gi + 1] !== '(') bad++;
      }
      if (!mains || bad) fail(rel + ': ' + (mains ? bad + ' of ' + mains + ' main function(s) do not start with await assertSandboxed()' : 'no main function starting with await assertSandboxed()'));
    }
  }
  // 3
  const wrapper = fs.readFileSync(opts.wrapper || INSTALLED + '/account-run.sh', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  for (const p of WRAPPER_MUST) if (!wrapper.includes(p)) fail('account-run.sh: missing ' + p);
  if (/User=claudeuser|User=root/.test(wrapper)) fail('account-run.sh: runs as claudeuser or root');
  // 4
  const allow = fs.readFileSync(opts.allow || INSTALLED + '/sandbox-allow.txt', 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  let files = 0, nmScanned = 0;
  for (const entry of allow) if (/(^|\/)(faucet\.db|screener\.db|arc-passport\.db)(-wal|-shm)?$/.test(entry)) fail('allowlist mounts a live database (read the extract instead): ' + entry);
  for (const entry of allow) {
    const paths = entry.endsWith('*') ? fs.readdirSync(path.dirname(entry)).filter((n) => n.startsWith(path.basename(entry).slice(0, -1))).map((n) => path.join(path.dirname(entry), n)) : [entry];
    for (const p of paths) {
      if (!fs.existsSync(p)) { if (!/-(wal|shm)$/.test(p)) notes.push('allowlisted path does not exist: ' + p); continue; }
      if (fs.lstatSync(p).isSymbolicLink() || fs.realpathSync(p) !== p) { fail('allowlisted path is or passes through a symlink: ' + p); continue; }
      const st = fs.statSync(p);
      const list = st.isDirectory() ? walk(p, []) : [p];
      const thirdParty = /\/node_modules(\/|$)/.test(p);
      for (const f of list) {
        files++;
        const base = path.basename(f);
        // third-party code names files after what it handles (privateKey.d.mts, eckey.h): there, only files that CARRY secrets count
        const carrier = /\.(json|pem|key|env|p12|pfx|keystore|jks)$|^\.env/i.test(base);
        if (SECRET_NAME.test(base) && (thirdParty ? carrier && !/(^|\/)(test|tests|__tests__|fixtures|examples?)\//.test(f) : !/\.(js|md|txt)$/.test(base)) && !/community-agents\.json$|our-agent-wallets\.json$|treasury-wallets\.json$|arc-extra-wallets\.json$/.test(base)) fail('allowlist exposes a secret-named file: ' + f);
        if (thirdParty) { nmScanned++; if (/\.(js|mjs|cjs|ts|mts|cts|map|d\.ts|node|wasm|md|markdown|LICENSE|h|c|cc|cpp|dylib|dll|a|o)$|\.so(\.\d+)*$/i.test(base) || /(^|\/)(test|tests|__tests__|fixtures|examples?)\//.test(f)) continue; }
        if (/\.(db|db-wal|db-shm|png|jpg|webp)$/.test(base)) continue;
        const sz = fs.statSync(f).size;
        if (sz > 50 * 1024 * 1024) { notes.push('not content-scanned (over 50 MB): ' + f); continue; }
        const txt = fs.readFileSync(f, 'utf8');
        for (const re of KEY_SHAPE) if (re.test(txt)) { fail('allowlist exposes key-shaped content: ' + f); break; }
      }
    }
  }
  // 5
  if (!opts.skipOwner) for (const d of [appRoot + '/data/protected/account', appRoot + '/data/protected/policy']) {
    try { const st = fs.statSync(d); const u = require('child_process').execSync('id -u apex-account').toString().trim();
      if (String(st.uid) !== u || (st.mode & 0o777) !== 0o700) fail(d + ': must be owned by apex-account with mode 700 (uid ' + st.uid + ', mode ' + (st.mode & 0o777).toString(8) + ')');
    } catch (e) { fail(d + ': ' + e.message); }
  }
  // 5b. root runs only root-owned files: the installed wrapper, cycle, sweep and lists (Fable review 2 #5)
  if (!opts.skipOwner) {
    try {
      const d = fs.statSync(INSTALLED); if (d.uid !== 0 || (d.mode & 0o022)) fail(INSTALLED + ' must be root-owned and not group/world-writable');
      for (const f of TRUSTED) {
        const st = fs.lstatSync(INSTALLED + '/' + f);
        if (st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022)) fail(INSTALLED + '/' + f + ': must be a root-owned regular file, not group/world-writable');
        const src = appRoot + '/' + SOURCES[f];
        if (fs.existsSync(src) && fs.readFileSync(src, 'utf8') !== fs.readFileSync(INSTALLED + '/' + f, 'utf8')) notes.push(SOURCES[f] + ' differs from the installed copy (run sudo tools/account-install.sh)');
      }
      const eu = fs.readFileSync('/etc/systemd/system/apex-account-egress.service', 'utf8');
      for (const need of ['ExecStart=/usr/bin/node /usr/local/sbin/apex-account/egress-proxy.js', 'DynamicUser=yes', 'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'ProtectHome=yes',
        'Group=apex-account', 'RuntimeDirectoryMode=0750', 'IPAddressDeny=localhost', 'SystemCallFilter=@system-service'])
        if (!eu.includes(need)) fail('apex-account-egress.service: missing ' + need);
      const egress = fs.readFileSync(INSTALLED + '/egress-allow.txt', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).sort();
      const rpcSrc = fs.readFileSync(appRoot + '/lib/account/rpc.js', 'utf8');
      const rpcHosts = [...new Set((rpcSrc.match(/https:\/\/[a-z0-9.-]+/gi) || []).map((u) => u.slice(8).toLowerCase()))].sort();
      const proxySrc = fs.readFileSync(INSTALLED + '/egress-proxy.js', 'utf8');
      for (const need of ['server.timeout', 'headersTimeout', 's.preConnect = setTimeout(', 'clearTimeout(client.preConnect)', '0o660', "order: 'ipv4first'", 'net.BlockList', 'lookupCached(host)', 'LOOKUP_MS'])
        if (!proxySrc.includes(need)) fail('egress-proxy.js: missing ' + need + ' (review 3 H1/M3/L2; 09-29 load test: absolute pre-CONNECT deadline, DNS cache)');
      const extra = egress.filter((h) => !rpcHosts.includes(h)), missing = rpcHosts.filter((h) => !egress.includes(h));
      if (extra.length) fail('egress-allow.txt allows hosts rpc.js does not use: ' + extra.join(', '));
      if (missing.length) notes.push('rpc.js names hosts the egress proxy refuses (calls to them fail closed): ' + missing.join(', '));
      const unit = fs.readFileSync('/etc/systemd/system/apex-account-cycle.service', 'utf8');
      if (!/Requires=apex-account-egress\.service/.test(unit)) fail('apex-account-cycle.service must Require apex-account-egress.service');
      if (!/ExecStopPost=\/usr\/local\/sbin\/apex-account\/account-cycle-post\.sh/.test(unit)) fail('apex-account-cycle.service needs the ExecStopPost handler (review 3 H2)');
      if (!/MemoryMax=/.test(unit) || !/TasksMax=/.test(unit)) fail('apex-account-cycle.service needs MemoryMax and TasksMax (review 3 M5)');
      // review 3 M4: the host's /dev/null was claudeuser 660, which broke every tool that opens it inside the sandbox
      const dn = fs.statSync('/dev/null'); if (dn.uid !== 0 || (dn.mode & 0o777) !== 0o666) fail('/dev/null must be root 666 (it is uid ' + dn.uid + ' mode ' + (dn.mode & 0o777).toString(8) + ')');
      if (!/ExecStart=\/usr\/local\/sbin\/apex-account\/account-cycle\.sh/.test(unit)) fail('apex-account-cycle.service must run ' + INSTALLED + '/account-cycle.sh');
      if (!/PrivateTmp=yes/.test(unit)) fail('apex-account-cycle.service needs PrivateTmp=yes');
    } catch (e) { fail('installed files: ' + e.message); }
  }
  // 6. coverage: every key-file NAME in our wallet-key places has a registry entry (names only; no key is opened)
  if (!opts.skipOwner) {
    const reg = JSON.parse(fs.readFileSync(appRoot + '/data/protected/account/wallet-registry.json', 'utf8'));
    let extra = {}; try { extra = JSON.parse(fs.readFileSync(appRoot + '/data/protected/account/registry-extra.json', 'utf8')).covered || {}; } catch (e) {}
    const have = new Set(reg.entries.map((e) => e.key_file_name).filter(Boolean));
    const names = [];
    const list = (dir, rel) => { if (!fs.existsSync(dir)) return; for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const r = rel + f.name; if (f.isDirectory()) list(path.join(dir, f.name), r + '/'); else if (/\.json$/.test(f.name)) names.push(r); else names.push(r); } };
    // PUBLISHED COPY: key directories and loose key files come from the same unpublished file as the sandbox probes
    // (accounting/secret-paths.example.json shows the shape); an empty config fails rather than passing on nothing.
    let conf = null; try { conf = JSON.parse(fs.readFileSync(process.env.ACCOUNT_SECRET_PATHS || '/usr/local/sbin/apex-account/secret-paths.json', 'utf8')); } catch (e) {}
    if (!conf || !Array.isArray(conf.keyDirs) || !conf.keyDirs.length) fail('secret-paths config missing: key coverage cannot be checked');
    else { for (const [abs, rel] of conf.keyDirs) list(abs.replace(/^\$APP/, appRoot), rel); for (const f of conf.keyFiles || []) if (fs.existsSync(appRoot + '/' + f)) names.push(f); }
    const missing = names.filter((n) => !have.has(n) && !Object.keys(extra).some((k) => n === k || n.startsWith(k.replace(/\/?$/, '/'))));
    if (missing.length) fail('key files with no registry entry (names only): ' + missing.join(', '));
    else notes.push('key coverage: ' + names.length + ' key-file names, every one registered or explained');
  }
  notes.push('node_modules: ' + nmScanned + ' third-party files name-checked, non-code ones content-checked');
  return { fails, notes, files };
}

function selftest() {
  // Plant one fault of each kind in a throwaway copy and require the sweep to catch each one.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-sweep-'));
  const cases = [];
  const mk = () => {
    const root = fs.mkdtempSync(path.join(tmp, 'app-'));
    for (const d of ['lib/account', 'lib/policy', 'tools', 'data']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib/account/ok.js'), "// sendTransaction is named in a comment only\nmodule.exports = 1;\n");
    fs.writeFileSync(path.join(root, 'tools/account-x.js'), "(async () => {\n  await require('x').assertSandboxed();\n  console.log(1);\n})();\n");
    fs.copyFileSync(APP + '/tools/account-run.src.sh', path.join(root, 'tools/account-run.sh'));
    fs.writeFileSync(path.join(root, 'data/plain.json'), '{"a":1}');
    fs.writeFileSync(path.join(root, 'lib/account/sandbox-allow.txt'), root + '/data/plain.json\n');
    return root;
  };
  const run = (root) => sweep({ appRoot: root, skipOwner: true, wrapper: root + '/tools/account-run.sh', allow: root + '/lib/account/sandbox-allow.txt' });
  const clean = run(mk());
  cases.push(['a clean copy passes', clean.fails.length === 0, clean.fails.join('; ')]);
  let r = mk(); fs.writeFileSync(path.join(r, 'lib/account/bad.js'), "const k = Keypair.fromSecretKey(x);\n");
  cases.push(['catches a planted fromSecretKey', run(r).fails.some((f) => /uses fromSecretKey/.test(f))]);
  r = mk(); fs.writeFileSync(path.join(r, 'lib/policy/bad.js'), "rpc.call('x1', 'sendTransaction', [tx]);\n");
  cases.push(['catches a planted sendTransaction call', run(r).fails.some((f) => /a send method/.test(f))]);
  r = mk(); fs.writeFileSync(path.join(r, 'lib/policy/scan.js'), "const BAN = [/sendTransaction|privateKey/i, /\\/keys\\b/];\nmodule.exports = BAN;\n");
  cases.push(['does NOT fail on a regex literal that names a danger', run(r).fails.length === 0, run(r).fails.join('; ')]);
  r = mk(); fs.writeFileSync(path.join(r, 'lib/account/k.js'), "const k = require('fs').readFileSync('/root/apex-faucet/keys/arc-trader.json');\n");
  cases.push(['catches a planted key-file path', run(r).fails.some((f) => /a key path/.test(f))]);
  r = mk(); fs.writeFileSync(path.join(r, 'lib/account/j.js'), "const p = path.join(ROOT, 'wallet', 'faucet-keypair.json');\n");
  cases.push(['catches a path.join into a wallet directory', run(r).fails.some((f) => /path\.join/.test(f))]);
  r = mk(); fs.writeFileSync(path.join(r, 'lib/account/l.js'), "fetch('http://127.0.0.1:3000/api/x');\n");
  cases.push(['catches a planted localhost call', run(r).fails.some((f) => /localhost/.test(f))]);
  r = mk(); fs.writeFileSync(path.join(r, 'tools/account-y.js'), "(async () => {\n  console.log('no guard');\n})();\n");
  cases.push(['catches a tool without assertSandboxed first', run(r).fails.some((f) => /do not start with await assertSandboxed/.test(f))]);
  r = mk(); fs.writeFileSync(path.join(r, 'tools/account-z.js'), "(async () => {\n  await require('x').assertSandboxed();\n})();\n(async () => {\n  console.log('second main');\n})();\n");
  cases.push(['catches a second main function without the guard', run(r).fails.some((f) => /1 of 2 main/.test(f))]);
  r = mk(); fs.symlinkSync(path.join(r, 'data/plain.json'), path.join(r, 'data/link.json')); fs.appendFileSync(path.join(r, 'lib/account/sandbox-allow.txt'), r + '/data/link.json\n');
  cases.push(['catches a symlink in the allowlist', run(r).fails.some((f) => /symlink/.test(f))]);
  r = mk(); fs.writeFileSync(path.join(r, 'tools/account-run.sh'), fs.readFileSync(path.join(r, 'tools/account-run.sh'), 'utf8').split('PrivateNetwork=yes').join('PrivateNetwork=no'));
  cases.push(['catches a wrapper that gives the sandbox the host network again', run(r).fails.some((f) => /PrivateNetwork=yes/.test(f))]);
  r = mk(); fs.appendFileSync(path.join(r, 'lib/account/sandbox-allow.txt'), '/root/apex-faucet/faucet.db\n');
  cases.push(['catches a live database back in the allowlist', run(r).fails.some((f) => /live database/.test(f))]);
  r = mk(); fs.writeFileSync(path.join(r, 'tools/account-run.sh'), fs.readFileSync(path.join(r, 'tools/account-run.sh'), 'utf8').split('ProtectProc=invisible').join('ProtectProc=default'));
  cases.push(['catches a wrapper without ProtectProc=invisible', run(r).fails.some((f) => /ProtectProc=invisible/.test(f))]);
  r = mk(); fs.writeFileSync(path.join(r, 'data/plain.json'), JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 7) % 256)));
  cases.push(['catches a key-shaped array in an allowlisted file', run(r).fails.some((f) => /key-shaped/.test(f))]);
  r = mk(); fs.writeFileSync(path.join(r, 'data/.anthropic-key'), 'x'); fs.appendFileSync(path.join(r, 'lib/account/sandbox-allow.txt'), r + '/data/.anthropic-key\n');
  cases.push(['catches a secret-named file in the allowlist', run(r).fails.some((f) => /secret-named/.test(f))]);
  fs.rmSync(tmp, { recursive: true, force: true });
  let bad = 0;
  for (const [n, ok, d] of cases) { if (!ok) bad++; console.log((ok ? '  ok    ' : '  FAIL  ') + n + (d ? '  (' + d + ')' : '')); }
  console.log(bad ? 'SELFTEST FAILED: ' + bad : 'SELFTEST OK: every planted fault was caught');
  return bad;
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);
const r = sweep({});
for (const n of r.notes) console.log('  note  ' + n);
for (const f of r.fails) console.log('  FAIL  ' + f);
console.log(r.fails.length ? 'ACCOUNT SAFETY SWEEP FAILED: ' + r.fails.length : 'ACCOUNT SAFETY SWEEP OK (' + r.files + ' allowlisted files scanned, ' + codeFiles(APP).length + ' code files)');
process.exit(r.fails.length ? 1 : 0);
