// Deploys ArcG2Registry + ApexPublicGood on Arc mainnet from the operator key. Prints addresses and tx hashes only.
const fs = require('fs');
const V = 'viem';
const { createPublicClient, createWalletClient, http, encodeDeployData, formatEther, getAddress } = require(V);
const { privateKeyToAccount } = require(V + '/accounts');
const [, , mode, REG, FEE] = process.argv;
const arc = { id: 5042, name: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } } };
const pub = createPublicClient({ chain: arc, transport: http() });
const acct = privateKeyToAccount(JSON.parse(fs.readFileSync(process.env.KEY_FILE, 'utf8')).privateKey);
const wal = createWalletClient({ chain: arc, account: acct, transport: http() });
const art = (n) => JSON.parse(fs.readFileSync(`out/${n}.sol/${n}.json`, 'utf8'));
const jobs = [
  ['ArcG2Registry', [getAddress(REG), 86400, getAddress(FEE), getAddress(FEE)]],
  ['ApexPublicGood', []],
];
(async () => {
  const gp = await pub.getGasPrice(), bal = await pub.getBalance({ address: acct.address });
  console.log('deployer', acct.address, 'balance', formatEther(bal), 'gasPrice gwei', Number(gp) / 1e9);
  let total = 0n;
  for (const [n, args] of jobs) {
    const a = art(n), data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args });
    const g = await pub.estimateGas({ account: acct.address, data });
    total += g * gp; console.log(n, 'gas', g.toString(), 'cost', formatEther(g * gp), 'args', JSON.stringify(args));
    if (mode !== 'send') continue;
    const hash = await wal.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, gas: g * 12n / 10n });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log(n, 'status', r.status, 'address', r.contractAddress, 'tx', hash, 'block', r.blockNumber.toString(), 'gasUsed', r.gasUsed.toString());
    if (r.status !== 'success') process.exit(1);
  }
  console.log('total est', formatEther(total));
})().catch((e) => { console.error('ERR', String(e.shortMessage || e.message).slice(0, 300)); process.exit(1); });
