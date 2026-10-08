#!/usr/bin/env node
'use strict';
// A2A, SPOKEN THE WAY OTHER AGENTS SPEAK IT (2026-10-08). The current official SDK (@a2a-js/sdk 1.2.0, vendor/a2a-official) could not
// talk to Flux at all: our card had no supportedInterfaces (v1.0) and /api/a2a refused the v1.0 method SendMessage. This finds us from
// our agent card exactly as an SDK user does (createFromUrl), sends one message and checks a text answer comes back. A tool to run by
// hand when the A2A front door changes (CLAUDE.md §6: nothing is scheduled). Exit 1 when the official client cannot get an answer.
const base = '/root/apex-faucet/vendor/a2a-official/node_modules/@a2a-js/sdk/';
const crypto = require('crypto');
const m = require(base + 'dist/client/index.cjs');
const question = process.argv.slice(2).join(' ') || 'Hello, what can you do?';
(async () => {
  const t0 = Date.now();
  try {
    const client = await new m.ClientFactory().createFromUrl('https://apexfaucet.xyz');
    const r = await client.sendMessage({ message: { messageId: crypto.randomUUID(), contextId: '', taskId: '', role: 1 /* ROLE_USER */,
      parts: [{ content: { $case: 'text', value: question } }], extensions: [], referenceTaskIds: [] } });
    const msg = r && (r.payload ? r.payload.value : r);
    const text = ((msg && msg.parts) || []).map((p) => (p.content && p.content.$case === 'text' ? p.content.value : '')).join('\n');
    if (!text) throw new Error('no text in the answer: ' + JSON.stringify(r).slice(0, 200));
    console.log('OK    official A2A SDK 1.2.0 found Flux from the agent card and got an answer (' + text.length + ' chars, ' + (Date.now() - t0) + ' ms):\n' + text.slice(0, 400));
    process.exit(0);
  } catch (e) { console.log('FAIL  official A2A SDK 1.2.0: ' + String(e.message || e).slice(0, 300)); process.exit(1); }
})();
