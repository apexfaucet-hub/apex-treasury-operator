'use strict';
// SANCTIONS SCREEN FOR OUTGOING VALUE (2026-10-08). CLAUDE.md §9: refunds, bounties and payouts are never sent to an address on
// the OFAC/EU lists or the USDC blacklist. Until today that rule lived only in prose: tools/refund-base.js sent two refunds with
// the screen done by hand. This is the screen for EVM addresses.
//   - List: OFAC SDN Ethereum addresses, as published by github.com/ultrasoundmoney/ofac-ethereum-addresses (data.csv, derived
//     from the SDN list). Kept locally in data/sanctions/, refreshed when older than 7 days.
//   - FAIL CLOSED: if no list newer than 30 days can be read, checkEvm() throws, and the caller must not send.
//   - It is a screen, not legal advice: an EU-only listing with no published address, or a fresh designation newer than the
//     copy, is not covered. Callers also read USDC's own isBlacklisted() on chain.
const fs = require('fs');
const path = require('path');
const DIR = '/root/apex-faucet/data/sanctions';
const FILE = path.join(DIR, 'ofac-eth.csv');
const META = path.join(DIR, 'ofac-eth.meta.json');
const SOURCE = 'https://raw.githubusercontent.com/ultrasoundmoney/ofac-ethereum-addresses/main/data.csv';
const REFRESH_MS = 7 * 86400e3, MAX_AGE_MS = 30 * 86400e3;

function parse(csv) {
  const lines = String(csv || '').trim().split('\n');
  if (!/^address,name/i.test(lines[0] || '')) throw new Error('sanctions list: unexpected header');
  const map = new Map();
  for (const l of lines.slice(1)) {
    const m = l.match(/^(0x[0-9a-fA-F]{40}),(.*)$/);
    if (!m) throw new Error('sanctions list: malformed row "' + l.slice(0, 60) + '"');
    map.set(m[1].toLowerCase(), m[2].replace(/^"|"$/g, ''));
  }
  if (map.size < 50) throw new Error('sanctions list: only ' + map.size + ' addresses, refusing a truncated list');
  return map;
}
async function refresh() {
  const r = await fetch(SOURCE, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('sanctions list fetch HTTP ' + r.status);
  const csv = await r.text();
  const map = parse(csv);   // validate before replacing the copy we have
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', csv); fs.renameSync(FILE + '.tmp', FILE);
  fs.writeFileSync(META, JSON.stringify({ fetchedAt: new Date().toISOString(), source: SOURCE, addresses: map.size }));
  return map;
}
async function load() {
  let meta = null; try { meta = JSON.parse(fs.readFileSync(META, 'utf8')); } catch (e) { meta = null; }
  const age = meta ? Date.now() - Date.parse(meta.fetchedAt) : Infinity;
  if (age > REFRESH_MS) { try { const map = await refresh(); return { map, age: 0 }; } catch (e) { if (age > MAX_AGE_MS) throw new Error('no current sanctions list (' + e.message + '): do not send'); } }
  return { map: parse(fs.readFileSync(FILE, 'utf8')), age };
}
// { listed, name, listAgeDays, addresses } for an EVM address; throws when no current list can be read (fail closed).
async function checkEvm(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw new Error('not an EVM address: ' + address);
  const { map, age } = await load();
  const name = map.get(String(address).toLowerCase());
  return { listed: !!name, name: name || null, listAgeDays: Math.round(age / 86400e3 * 10) / 10, addresses: map.size };
}
module.exports = { checkEvm, refresh, parse };
