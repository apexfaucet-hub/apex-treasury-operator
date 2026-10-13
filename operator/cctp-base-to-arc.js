// CCTP V2 Base(6) -> Arc(26), for the operator's own gas on Arc (2026-10-13). The mirror of tools/cctp-arc-to-base.js.
//   sudo node tools/cctp-base-to-arc.js <usdAmount>        burns on Base from the operator, mints to the SAME operator on Arc
// Wallet and recipient are read from the wallet registry, never typed. Asks the send gate (sender base-hand-cctp-to-arc: own
// wallet, own Arc address only, 1 USDC a day) before it signs; the burn is recorded with lib/ledger-log-evm.js. Standard transfer
// (minFinalityThreshold 2000, maxFee 0): Circle attests after Base finality, about 15-20 minutes. The Arc leg (receiveMessage)
// moves no value of ours, only gas from the same operator.
const v = require('/root/apex-faucet/node_modules/viem'), { privateKeyToAccount } = require('/root/apex-faucet/node_modules/viem/accounts'), fs = require('fs');
const { base } = require('/root/apex-faucet/node_modules/viem/chains');
const H = require('/root/apex-faucet/lib/hand-gate.js');
const TM = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d', MT = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const REG = JSON.parse(fs.readFileSync('/root/apex-faucet/data/protected/account/wallet-registry.json', 'utf8')).entries;
const FROM = REG.find((e) => e.id === 'base:0x024b8233'), TO = REG.find((e) => e.id === 'arc:0x024b8233');
const arcC = v.defineChain({ id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } });
const abi = v.parseAbi(['function approve(address,uint256) returns (bool)', 'function depositForBurn(uint256 amount,uint32 destinationDomain,bytes32 mintRecipient,address burnToken,bytes32 destinationCaller,uint256 maxFee,uint32 minFinalityThreshold)', 'function receiveMessage(bytes message,bytes attestation) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);
(async () => {
  const amt = process.argv[2]; const a = BigInt(Math.round(Number(amt) * 1e6));
  if (!(Number(amt) > 0)) throw new Error('usage: cctp-base-to-arc.js <usdAmount>');
  const acc = privateKeyToAccount(JSON.parse(fs.readFileSync('/root/apex-faucet/' + FROM.key_file_name, 'utf8')).privateKey);
  if (acc.address.toLowerCase() !== FROM.address.toLowerCase() || acc.address.toLowerCase() !== TO.address.toLowerCase()) throw new Error('key does not match the registry');
  const bp = v.createPublicClient({ chain: base, transport: v.http('https://mainnet.base.org') }), bw = v.createWalletClient({ account: acc, chain: base, transport: v.http('https://mainnet.base.org') });
  const ap = v.createPublicClient({ chain: arcC, transport: v.http() }), aw = v.createWalletClient({ account: acc, chain: arcC, transport: v.http() });
  const bal = await bp.readContract({ address: BASE_USDC, abi, functionName: 'balanceOf', args: [acc.address] });
  if (bal < a) throw new Error('operator holds only ' + Number(bal) / 1e6 + ' USDC on Base');
  const greq = { source: 'base-hand-cctp-to-arc', chain: 'base', chainId: 8453, from: acc.address, to: TO.address, usdc: Number(amt), purpose: 'CCTP Base -> Arc ' + amt + ' USDC, operator gas' };
  H.mustAllow(greq);
  let h;
  try {
    // mainnet.base.org is load-balanced: a node that has not seen the approve yet simulates the burn as 'exceeds allowance' (13 Oct)
    if ((await bp.readContract({ address: BASE_USDC, abi, functionName: 'allowance', args: [acc.address, TM] })) < a) {
      h = await bw.writeContract({ address: BASE_USDC, abi, functionName: 'approve', args: [TM, a] }); await bp.waitForTransactionReceipt({ hash: h }); console.log('approve', h);
    }
    for (let i = 0; i < 30 && (await bp.readContract({ address: BASE_USDC, abi, functionName: 'allowance', args: [acc.address, TM] })) < a; i++) await new Promise((s) => setTimeout(s, 2000));
    h = await bw.writeContract({ address: TM, abi, functionName: 'depositForBurn', args: [a, 26, v.pad(TO.address), BASE_USDC, v.pad('0x'), 0n, 2000] });
  } catch (e) { H.release(greq, 'burn not sent: ' + (e.shortMessage || e.message)); throw e; }
  const r = await bp.waitForTransactionReceipt({ hash: h }); console.log('burn', h, r.status);
  await H.record(h, { source: 'base-hand-cctp-to-arc', chain: 'base', wallets: [acc.address], expect: { usdc: Number(amt) }, category: 'internal:bridge', notes: 'CCTP burn on Base for our operator on Arc' });
  if (r.status !== 'success') process.exit(1);
  let m; for (let i = 0; i < 360; i++) { const j = await fetch('https://iris-api.circle.com/v2/messages/6?transactionHash=' + h).then((x) => x.json()).catch(() => null); m = j && j.messages && j.messages[0]; if (m && m.status === 'complete') break; await new Promise((s) => setTimeout(s, 10000)); }
  if (!m || m.status !== 'complete') { console.log('attestation still pending after 60 min; the mint can be finished later with the burn hash', h, JSON.stringify(m || null).slice(0, 200)); process.exit(2); }
  const b0 = await ap.getBalance({ address: TO.address });
  const h2 = await aw.writeContract({ address: MT, abi, functionName: 'receiveMessage', args: [m.message, m.attestation] }); const r2 = await ap.waitForTransactionReceipt({ hash: h2 });
  const b1 = await ap.getBalance({ address: TO.address, blockNumber: r2.blockNumber });
  console.log('mint', h2, r2.status, 'operator on Arc', v.formatEther(b0), '->', v.formatEther(b1), '(net of the mint gas)');
})().catch((e) => { console.error(String(e.shortMessage || e.message || e)); process.exit(1); });
