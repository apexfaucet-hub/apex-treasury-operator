'use strict';
// SHARED LEDGER WRITER (2026-09-29). The account layer reconciles every registered wallet against a ledger every two
// hours; an outflow nobody recorded raises an alert. On 29 Sep three of our own bots kept tripping it: the X1 faucet
// paying rent for a new claimer's token account (a hidden transaction inside spl-token's getOrCreateAssociatedTokenAccount),
// the bounty bot escrowing a reward into a new program account, and the rental driver paying wages. None of them wrote
// a ledger row. This module is the one place a sender records what it sent.
//
// RULES
// - Only the SENDER calls this, with the signature IT got back for a transaction IT built and signed. It is never run over
//   a wallet's history: a ledger that copied the chain would "explain" a drain as well (the point of the check is that a
//   move nobody intended has no row).
// - It records NATIVE lamports that left each of the named wallets through system-program instructions (transfer,
//   createAccount, their WithSeed forms) and associated-token-account creations the wallet funded, top-level or inner
//   (CPI). One row per instruction, amount in XNT/SOL units, basis 'transfer' (the network fee is NOT included: the
//   reconciler adds the fee itself). Token transfers are left to their existing sources (claims table, trader logs), so
//   nothing is counted twice.
// - Rows go to data/ledger/<source>.ndjson (append-only). The account layer's ingest reads data/ledger/*.ndjson.
// - It never throws into the caller's payment flow. A failure is written to data/ledger/_errors-<source>.ndjson and logged loudly;
//   the reconciler will then alarm on the unrecorded outflow, which is the correct outcome.
const fs = require('fs');
const path = require('path');

const DIR = process.env.LEDGER_DIR || '/root/apex-faucet/data/ledger';   // LEDGER_DIR: tests only
const SYSTEM = '11111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

// H6 (Fable, 29 Sep): root (the app) and claudeuser (the bots) both append here. A file root creates first is handed to
// claudeuser (uid 1000) with mode 644, so either writer can always append; a hand run with umask 077 cannot make it 600.
function append(file, obj) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const p = path.join(DIR, file), fresh = !fs.existsSync(p);
    fs.appendFileSync(p, JSON.stringify(obj) + '\n');
    if (fresh) { try { fs.chmodSync(p, 0o644); if (process.getuid && process.getuid() === 0) fs.chownSync(p, 1000, 1000); } catch (e) { console.error('[ledger] could not set owner/mode on ' + file + ': ' + e.message); } }
    return true;
  }
  catch (e) { console.error('[ledger] WRITE FAILED ' + file + ': ' + e.message); return false; }
}
function fail(source, sig, why) {
  console.error('[ledger] NOT RECORDED ' + source + ' ' + String(sig).slice(0, 16) + ': ' + why);
  // one error file per source: the app runs as root and some bots as claudeuser, so a shared file would be unwritable for one
  append('_errors-' + (SOURCE_RE.test(String(source || '')) ? source : 'unknown') + '.ndjson', { at: new Date().toISOString(), source, tx: sig, error: String(why).slice(0, 300) });
}

// The native lamports that left each wallet in `wallets` through system transfers / account creations / ATA creations.
// Pure: takes a jsonParsed transaction (getTransaction with encoding jsonParsed). Exported for the tests.
// Keys and program ids arrive as strings from raw JSON RPC but as PublicKey objects from web3.js getParsedTransaction:
// compare them as base58 strings either way (found 30 Sep: with web3.js objects every transaction yielded zero flows).
const b58 = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v.toBase58 === 'function' ? v.toBase58() : String(v));
function nativeOutflows(ptx, wallets) {
  const mine = new Set(wallets.map(b58));
  const keys = ptx.transaction.message.accountKeys.map((k) => b58(typeof k === 'string' ? k : k.pubkey));
  const pre = ptx.meta.preBalances, post = ptx.meta.postBalances;
  const out = [];
  const all = [].concat(ptx.transaction.message.instructions.map((ix) => ({ ix, inner: false })),
    ...((ptx.meta.innerInstructions || []).map((g) => g.instructions.map((ix) => ({ ix, inner: true })))));
  // Pass 1: every system-program move out of our wallets, top-level or inner (CPI).
  for (const { ix, inner } of all) {
    const p = ix.parsed, pid = b58(ix.programId);
    if (pid !== SYSTEM || !p || typeof p !== 'object') continue;
    const info = p.info || {};
    if (!['transfer', 'transferWithSeed', 'createAccount', 'createAccountWithSeed'].includes(p.type)) continue;
    const from = info.source || info.from;
    const to = info.destination || info.newAccount || info.to;
    if (!mine.has(from) || !(Number(info.lamports) > 0)) continue;
    out.push({ wallet: from, to, lamports: Number(info.lamports), kind: /^create/.test(p.type) ? 'account-rent' : 'transfer', inner });
  }
  // Pass 2: an associated-token-account creation we funded whose inner system instruction the RPC did NOT return parsed
  // (pass 1 already has it otherwise; counting both was the double count caught on real claims, 2026-09-29).
  for (const { ix } of all) {
    const p = ix.parsed;
    if (b58(ix.programId) !== ATA || !p || !['create', 'createIdempotent'].includes(p.type)) continue;
    const info = p.info || {};
    const i = keys.indexOf(info.account);
    if (!mine.has(info.source) || i < 0 || out.some((o) => o.to === info.account)) continue;
    const funded = post[i] - pre[i];
    if (funded > 0) out.push({ wallet: info.source, to: info.account, lamports: funded, kind: 'account-rent', inner: false, via: 'ata' });
  }
  return out;
}

// Record a transaction this process just sent. Waits for it to confirm (up to ~90 s), then writes the rows.
// meta: { source, wallets: [address…], expect: { maxLamports } (required, H5), category, product?, notes?, rentCategory?, rpc? }
async function recordSent(connection, sig, meta) {
  const source = meta && meta.source;
  if (!SOURCE_RE.test(String(source || ''))) return fail(String(source), sig, 'bad source name');
  if (!sig || !Array.isArray(meta.wallets) || !meta.wallets.length) return fail(source, sig, 'missing signature or wallets');
  // H4: poll a DIRECT node. The RPC bus caches a null getTransaction for six hours, so polling through it read the
  // first miss 18 times. The caller's connection is not used for the poll.
  const { Connection } = require('@solana/web3.js');
  const direct = new Connection(meta.rpc || 'https://rpc.mainnet.x1.xyz', { commitment: 'confirmed' });
  let ptx = null;
  for (let i = 0; i < 18 && !ptx; i++) {
    try {
      ptx = await direct.getParsedTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    } catch (e) { /* retry */ }
    if (!ptx) await new Promise((r) => setTimeout(r, 5000));
  }
  if (!ptx) return fail(source, sig, 'transaction not found after 90 s (not landed, or RPC behind)');
  if (ptx.meta && ptx.meta.err) { append(source + '.ndjson', { at: new Date().toISOString(), tx: sig, failed: true, err: JSON.stringify(ptx.meta.err).slice(0, 200), note: 'failed on chain: only its fee left our wallet, which the reconciler counts itself' }); return; }
  const flows = nativeOutflows(ptx, meta.wallets);
  // H5: the sender states the most it meant to move. More than that is NOT recorded, so the reconciler alarms, which is
  // the point: a program invoked with our signer that moves more must never be "explained" by the chain it moved on.
  const total = flows.reduce((t, f) => t + f.lamports, 0);
  if (!meta.expect || !(Number(meta.expect.maxLamports) >= 0)) return fail(source, sig, 'no expect.maxLamports given: refusing to record an unbounded outflow');
  if (total > Number(meta.expect.maxLamports)) return fail(source, sig, 'exceeds-expectation: ' + total + ' lamports left, the sender expected at most ' + meta.expect.maxLamports);
  const at = ptx.blockTime ? new Date(ptx.blockTime * 1000).toISOString() : new Date().toISOString();
  flows.forEach((f, n) => append(source + '.ndjson', {
    at, chain: meta.chain || 'x1', tx: sig, leg: n, wallet: f.wallet, direction: 'out', asset_id: (meta.chain || 'x1') + ':native',
    amount: f.lamports / 1e9, lamports: f.lamports, counterparty: f.to,
    category: f.kind === 'account-rent' ? (meta.rentCategory || 'cost:account-rent') : (meta.category || 'transfer'),
    product: meta.product || null, notes: (meta.notes ? meta.notes + '; ' : '') + f.kind + (f.inner ? ' (inner instruction)' : ''),
  }));
  return flows;
}

// Fire and forget: for payment paths that must not wait. Errors land in _errors-<source>.ndjson.
function recordSentLater(connection, sig, meta) {
  recordSent(connection, sig, meta).catch((e) => fail(meta && meta.source, sig, e.message));
}

// Create a missing associated token account with a transaction whose signature we keep, record its rent, and return the
// account (same shape as spl-token's getAccount). Replaces spl-token's getOrCreateAssociatedTokenAccount on payout paths:
// that helper sends its own transaction and never returns the signature, so its rent could never be recorded.
async function getOrCreateAtaRecorded(connection, payer, mint, owner, meta, programId) {
  const spl = require('@solana/spl-token');
  const { Transaction, PublicKey } = require('@solana/web3.js');
  const prog = programId || spl.TOKEN_PROGRAM_ID;
  const mintPk = new PublicKey(mint), ownerPk = new PublicKey(owner);
  const ata = spl.getAssociatedTokenAddressSync(mintPk, ownerPk, false, prog);
  try { return await spl.getAccount(connection, ata, 'confirmed', prog); } catch (e) {
    if (!(e instanceof spl.TokenAccountNotFoundError) && !(e instanceof spl.TokenInvalidAccountOwnerError)) throw e;
  }
  // H3: sign first and take the signature BEFORE sending, so a send that lands but confirms late is still recorded; on
  // any error after the send, re-read the account and carry on if it exists (spl-token's helper did the same).
  // 2026-10-06: request a compute limit. X1 bills the REQUESTED limit (~10 lamports/unit) and the default 200k made this
  // 2,001,500 lamports of fee on top of 2,039,280 rent, over the 2.2M bound, so the recorder refused every first-claim row.
  // Measured 22,068 CU for a classic-token account; 40,000 leaves ~80% margin (Token-2022: 80,000).
  const units = prog.equals(spl.TOKEN_2022_PROGRAM_ID) ? 80000 : 40000;
  const tx = new Transaction().add(require('@solana/web3.js').ComputeBudgetProgram.setComputeUnitLimit({ units }))
    .add(spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, ownerPk, mintPk, prog));
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash; tx.feePayer = payer.publicKey; tx.sign(payer);
  const sig = require('bs58').encode(tx.signature);
  await connection.sendRawTransaction(tx.serialize());
  recordSentLater(connection, sig, Object.assign({ wallets: [payer.publicKey.toBase58()], rentCategory: 'cost:claim-account-rent', expect: { maxLamports: 2039280 + 1500 + units * 10 + 100000 } }, meta));
  try { await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed'); }
  catch (e) { try { return await spl.getAccount(connection, ata, 'confirmed', prog); } catch (_) { throw e; } }
  return spl.getAccount(connection, ata, 'confirmed', prog);
}

// _append/_fail: for lib/ledger-log-evm.js (the Arc/Base recorder, 2026-10-06), so both write the same files the same way.
module.exports = { recordSent, recordSentLater, getOrCreateAtaRecorded, nativeOutflows, DIR, _append: append, _fail: fail };
