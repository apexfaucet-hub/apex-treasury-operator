'use strict';
// tests/ledger-log-evm.test.js (2026-10-06): replays three real Arc transactions through the EVM recorder into a SCRATCH
// ledger directory (LEDGER_DIR), plus planted faults. Never writes to data/ledger. Needs network (Arc RPC reads only).
const fs = require('fs'), os = require('os'), path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-evm-test-'));
process.env.LEDGER_DIR = DIR;
const E = require('/root/apex-faucet/lib/ledger-log-evm.js');
const RECV = '0xd334ab5151c624cada654854e2879903dc4217ed', OPER = '0x024b82335c29fa5606a8ea5c1d24fc9ead50700c';
const T = { topup1: '0x3d8f55a337408e23f96dfa01699208f95c5c7eac77b35a5e520df5996a6da9e3', topup2: '0x7669c96f5d0cbc976b48a38ee10fcc0078413a93d46ffff22db291fa634296fb', refund: '0xc483a8af801d1d63cbbe6ed5f83b7f535bceb53773e64f62c60ae995009f8c72', erc20: '0x308f4e9e65708b1ada1405c02b5fa6134b98e930895d9a245125776ee26344f9' };
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const rows = (src) => { try { return fs.readFileSync(path.join(DIR, src + '.ndjson'), 'utf8').split('\n').filter(Boolean).map(JSON.parse); } catch (e) { return []; } };
const errs = (src) => rows('_errors-' + src);
(async () => {
  // pure checks first
  const tx = { from: RECV, to: '0x1', value: 0n };
  const nft = E.evmOutflows('arc', tx, { logs: [{ address: '0x' + '12'.repeat(20), topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(24) + RECV.slice(2), '0x' + '0'.repeat(64), '0x' + '0'.repeat(63) + '1'], data: '0x' }] }, [RECV]);
  ok(nft.problems.length === 1 && /ERC-721/.test(nft.problems[0]), 'an ERC-721 transfer out of our wallet is a problem');
  const mirror = E.evmOutflows('arc', tx, { logs: [
    { address: E.NATIVE_LOG, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(24) + RECV.slice(2), '0x' + '0'.repeat(24) + OPER.slice(2)], data: '0x' + (10n ** 18n).toString(16) },
    { address: E.ARC_USDC_ERC20, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(24) + RECV.slice(2), '0x' + '0'.repeat(24) + OPER.slice(2)], data: '0x' + (10n ** 6n).toString(16) }] }, [RECV]);
  ok(mirror.flows.length === 1 && mirror.flows[0].asset === 'arc:native', 'USDC counted once (the 0x3600 mirror ignored)');
  ok(E.checkExpect('arc', mirror.flows, { usdc: 1 }).length === 0, 'within bound passes');
  ok(/exceeds/.test(E.checkExpect('arc', mirror.flows, { usdc: 0.5 })[0] || ''), 'over bound refused');
  ok(/undeclared/.test(E.checkExpect('arc', mirror.flows, {})[0] || ''), 'undeclared asset refused');
  ok(/no expect/.test(E.checkExpect('arc', mirror.flows, null)[0] || ''), 'no expect refused');
  // real replays
  let f = await E.recordSentEvm(T.topup1, { source: 't-topup', chain: 'arc', wallets: [RECV], expect: { usdc: 1.0 }, category: 'internal:gas-topup' });
  ok(Array.isArray(f) && f.length === 1 && rows('t-topup').length === 1 && rows('t-topup')[0].amount === 1 && rows('t-topup')[0].counterparty === OPER, 'replay 0x3d8f: 1.0 USDC receive -> operator recorded');
  f = await E.recordSentEvm(T.topup2, { source: 't-topup2', chain: 'arc', wallets: [RECV], expect: { usdc: 1.0 } });
  ok(rows('t-topup2').length === 1 && rows('t-topup2')[0].amount === 1, 'replay 0x7669: 1.0 USDC recorded');
  f = await E.recordSentEvm(T.refund, { source: 't-refund', chain: 'arc', wallets: [RECV], expect: { usdc: 0.003 }, category: 'refund' });
  ok(rows('t-refund').length === 1 && Math.abs(rows('t-refund')[0].amount - 0.003) < 1e-12, 'replay 0xc483: 0.003 USDC refund (sent from the receive wallet) recorded');
  f = await E.recordSentEvm(T.erc20, { source: 't-erc20', chain: 'arc', wallets: [OPER], expect: { usdc: 0.15 } });
  ok(rows('t-erc20').length === 1 && Math.abs(rows('t-erc20')[0].amount - 0.15) < 1e-12, 'replay 0x308f (ERC-20 face): 0.15 USDC counted once');
  // planted faults on real txs
  await E.recordSentEvm(T.topup1, { source: 't-over', chain: 'arc', wallets: [RECV], expect: { usdc: 0.5 } });
  ok(rows('t-over').length === 0 && /exceeds/.test((errs('t-over')[0] || {}).error || ''), 'planted: 1.0 left but expected 0.5 -> nothing recorded, error written');
  await E.recordSentEvm(T.topup1, { source: 't-undecl', chain: 'arc', wallets: [RECV], expect: { native: 5 } });
  ok(rows('t-undecl').length === 0 && /undeclared/.test((errs('t-undecl')[0] || {}).error || ''), 'planted: USDC not declared -> nothing recorded');
  f = await E.recordSentEvm(T.topup1, { source: 't-notours', chain: 'arc', wallets: [OPER], expect: { usdc: 0 } });
  ok(Array.isArray(f) && f.length === 0 && rows('t-notours').length === 0, 'the receiving side records nothing (no outflow from it)');
  await E.recordSentEvm('0x' + 'ab'.repeat(32), { source: 't-missing', chain: 'arc', wallets: [RECV], expect: { usdc: 1 }, rpc: 'https://rpc.blockdaemon.mainnet.arc.io' }).catch(() => {});
  console.log('(the missing-tx case waits 90 s by design; skipped from the pass count if it took the wait)');
  ok(rows('t-missing').length === 0, 'a hash that never landed records nothing');
  ok(!fs.existsSync('/root/apex-faucet/data/ledger/t-topup.ndjson'), 'the live ledger directory was not touched');
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
