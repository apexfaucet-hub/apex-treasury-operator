#!/usr/bin/env node
'use strict';
// MCP, CONNECTED THE WAY AGENTS CONNECT (2026-10-08). tools/sweep-mcp-tools.js speaks JSON-RPC to us by hand; agents use the
// official SDK (@modelcontextprotocol/sdk, pinned 1.30.1 in vendor/mcp-official) over Streamable HTTP. Same lesson as the payment
// rails that day: our own client passing proves nothing about theirs. This connects with the official client to each of our three
// MCP servers, lists the tools and calls one free tool, and exits 1 if any step fails. --plant connects to a path that is not an
// MCP server, so it must FAIL.
const base = '/root/apex-faucet/vendor/mcp-official/node_modules/@modelcontextprotocol/sdk/dist/cjs/';
const { Client } = require(base + 'client/index.js');
const { StreamableHTTPClientTransport } = require(base + 'client/streamableHttp.js');
const plant = process.argv.includes('--plant');
const SERVERS = plant ? [['/api/not-an-mcp-server', 'xnt_price']] : [['/api/mcp', 'arc_faucet_status'], ['/api/mcp/arc', 'arc_faucet_status'], ['/api/mcp/web', null]];
(async () => {
  let bad = 0;
  for (const [p, freeTool] of SERVERS) {
    const client = new Client({ name: 'apex-check-mcp-official-client', version: '1.0.0' });
    const t0 = Date.now();
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('https://apexfaucet.xyz' + p)));
      const sv = client.getServerVersion() || {};
      const tools = (await client.listTools()).tools || [];
      let called = 'no free tool asked';
      if (freeTool) {
        const r = await client.callTool({ name: freeTool, arguments: {} });
        const text = ((r.content || []).find((c) => c.type === 'text') || {}).text || '';
        if (r.isError || !text) throw new Error(freeTool + ' answered ' + (r.isError ? 'an error' : 'nothing') + ': ' + text.slice(0, 100));
        called = freeTool + ' answered (' + text.length + ' chars)';
      }
      console.log('OK    ' + p + ': official MCP SDK 1.30.1 connected to ' + (sv.name || '?') + ', ' + tools.length + ' tools listed, ' + called + ' (' + (Date.now() - t0) + ' ms)');
    } catch (e) { bad++; console.log('FAIL  ' + p + ': official MCP SDK 1.30.1 could not use it: ' + String(e.message || e).slice(0, 200)); }
    try { await client.close(); } catch (e) {}
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.log('FAIL  check crashed: ' + e.message); process.exit(1); });
