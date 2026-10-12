// Page test: web/index.html + web/mandate.js in headless Chrome with a stand-in wallet, against an anvil fork of Arc.
// The stand-in wallet forwards to anvil, whose dev account is unlocked: no real key is involved anywhere.
// Run: sudo env NODE_PATH=/root/apex-faucet/node_modules node test/web/e2e-fork.cjs
const http = require('http'); const fs = require('fs'); const path = require('path'); const { spawn, execFileSync } = require('child_process');
const puppeteer = require('puppeteer');
const ROOT = path.join(__dirname, '..', '..');
const ANVIL = process.env.ANVIL_BIN || '/home/claudeuser/.foundry/bin/anvil';
const FORGE_OUT = path.join(ROOT, 'out', 'MandateFactory.sol', 'MandateFactory.json');
const A_PORT = 8550, W_PORT = 8551, A_URL = 'http://127.0.0.1:' + A_PORT;
let fails = 0; const ok = (c, l) => { console.log((c ? 'ok   ' : 'FAIL ') + l); if (!c) fails++; };
const rpc = (m, p) => fetch(A_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(JSON.stringify(j.error)); return j.result; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const anvil = spawn(ANVIL, ['--fork-url', 'https://rpc.blockdaemon.mainnet.arc.io', '--port', String(A_PORT), '--silent'], { stdio: 'ignore' });
  let server, browser;
  try {
    let up = false; for (let i = 0; i < 120 && !up; i++) { try { await rpc('eth_chainId', []); up = true; } catch { await sleep(500); } }
    if (!up) throw new Error('anvil did not start');
    const [dev] = await rpc('eth_accounts', []);
    const F = JSON.parse(fs.readFileSync(FORGE_OUT, 'utf8'));
    const ctor = '0'.repeat(24) + '3600000000000000000000000000000000000000';
    const h = await rpc('eth_sendTransaction', [{ from: dev, data: F.bytecode.object + ctor, gas: '0x1c9c380' }]);
    let rc = null; for (let i = 0; i < 40 && !rc; i++) { rc = await rpc('eth_getTransactionReceipt', [h]); if (!rc) await sleep(250); }
    const factory = rc.contractAddress; const block = Number(rc.blockNumber);
    ok(!!factory, 'factory deployed on fork at ' + factory);
    const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8')
      .replace(/window\.MANDATE=\{[^}]*\};/, 'window.MANDATE={factory:"' + factory + '",deployBlock:' + block + ',rpcs:["' + A_URL + '"]};');
    // the live page carries the mainnet factory; the test must never run against it (it did once, silently, 8 Oct)
    if (!html.includes(factory) || !html.includes(A_URL)) throw new Error('test page is not pointed at the fork');
    const js = fs.readFileSync(path.join(ROOT, 'web', 'mandate.js'), 'utf8');
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/arc/mandate/mandate.js')) { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(js); }
      if (req.url === '/' || req.url.startsWith('/arc/mandate/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
      res.writeHead(404); res.end();
    }).listen(W_PORT);
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', async (d) => { await d.accept(d.message().startsWith('How much') ? '1' : '0x00000000000000000000000000000000000Be5Ad'.toLowerCase()); });
    await page.setViewport({ width: 400, height: 860 });
    await page.evaluateOnNewDocument((url, dev) => {
      window.ethereum = { isMetaMask: true, request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [dev];
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json(); if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; } return j.result; } };
    }, A_URL, dev);
    await page.goto('http://127.0.0.1:' + W_PORT + '/arc/mandate/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mform');
    const firstScreen = await page.$eval('#mgo', (b) => b.getBoundingClientRect().bottom);
    ok(firstScreen < 860, 'main action on the first phone screen (bottom ' + Math.round(firstScreen) + ' px)');
    await page.type('#fagent', '0x00000000000000000000000000000000000a6e17');
    await page.type('#fpayees', '0x00000000000000000000000000000000005a1e51');
    await page.$eval('#fput', (i) => { i.value = '2'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    const sum = await page.$eval('#msum', (e) => e.textContent);
    ok(/at most 0\.10 USDC at a time and 20 times a day \(at most 2\.00 USDC a day\)/.test(sum), 'summary: ' + sum.slice(0, 120));
    await page.click('#mform button[type=submit]');
    await page.waitForFunction(() => /Your box is live|Refused|Could not|failed|Not enough|must|Pick|Add at least/.test(document.getElementById('mmsg').textContent), { timeout: 60000 }).catch(async (e) => { console.log('mmsg at timeout: ' + await page.$eval('#mmsg', (x) => x.textContent)); throw e; });
    const msg = await page.$eval('#mmsg', (e) => e.textContent);
    ok(/Your box is live/.test(msg), 'create: ' + msg.slice(0, 140));
    await page.waitForFunction(() => /USDC in the box/.test(document.getElementById('mboxes').textContent), { timeout: 30000 });
    let card = await page.$eval('#mboxes', (e) => e.textContent);
    ok(/ACTIVE/.test(card) && /2\.00\s*USDC in the box/.test(card) && /20 of 20/.test(card), 'card after create: ' + card.replace(/\s+/g, ' ').slice(0, 160));
    await page.click('button[data-act="pause"]');
    await page.waitForFunction(() => /STOPPED/.test(document.getElementById('mboxes').textContent), { timeout: 60000 });
    ok(true, 'stop button: card shows STOPPED');
    const boxAddr = await page.$eval('#mboxes .mst a', (a) => a.href.split('/').pop());
    await page.waitForSelector('button[data-act="payee"]');
    await page.click('button[data-act="payee"]');
    await page.waitForFunction(() => /Sent/.test((document.querySelector('.mmsg2') || {}).textContent || '') || !document.querySelector('.mmsg2'), { timeout: 60000 });
    await page.waitForSelector('button[data-act="add"]', { timeout: 60000 });
    const isPayee = await rpc('eth_call', [{ to: boxAddr, data: '0x366653a9' + '00000000000000000000000000000000000000000000000000000000000be5ad'.padStart(64, '0') }, 'latest']);
    ok(BigInt(isPayee) === 1n, 'add a payee: isPayee(0x…be5ad) is true on chain');
    await page.click('button[data-act="add"]');
    await page.waitForFunction(() => /3\.00\s*USDC in the box/.test(document.getElementById('mboxes').textContent), { timeout: 60000 });
    ok(true, 'put money in: card shows 3 USDC');
    // "Show my boxes" finds it through the factory logs, fresh page, empty localStorage.
    const p2 = await browser.newPage(); p2.on('pageerror', (e) => errors.push(String(e)));
    await p2.evaluateOnNewDocument((url, dev) => { localStorage.clear(); window.ethereum = { request: async ({ method, params }) => { if (method === 'eth_requestAccounts') return [dev]; if (method.startsWith('wallet_')) return null; const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); return (await r.json()).result; } }; }, A_URL, dev);
    await p2.goto('http://127.0.0.1:' + W_PORT + '/arc/mandate/', { waitUntil: 'domcontentloaded' });
    await p2.click('#mmine');
    await p2.waitForFunction(() => /USDC in the box/.test(document.getElementById('mboxes').textContent), { timeout: 60000 });
    card = await p2.$eval('#mboxes', (e) => e.textContent.replace(/\s+/g, ' '));
    ok(/STOPPED/.test(card) && /3\.00\s*USDC in the box/.test(card), 'show my boxes found it from logs: ' + card.slice(0, 120));
    const payeeOk = await rpc('eth_call', [{ to: boxAddr.replace('…', '') }, 'latest']).catch(() => null); void payeeOk;
    ok(errors.length === 0, 'no page errors ' + errors.join(' | ').slice(0, 200));
  } catch (e) { console.log('FAIL exception', e.message); fails++; }
  finally { try { await browser?.close(); } catch {} try { server?.close(); } catch {} anvil.kill(); }
  console.log(fails ? fails + ' FAILED' : 'page e2e on fork: all ok');
  process.exit(fails ? 1 : 0);
})();
