'use strict';
// ACCOUNT LAYER: database (2026-09-29). data/protected/account/account.db, SQLite in WAL mode.
// Amounts are stored twice: `raw` as the exact integer string the chain returned, `amount` as a float for sums.
// A failed read is a row with ok=0 and an error, never a zero amount.
const path = require('path');
const sqlite3 = require('/root/apex-faucet/node_modules/sqlite3');
const DIR = '/root/apex-faucet/data/protected/account';
const FILE = process.env.ACCOUNT_DB || path.join(DIR, 'account.db');

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS runs (run_id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, started_at TEXT NOT NULL,
     finished_at TEXT, method_version INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0, errors_json TEXT, summary_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS assets (asset_id TEXT PRIMARY KEY, chain TEXT NOT NULL, symbol TEXT, decimals INTEGER, identity_verified INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS balances (run_id INTEGER NOT NULL, wallet_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL,
     asset_id TEXT NOT NULL, raw TEXT, decimals INTEGER, amount REAL, rpc_url TEXT, block_or_slot TEXT, read_at TEXT NOT NULL,
     ok INTEGER NOT NULL, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_bal_run ON balances(run_id, wallet_id)`,
  `CREATE TABLE IF NOT EXISTS prices (run_id INTEGER NOT NULL, asset_id TEXT NOT NULL, method TEXT NOT NULL, usd REAL, source TEXT NOT NULL,
     source_detail TEXT, observed_at TEXT NOT NULL, age_s INTEGER, flags TEXT, ok INTEGER NOT NULL, error TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_price_run ON prices(run_id, asset_id)`,
  `CREATE TABLE IF NOT EXISTS valuations (run_id INTEGER NOT NULL, wallet_id TEXT NOT NULL, owner_class TEXT NOT NULL, chain TEXT NOT NULL,
     asset_id TEXT NOT NULL, amount REAL, spot_usd REAL, liquid_usd REAL, method TEXT, flags TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_val_run ON valuations(run_id)`,
  `CREATE TABLE IF NOT EXISTS positions (run_id INTEGER NOT NULL, strategy TEXT NOT NULL, chain TEXT NOT NULL, wallet_id TEXT NOT NULL,
     asset_id TEXT NOT NULL, symbol TEXT, qty_state TEXT, qty_chain TEXT, cost_usd REAL, mark_usd REAL, mark_source TEXT, mark_at TEXT,
     own_spot_usd REAL, liquid_usd REAL, mismatch INTEGER, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS lp_positions (run_id INTEGER NOT NULL, chain TEXT NOT NULL, venue TEXT NOT NULL, position_id TEXT NOT NULL,
     wallet_id TEXT NOT NULL, owner_class TEXT, owner_on_chain TEXT, owner_matches INTEGER, amount0 REAL, amount1 REAL, value_usd REAL,
     source TEXT, ok INTEGER NOT NULL, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS nav (run_id INTEGER PRIMARY KEY, at TEXT NOT NULL, spot_usd REAL, liquid_usd REAL, by_chain TEXT,
     by_owner_class TEXT, positions_usd REAL, unpriced TEXT, complete INTEGER NOT NULL, incomplete_reasons TEXT)`,
  `CREATE TABLE IF NOT EXISTS ledger (entry_id INTEGER PRIMARY KEY AUTOINCREMENT, ts_utc TEXT NOT NULL, block_time TEXT, chain TEXT NOT NULL,
     tx TEXT, wallet_id TEXT, direction TEXT NOT NULL, asset_id TEXT NOT NULL, amount REAL, usd_at_time REAL, usd_source TEXT,
     counterparty TEXT, counterparty_ours INTEGER, category TEXT NOT NULL, strategy TEXT, product TEXT, source TEXT NOT NULL,
     source_ref TEXT NOT NULL, confidence TEXT NOT NULL, notes TEXT, ingested_at TEXT NOT NULL, UNIQUE(source, source_ref))`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger(wallet_id, ts_utc)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger(chain, tx)`,
  `CREATE TABLE IF NOT EXISTS source_cursors (source TEXT PRIMARY KEY, cursor TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS recon (recon_id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, period_start TEXT, period_end TEXT,
     wallet_id TEXT, chain TEXT, asset_id TEXT, open_amt REAL, close_amt REAL, chain_delta REAL, explained_delta REAL, fee_estimate REAL,
     unexplained REAL, unexplained_usd REAL, status TEXT NOT NULL, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS alerts (alert_id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, wallet_id TEXT,
     chain TEXT, tx TEXT, amount_usd REAL, detail TEXT, delivered INTEGER DEFAULT 0, UNIQUE(kind, chain, tx))`,
];

function open(file) {
  const db = new sqlite3.Database(file || FILE);
  const run = (sql, p = []) => new Promise((ok, no) => db.run(sql, p, function (e) { e ? no(e) : ok(this); }));
  const all = (sql, p = []) => new Promise((ok, no) => db.all(sql, p, (e, r) => (e ? no(e) : ok(r))));
  const get = (sql, p = []) => new Promise((ok, no) => db.get(sql, p, (e, r) => (e ? no(e) : ok(r))));
  const close = () => new Promise((ok) => db.close(() => ok()));
  // Additive migrations: a column added after a table first existed. 'duplicate column' means it is already there.
  const MIGRATE = [
    // amount_basis (2026-09-29): 'transfer' = the amount the chain moved; 'net-of-gas' = the wallet's whole balance change for
    // the action, gas included (the Arc dip trader's costUsdc / backUsdc). The reconciler compares each the way it was written.
    "ALTER TABLE ledger ADD COLUMN amount_basis TEXT NOT NULL DEFAULT 'transfer'",
    // (2026-09-29, method 2) spot without the self-priced Arc APEX, and what the NAV does NOT cover, in words
    'ALTER TABLE nav ADD COLUMN spot_ex_self_priced_usd REAL',
    'ALTER TABLE nav ADD COLUMN coverage TEXT',
    // (09-29, Fable review v2) amount_raw: the writer's exact raw units when it gives no decimals (dip-trader tokens);
    // alerts carry the run and method that raised them, and the run that later explained them (never deleted)
    'ALTER TABLE ledger ADD COLUMN amount_raw TEXT',
    'ALTER TABLE alerts ADD COLUMN run_id INTEGER',
    'ALTER TABLE alerts ADD COLUMN method_version INTEGER',
    'ALTER TABLE alerts ADD COLUMN superseded_by INTEGER',
  ];
  const init = async () => {
    await run('PRAGMA journal_mode=WAL'); await run('PRAGMA busy_timeout=15000'); for (const s of SCHEMA) await run(s);
    for (const m of MIGRATE) { try { await run(m); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
  };
  return { db, run, all, get, close, init };
}

// Read-only handle for the existing ledgers (faucet.db, arc-passport.db ...). Never written by the account layer.
function openReadOnly(file) {
  const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
  const all = (sql, p = []) => new Promise((ok, no) => db.all(sql, p, (e, r) => (e ? no(e) : ok(r))));
  const get = (sql, p = []) => new Promise((ok, no) => db.get(sql, p, (e, r) => (e ? no(e) : ok(r))));
  const close = () => new Promise((ok) => db.close(() => ok()));
  return { all, get, close };
}

module.exports = { open, openReadOnly, FILE, DIR };
