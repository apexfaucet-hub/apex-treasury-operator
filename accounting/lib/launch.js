'use strict';
// ACCOUNT LAYER launcher (2026-09-29, review A1). The sandbox has its own, EMPTY network namespace (PrivateNetwork=yes):
// no route to the internet, the host, or any local service. Its only way out is the egress proxy's unix socket, mounted
// into its empty /run. fetch() speaks to an HTTP proxy over TCP, so this launcher opens a loopback listener INSIDE the
// private namespace (reachable by nothing else) that forwards bytes to that socket, and runs the requested tool as a
// CHILD process with HTTPS_PROXY pointing at it.
//
// Why a child and not require() (09-29, v1 of this file): with the bridge in the tool's own process, any tool that waits
// synchronously (spawnSync, as the exit tests do) froze its own way out; every read of its children hung until timeout.
// Here the launcher does nothing but forward bytes, so no tool can ever block the bridge. Children of the tool inherit
// HTTPS_PROXY and use the same bridge.
// Usage (the wrapper does this): node launch.js /root/apex-faucet/tools/<tool>.js [args]
const net = require('net');
const { spawn } = require('child_process');

const SOCK = '/run/apex-account-egress/proxy.sock';
const target = process.argv[2];
if (!target || !/^\/root\/apex-faucet\/(tools|lib\/account|lib\/policy|data\/protected\/account)\/[\w.\/-]+\.js$/.test(target)) {
  console.error('launch.js: refusing target ' + target);
  process.exit(1);
}
const srv = net.createServer((c) => {
  const u = net.connect(SOCK);
  c.pipe(u); u.pipe(c);
  c.on('error', () => u.destroy()); u.on('error', () => c.destroy());
});
srv.on('error', (e) => { console.error('launch.js: bridge failed: ' + e.message); process.exit(1); });
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  const child = spawn(process.execPath, process.execArgv.concat([target], process.argv.slice(3)), {
    stdio: 'inherit', env: Object.assign({}, process.env, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:' + port, HTTP_PROXY: '' }),
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('error', (e) => { console.error('launch.js: could not start the tool: ' + e.message); process.exit(1); });
  child.on('exit', (code, sig) => process.exit(code != null ? code : (sig ? 1 : 0)));
});
