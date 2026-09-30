'use strict';
// $5 DATA PASS (2026-09-30). Martin, 29 Sep: "the 5 euro stripe option"; Gemini's review of our money map: agents and
// the people who build them dislike paying per call from a wallet, so sell a prepaid balance by card. Dollars, not
// euros: every price here is set in USD (CLAUDE.md §2). Reviewed by Fable 30 Sep (audits/fable-review-data-pass-2026-09-30.md);
// H1-H3 and M1-M7 are fixed below, each marked with its id.
//
// HOW IT WORKS
// - POST /api/pass/checkout opens a Stripe Checkout for $5.00, tax included (metadata.kind = 'data_pass').
// - After payment Stripe sends the buyer to /pass/?session_id=cs_live_...; the page POSTs that id to /api/pass/claim
//   (a POST keeps the id, which is the claim secret, out of nginx access logs: M3). We ask Stripe whether the session is
//   paid, live, $5.00 and not refunded or disputed (never trust the URL), and hand back the pass key.
// - The key is DERIVED from a dedicated secret that is never rotated, data/protected/.pass-key (H1): HMAC(pass-key, session
//   id). We keep only its SHA-256, the balance, and a map from sha256(session id) to the pass, so one payment is one pass
//   whatever happens to any key file (H1). Rotating .pass-key would stop re-claims of old sessions; issued keys keep working
//   because the store keys on their hash.
// - A paid call sends the key in X-APEX-PASS (or Authorization: Bearer apx_...). The x402 gate takes the product's LIST price
//   (lib/prices.js, the number the 402 asks) off the balance. If we fail to answer (HTTP >= 400, or ok:false), the charge goes
//   back automatically. A caller who hangs up after the work has started is charged, as with any service (M1).
// - Only products handed to the paying wallet (the agent passports: gate opts.walletBound) need an on-chain payment (H2).
// - A refunded or disputed card payment revokes its pass: Stripe's charge.refunded / charge.dispute.created events, and a
//   check on every claim (H3). tools/pass-revoke.js does it by hand.
//
// STORAGE: data/protected/passes.json (root 0600), written synchronously (read-modify-write in one tick, so one process
// cannot race itself). The app runs with CLUSTER_WORKERS=0; spend() refuses in cluster mode rather than risk double spends.
// Every event goes to data/protected/pass-log.ndjson (query strings stripped: L9), and a copy of the store is kept once a day
// in data/protected/pass-backup/ (M7). Balances can also be rebuilt from the log.
const fs = require('fs');
const crypto = require('crypto');

// DATA_PASS_DIR lets the tests run against a scratch copy; production never sets it.
const DIR = process.env.DATA_PASS_DIR || '/root/apex-faucet/data/protected';
const STORE = DIR + '/passes.json';
const LOG = DIR + '/pass-log.ndjson';
const SECRET = DIR + '/.pass-key';
const BACKUP_DIR = DIR + '/pass-backup';
const PASS_USD = 5;                 // what the card pays
const PASS_CENTS = 500;
const MICRO = 1e6;
const KEY_RE = /^apx_[A-Za-z0-9_-]{32}$/;
const EARLY_HANGUP_MS = 1500;       // a hang-up this soon, before any answer, gets the charge back (M1)
const EARLY_HANGUP_CAP = 3;         // ... at most this many times per pass per day (re-check M1: send, abort, repeat must not be free)
const _earlyGiveBacks = new Map();  // passId|day -> count (one process; resets on restart, which only makes it stricter never looser for a day)

// The dedicated secret: created once, 0600, never rotated (H1). Never the internal-route secret.
function secret() {
  try { return fs.readFileSync(SECRET, 'utf8').trim(); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const s = crypto.randomBytes(48).toString('base64url');
    try { fs.writeFileSync(SECRET, s + '\n', { mode: 0o600, flag: 'wx' }); } catch (w) { if (w.code !== 'EEXIST') throw w; }   // never overwrite one that appeared meanwhile
    return fs.readFileSync(SECRET, 'utf8').trim();
  }
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function keyForSession(sessionId) {
  const k = secret(); if (k.length < 40) throw new Error('pass secret missing or too short');
  return 'apx_' + crypto.createHmac('sha256', k).update('data-pass:v1:' + sessionId).digest('base64url').slice(0, 32);
}
function idOf(key) { return sha(key).slice(0, 24); }
const sidHash = (sid) => sha('sid:' + sid).slice(0, 32);

function load() {
  try { const d = JSON.parse(fs.readFileSync(STORE, 'utf8')); d.passes = d.passes || {}; d.sids = d.sids || {}; return d; } catch (e) {
    if (e.code === 'ENOENT') return { v: 2, passes: {}, sids: {} };
    throw e;   // a corrupt store must stop spending, never be treated as empty (that would erase balances)
  }
}
function save(db) {
  const tmp = STORE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 1), { mode: 0o600 }); fs.renameSync(tmp, STORE);
  try {   // M7: one copy a day
    const day = new Date().toISOString().slice(0, 10), f = BACKUP_DIR + '/passes-' + day + '.json';
    if (!fs.existsSync(f)) { fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 }); fs.copyFileSync(STORE, f); fs.chmodSync(f, 0o600); }
  } catch (e) { console.error('[pass] daily backup failed: ' + e.message); }
}
function log(o) { try { fs.appendFileSync(LOG, JSON.stringify(Object.assign({ at: new Date().toISOString() }, o)) + '\n', { mode: 0o600 }); } catch (e) { console.error('[pass] LOG FAILED: ' + e.message); } }
const clustered = () => Number(process.env.CLUSTER_WORKERS || 0) > 0;
const cleanResource = (r) => String(r || '').split('?')[0].slice(0, 120);   // L9: never a customer's ?url=

// L1: one line to the private operations channel when a pass is sold or a paid session is refused.
function alertPrivate(msg) {
  if (process.env.DATA_PASS_DIR) return;   // tests never alert
  try {
    const env = fs.readFileSync('/root/apex-faucet/.env', 'utf8');
    const pick = (x) => (env.match(new RegExp('^' + x + '=(.*)$', 'm')) || [])[1];
    const token = pick('TELEGRAM_BOT_TOKEN'), chat = pick('TELEGRAM_OPS_CHAT_ID') || pick('TELEGRAM_PRIVATE_CHAT_ID');
    if (!token || !chat) return;
    fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: msg, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }).catch(() => {});
  } catch (e) { console.error('[pass] private alert not sent: ' + e.message); }   // alerts never break a sale, but a lost alert is logged
}

// The key a request carries, if any.
function keyFrom(req) {
  const h = req.headers || {};
  let k = h['x-apex-pass'];
  if (!k && typeof h.authorization === 'string') { const m = /^Bearer\s+(apx_\S+)$/i.exec(h.authorization.trim()); if (m) k = m[1]; }
  k = String(k || '').trim();
  return KEY_RE.test(k) ? k : null;
}

// Is this Stripe session a paid, live, $5.00 data pass? Throws with the reason if not.
function checkSession(session) {
  if (!session || session.object !== 'checkout.session') throw new Error('not a checkout session');
  if (session.livemode !== true && !process.env.DATA_PASS_ALLOW_TEST) throw new Error('not a live session');   // M4
  if (session.payment_status !== 'paid') throw new Error('session not paid');
  const md = session.metadata || {};
  if (md.kind !== 'data_pass') throw new Error('not a data pass session');
  // M5: the SUBTOTAL is $5.00 under either tax behaviour; no discount; USD (or converted from a USD price, L2)
  const td = session.total_details || {};
  const cc = session.currency_conversion;
  const usdOk = String(session.currency).toLowerCase() === 'usd' ? Number(session.amount_subtotal) === PASS_CENTS
    : !!(cc && String(cc.source_currency).toLowerCase() === 'usd' && Number(cc.amount_subtotal) === PASS_CENTS);
  if (!usdOk) throw new Error('unexpected amount ' + session.amount_subtotal + ' ' + session.currency);
  if (Number(td.amount_discount || 0) !== 0) throw new Error('discounted session');
}

// Create the pass for a PAID session (idempotent on the SESSION, H1).
function fulfil(session, opts) {
  try { checkSession(session); } catch (e) {
    if (session && session.payment_status === 'paid') alertPrivate('DATA PASS: Stripe says session ' + String(session.id).slice(0, 14) + '... is paid, but it was refused: ' + e.message);
    throw e;
  }
  const key = keyForSession(session.id), id = idOf(key), sh = sidHash(session.id);
  const db = load();
  const existing = db.sids[sh];
  if (existing) {
    const p = db.passes[existing];
    return { key: existing === id ? key : null, id: existing, alreadyApplied: true, balanceUsd: p ? p.balanceMicro / MICRO : null, revoked: !!(p && p.revoked) };
  }
  if (db.passes[id]) { db.sids[sh] = id; save(db); return { key, id, alreadyApplied: true, balanceUsd: db.passes[id].balanceMicro / MICRO, revoked: !!db.passes[id].revoked }; }
  db.passes[id] = { sid: sh, createdAt: new Date().toISOString(), usd: PASS_USD, balanceMicro: PASS_USD * MICRO,
    spentMicro: 0, refundedMicro: 0, calls: 0, revoked: false, revokedWhy: null, lastUsedAt: null,
    paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null };
  db.sids[sh] = id;
  save(db);
  log({ ev: 'created', id, usd: PASS_USD });
  if (!(opts && opts.quiet)) alertPrivate('DATA PASS sold: $5.00 by card (pass ' + id.slice(0, 8) + '). Outside revenue.');
  return { key, id, alreadyApplied: false, balanceUsd: PASS_USD, revoked: false };
}

// H3: switch a pass off (refund, dispute, or by hand). By session id.
function revokeSession(sessionId, why) {
  const db = load(); const id = db.sids[sidHash(sessionId)];
  if (!id || !db.passes[id]) return { ok: false, error: 'no pass for that session' };
  const p = db.passes[id];
  if (!p.revoked) { p.revoked = true; p.revokedWhy = String(why || '').slice(0, 200); p.revokedAt = new Date().toISOString(); save(db); log({ ev: 'revoked', id, why: p.revokedWhy, balanceUsd: p.balanceMicro / MICRO }); alertPrivate('DATA PASS ' + id.slice(0, 8) + ' revoked: ' + p.revokedWhy); }
  return { ok: true, id };
}

// Take `usd` off the pass. Returns { ok, id, balanceUsd } or { ok:false, error, balanceUsd? }.
function spend(key, usd, resource) {
  if (clustered()) return { ok: false, error: 'passes are paused on this server (cluster mode needs a file lock first)' };
  const micro = Math.round(Number(usd) * MICRO);
  if (!(micro > 0)) return { ok: false, error: 'this call has no price' };
  const id = idOf(key);
  let db; try { db = load(); } catch (e) { console.error('[pass] STORE UNREADABLE: ' + e.message); return { ok: false, error: 'the pass store could not be read just now; nothing was charged' }; }
  const p = db.passes[id];
  if (!p) return { ok: false, error: 'unknown pass key' };
  if (p.revoked) return { ok: false, error: 'this pass was revoked (its card payment was refunded or disputed)' };
  if (p.balanceMicro < micro) return { ok: false, error: 'this call costs $' + (micro / MICRO).toFixed(3) + ' and the pass holds $' + (p.balanceMicro / MICRO).toFixed(3), balanceUsd: p.balanceMicro / MICRO };
  p.balanceMicro -= micro; p.spentMicro += micro; p.calls += 1; p.lastUsedAt = new Date().toISOString();
  save(db);
  log({ ev: 'spend', id, usd: micro / MICRO, resource: cleanResource(resource), balanceUsd: p.balanceMicro / MICRO });
  return { ok: true, id, balanceUsd: p.balanceMicro / MICRO };
}

// Put a charge back (we did not deliver).
function refund(key, usd, why) {
  const micro = Math.round(Number(usd) * MICRO), id = idOf(key);
  let db; try { db = load(); } catch (e) { console.error('[pass] REFUND FAILED, store unreadable: ' + e.message); log({ ev: 'refund-failed', id, usd, why }); return false; }
  const p = db.passes[id]; if (!p || !(micro > 0)) return false;
  p.balanceMicro += micro; p.spentMicro -= micro; p.refundedMicro += micro; p.calls = Math.max(0, p.calls - 1);
  save(db);
  log({ ev: 'refund', id, usd: micro / MICRO, why: String(why || '').slice(0, 120), balanceUsd: p.balanceMicro / MICRO });
  return true;
}

// Charge once the answer is known: HTTP >= 400 or ok:false gets the charge back. A hang-up gets it back only if it came
// within EARLY_HANGUP_MS and before any answer started (M1: an abort after the work began is charged).
function chargeOnDelivery(req, res, key, usd) {
  let settled = false; const startedAt = Date.now();
  const giveBack = (why) => { if (settled) return; settled = true; refund(key, usd, why); };
  const keep = (why) => { if (settled) return; settled = true; if (why) log({ ev: 'kept', id: idOf(key), usd, why }); };
  const origJson = res.json.bind(res);
  res.json = (body) => { if (body && body.ok === false) giveBack('answer ok:false'); return origJson(body); };
  res.on('finish', () => { if (res.statusCode >= 400) giveBack('HTTP ' + res.statusCode); else keep(); });
  res.on('close', () => {
    if (res.writableFinished) return;
    const dayKey = idOf(key) + '|' + new Date().toISOString().slice(0, 10), n = _earlyGiveBacks.get(dayKey) || 0;
    if (!res.headersSent && Date.now() - startedAt < EARLY_HANGUP_MS && n < EARLY_HANGUP_CAP) { _earlyGiveBacks.set(dayKey, n + 1); giveBack('caller hung up before any work'); }
    else keep('caller hung up after the work started');
  });
}

function status(key) {
  const p = load().passes[idOf(key)];
  if (!p) return null;
  return { balanceUsd: p.balanceMicro / MICRO, spentUsd: p.spentMicro / MICRO, calls: p.calls, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt, revoked: p.revoked };
}

// A tiny per-client limiter for the two Stripe-backed routes (M2). One process, so memory is enough here; the key is the
// real client address (req.ip is nginx's 127.0.0.1, CLAUDE.md §12).
const _hits = new Map();
function limited(req, name, perMin) {
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'local');
  const k = name + '|' + ip, now = Date.now(), arr = (_hits.get(k) || []).filter((t) => now - t < 60000);
  arr.push(now); _hits.set(k, arr);
  if (_hits.size > 5000) for (const [kk, v] of _hits) if (!v.length || now - v[v.length - 1] > 60000) _hits.delete(kk);
  return arr.length > perMin;
}

function mount(app) {
  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
  async function stripe(path, body) {
    const r = await fetch('https://api.stripe.com/v1/' + path, { method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body || undefined,
      signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (!r.ok) { const e = new Error((j.error && j.error.message) || ('stripe ' + r.status)); e.stripe = true; e.status = r.status; throw e; }
    return j;
  }
  app.post('/api/pass/checkout', async (req, res) => {
    if (limited(req, 'checkout', 3)) return res.status(429).set('Retry-After', '60').json({ ok: false, error: 'too many checkouts from here; try again in a minute' });
    if (!STRIPE_KEY) return res.status(503).json({ ok: false, error: 'card payments are not configured on this server' });
    try {
      const f = new URLSearchParams();
      f.append('mode', 'payment');
      f.append('line_items[0][quantity]', '1');
      f.append('line_items[0][price_data][currency]', 'usd');
      f.append('line_items[0][price_data][unit_amount]', String(PASS_CENTS));
      // Tax INCLUDED (Martin, 29 Sep: "Shouldn't we only charge $5 when we advertise $5?"): a house buyer abroad paid
      // $5.50 because Stripe added local tax on top. The advertised price is now the price paid, everywhere.
      f.append('line_items[0][price_data][tax_behavior]', 'inclusive');
      f.append('line_items[0][price_data][product_data][name]', 'APEX data pass: $5 of paid API calls');
      f.append('line_items[0][price_data][product_data][description]', 'A key worth $5.00 of calls to APEX Faucet paid data endpoints at their list prices. No crypto wallet needed. Unused balance does not expire; a call we fail to answer is not charged.');
      // Managed Payments refuses any line item without a tax code (city-market.js uses the same code).
      f.append('line_items[0][price_data][product_data][tax_code]', 'txcd_10000000');
      f.append('metadata[kind]', 'data_pass');
      f.append('success_url', 'https://apexfaucet.xyz/pass/?session_id={CHECKOUT_SESSION_ID}');
      f.append('cancel_url', 'https://apexfaucet.xyz/pass/?cancelled=1');
      const s = await stripe('checkout/sessions', f);
      res.json({ ok: true, url: s.url });
    } catch (e) { res.status(e.status === 429 ? 503 : e.stripe ? 502 : 500).json({ ok: false, error: String(e.message).slice(0, 200) }); }
  });
  app.post('/api/pass/claim', async (req, res) => {
    res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex');
    if (limited(req, 'claim', 10)) return res.status(429).set('Retry-After', '60').json({ ok: false, error: 'too many tries from here; wait a minute' });
    const sid = String((req.body && req.body.session_id) || '');
    const re = process.env.DATA_PASS_ALLOW_TEST ? /^cs_(live|test)_[A-Za-z0-9]{10,200}$/ : /^cs_live_[A-Za-z0-9]{10,200}$/;   // M4
    if (!re.test(sid)) return res.status(400).json({ ok: false, error: 'session_id must be the Stripe checkout id from the page you came back to' });
    if (!STRIPE_KEY) return res.status(503).json({ ok: false, error: 'card payments are not configured on this server' });
    try {
      const s = await stripe('checkout/sessions/' + encodeURIComponent(sid) + '?expand[]=payment_intent.latest_charge');
      if (s.payment_status !== 'paid') return res.status(402).json({ ok: false, error: 'this checkout is not paid (yet)', status: s.payment_status });
      const ch = s.payment_intent && s.payment_intent.latest_charge;
      if (ch && (ch.refunded || ch.amount_refunded > 0 || ch.disputed)) {   // H3: a refunded or disputed payment never gets its key
        try { fulfil(s, { quiet: true }); } catch (e) { /* recorded by fulfil */ }   // quiet: a refunded payment is not a sale (re-check N2)
        revokeSession(sid, ch.disputed ? 'card payment disputed' : 'card payment refunded');
        return res.status(410).json({ ok: false, error: 'this card payment was refunded or disputed, so its pass is switched off' });
      }
      const out = fulfil(s);
      if (!out.key) return res.status(409).json({ ok: false, error: 'this payment already has a pass; its key can no longer be derived here. Ask at https://apexfaucet.xyz/safetynet/ with the time you paid.' });
      const st = status(out.key);
      res.json({ ok: true, key: out.key, balanceUsd: st.balanceUsd, revoked: st.revoked,
        how: 'Send this key in the X-APEX-PASS header on any paid call under https://apexfaucet.xyz/api/x402/. Keep it private: whoever has it can spend it.' });
    } catch (e) { res.status(e.status === 429 ? 503 : e.stripe ? 502 : 400).json({ ok: false, error: String(e.message).slice(0, 200) }); }
  });
  app.get('/api/pass/balance', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const key = keyFrom(req);
    if (!key) return res.status(400).json({ ok: false, error: 'send your pass key in the X-APEX-PASS header' });
    let st; try { st = status(key); } catch (e) { return res.status(503).json({ ok: false, error: 'the pass store could not be read just now' }); }   // L3
    if (!st) return res.status(404).json({ ok: false, error: 'unknown pass key' });
    res.json(Object.assign({ ok: true }, st));
  });
  const W = require('../stripe-webhook.js');
  W.registerFulfiller('data_pass', async (session) => fulfil(session));
  // H3: refunds and disputes. The event carries a charge (or a dispute); its checkout session is found through the payment intent.
  const onChargeTrouble = async (pi, why) => {
    if (!pi) return { ignored: 'no payment intent' };
    const list = await stripe('checkout/sessions?payment_intent=' + encodeURIComponent(pi) + '&limit=1');
    const s = list.data && list.data[0];
    if (!s || !s.metadata || s.metadata.kind !== 'data_pass') return { ignored: 'not a data pass' };
    return revokeSession(s.id, why);
  };
  if (typeof W.registerEventHandler === 'function') {
    W.registerEventHandler('charge.refunded', (charge) => onChargeTrouble(charge && charge.payment_intent, 'card payment refunded'));
    W.registerEventHandler('charge.dispute.created', (dispute) => onChargeTrouble(dispute && dispute.payment_intent, 'card payment disputed'));
  } else console.error('[pass] stripe-webhook.js has no registerEventHandler: refunds will NOT revoke passes automatically');
  console.log('[pass] $5 data pass mounted (/api/pass/checkout, /claim, /balance)');
}

module.exports = { mount, keyFrom, spend, refund, chargeOnDelivery, status, fulfil, revokeSession, keyForSession, checkSession, PASS_USD };
