'use strict';
// tests/bsc-facilitator.test.js (2026-10-06): planted payments against the BNB verifier. Signs with a throwaway key made in
// memory (never stored, holds nothing); settles NOTHING. Needs network (BNB reads only).
const v = require('/root/apex-faucet/node_modules/viem');
const { privateKeyToAccount, generatePrivateKey } = require('/root/apex-faucet/node_modules/viem/accounts');
const B = require('/root/apex-faucet/bsc-facilitator.js');
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
(async () => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const to = B.receiveAddress(); const t = B.TOKENS.USD1;
  const now = Math.floor(Date.now() / 1000);
  const make = async (over = {}, domain = t.domain) => {
    const a = Object.assign({ from: acct.address, to, value: B.units(0.003).toString(), validAfter: String(now - 60), validBefore: String(now + 300), nonce: v.keccak256(v.toHex(String(Math.random()))) }, over);
    const sig = await acct.signTypedData({ domain, types: B.TYPES, primaryType: 'TransferWithAuthorization', message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce } });
    return { signature: sig, authorization: a };
  };
  let r = await B.verify(await make(), 0.003, t.address);
  ok(!r.valid && /holds less/.test(r.reason), 'a correct signature from an empty wallet: refused before any gas (' + r.reason + ')');
  r = await B.verify(await make({}, Object.assign({}, t.domain, { version: '2' })), 0.003, t.address);
  ok(!r.valid && /does not match/.test(r.reason), 'signed with version "2" (the version() trap): refused');
  r = await B.verify(await make({ value: B.units(0.003) / 2n + '' }), 0.003, t.address);
  ok(!r.valid && /underpaid/.test(r.reason), 'half the price: refused as underpaid');
  r = await B.verify(await make({ to: '0x' + '42'.repeat(20) }), 0.003, t.address);
  ok(!r.valid && /not our address/.test(r.reason), 'paying someone else: refused');
  r = await B.verify(await make({ validBefore: String(now - 1) }), 0.003, t.address);
  ok(!r.valid && /expired/.test(r.reason), 'expired authorization: refused');
  r = await B.verify(await make(), 0.003, '0x55d398326f99059fF775485246999027B3197955');
  ok(!r.valid && /not one we accept/.test(r.reason), 'USDT (no EIP-3009): refused');
  r = await B.verify(await make({}, B.TOKENS.U.domain), 0.003, t.address);
  ok(!r.valid && /does not match/.test(r.reason), 'a U signature presented as USD1: refused');
  ok(B.units(0.003) === 10n ** 16n && B.units(0.05) === 5n * 10n ** 16n, 'prices under $0.01 are raised to $0.01; $0.05 stays $0.05');
  const opts = await B.options(0.009);
  ok(opts.length === 2 && opts.every((o) => o.network === 'eip155:56' && o.extra.version === '1' && o.payTo === to), 'the 402 offers USD1 and U on eip155:56 with signing version "1"');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL crashed: ' + e.message); process.exit(1); });
