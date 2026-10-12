// Posts one G2 Hello from the operator (passport #1) to the mainnet ArcG2Registry. No value.
const fs = require('fs'), V = 'viem';
const { createPublicClient, createWalletClient, http, toHex, parseAbi, decodeEventLog } = require(V);
const { privateKeyToAccount } = require(V + '/accounts');
const arc = { id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } };
const REG = '0xc8bd8a834f42ee8d7b7cce6ba2f774f9dc684a75';
const abi = JSON.parse(fs.readFileSync('out/ArcG2Registry.sol/ArcG2Registry.json', 'utf8')).abi;
const acct = privateKeyToAccount(JSON.parse(fs.readFileSync(process.env.KEY_FILE, 'utf8')).privateKey);
const pub = createPublicClient({ chain: arc, transport: http() }), wal = createWalletClient({ chain: arc, account: acct, transport: http() });
(async () => {
  const packet = toHex('G2|H|1|APEX Faucet agent #1 is listening on G2 for Arc. Directed queries to passport 1 get answered.');
  const hash = await wal.writeContract({ address: REG, abi, functionName: 'postSignal', args: [packet], value: 0n });
  const r = await pub.waitForTransactionReceipt({ hash });
  for (const l of r.logs) { try { const e = decodeEventLog({ abi, data: l.data, topics: l.topics }); console.log(e.eventName, 'sigType', e.args.sigType, 'passport', e.args.passportId.toString(), 'verified', e.args.verified); } catch (_) {} }
  console.log('status', r.status, 'tx', hash, 'gasUsed', r.gasUsed.toString());
})().catch((e) => { console.error('ERR', String(e.shortMessage || e.message).slice(0, 300)); process.exit(1); });
