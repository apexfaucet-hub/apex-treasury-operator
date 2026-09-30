'use strict';
// ACCOUNT LAYER: the only database rows it may read from outside its own directory (2026-09-29, review A1). The sandbox no
// longer mounts faucet.db, screener.db or arc-passport.db (they hold customer and personal data). /usr/local/sbin/apex-account/account-extract.sh copies the needed columns into this file
// at the start of every cycle, with a _manifest of source-vs-copy row counts and checksums.
const { openReadOnly } = require('./db.js');
const FILE = '/root/apex-faucet/data/protected/account-extract/extract.db';
const MAX_AGE_MIN = 180;   // older than one missed cycle plus margin: a run that reads it is incomplete

async function manifest() {
  const db = openReadOnly(FILE);
  try { return await db.all('SELECT * FROM _manifest'); } finally { await db.close(); }
}
// { ok, ageMin, generatedAt, problems[] }: ok only when every table copied completely and the file is fresh
async function check() {
  const m = await manifest();
  const problems = m.filter((r) => r.source_rows !== r.extract_rows || Math.abs(r.source_check - r.extract_check) > 1e-9 * Math.max(1, Math.abs(r.source_check)))
    .map((r) => r.tbl + ': source ' + r.source_rows + ' rows vs copy ' + r.extract_rows);
  const generatedAt = m.reduce((t, r) => (r.generated_at > t ? r.generated_at : t), '');
  const ageMin = generatedAt ? (Date.now() - Date.parse(generatedAt)) / 60000 : null;
  if (ageMin == null) problems.push('no manifest time');
  else if (ageMin > MAX_AGE_MIN) problems.push('extract is ' + Math.round(ageMin) + ' min old (limit ' + MAX_AGE_MIN + ')');
  return { ok: problems.length === 0, ageMin, generatedAt, tables: m.length, problems };
}
module.exports = { FILE, MAX_AGE_MIN, manifest, check, open: () => openReadOnly(FILE) };
