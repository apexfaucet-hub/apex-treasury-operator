'use strict';
// ACCOUNT LAYER: the one wallet registry (2026-09-29).
//
// data/protected/account/wallet-registry.json is the authoritative list of every address we own, control or watch, by
// chain. It holds PUBLIC addresses only. `key_file_name` is the NAME of the file that signs for a wallet, recorded so a
// new, unregistered key file can be noticed; this module never opens it (and the account sandbox hides it anyway).
//
// owner_class decides where a balance lands in the NAV:
//   project           ours to spend
//   founder           the founder's stake; shown apart from project money
//   founder-personal  the founder's own wallets; counted apart, never spent by the operator
//   program-locked    held by one of our programs; leaves only by the program's rules (faucet pot)
//   contract-held     held by one of our contracts (Arc faucet, drip vault, splitter...)
//   external          watched only, never counted
const fs = require('fs');
const path = require('path');

const DIR = '/root/apex-faucet/data/protected/account';
const FILE = path.join(DIR, 'wallet-registry.json');
const CHAINS = new Set(['x1', 'solana', 'arc', 'base']);
const KINDS = new Set(['wallet', 'token-account', 'contract', 'lp-position']);
const OWNER_CLASSES = new Set(['project', 'founder', 'founder-personal', 'program-locked', 'contract-held', 'external']);
const ROLES = new Set(['faucet', 'founder', 'founder-personal', 'arena', 'trader', 'operator', 'receive', 'fee-payer', 'passport-hot',
  'watchtower', 'oracle', 'flux', 'agent', 'citizen', 'campaign', 'game-prize', 'bridge', 'authority', 'escrow', 'contract',
  'program-pda', 'lp-position', 'other']);
const SVM = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

function validAddress(chain, a) { return (chain === 'x1' || chain === 'solana') ? SVM.test(a) : EVM.test(a); }
const norm = (chain, a) => ((chain === 'arc' || chain === 'base') ? String(a).toLowerCase() : String(a));

// Throws with every problem listed; a registry that does not validate is never used.
function validate(reg) {
  const errs = [];
  if (!reg || !Array.isArray(reg.entries)) throw new Error('registry: no entries[]');
  const seen = new Set();
  for (const e of reg.entries) {
    const at = (e.id || '?') + ': ';
    if (!e.id) errs.push('entry without id');
    if (!CHAINS.has(e.chain)) errs.push(at + 'bad chain ' + e.chain);
    if (!KINDS.has(e.kind)) errs.push(at + 'bad kind ' + e.kind);
    if (!OWNER_CLASSES.has(e.owner_class)) errs.push(at + 'bad owner_class ' + e.owner_class);
    if (!ROLES.has(e.role)) errs.push(at + 'bad role ' + e.role);
    if (!validAddress(e.chain, e.address)) errs.push(at + 'bad address for ' + e.chain);
    if (e.kind === 'lp-position' && !/^\d+$/.test(String(e.position_id || ''))) errs.push(at + 'lp-position without position_id');
    if (e.key_file_name && /[\[\]{}]|^\s*\d+\s*,/.test(String(e.key_file_name))) errs.push(at + 'key_file_name looks like key material');
    const k = e.chain + '|' + norm(e.chain, e.address) + '|' + (e.position_id || '');
    if (seen.has(k)) errs.push(at + 'duplicate ' + k);
    seen.add(k);
    if (seen.has('id:' + e.id)) errs.push(at + 'duplicate id');
    seen.add('id:' + e.id);
  }
  if (errs.length) throw new Error('registry invalid (' + errs.length + '): ' + errs.slice(0, 10).join('; '));
  return reg;
}

let _cache = null;
function load(file) {
  const f = file || FILE;
  if (_cache && _cache.f === f) return _cache.reg;
  const reg = validate(JSON.parse(fs.readFileSync(f, 'utf8')));
  _cache = { f, reg };
  return reg;
}

function entries(filter = {}) {
  return load().entries.filter((e) => e.active !== false
    && (!filter.chain || e.chain === filter.chain) && (!filter.kind || e.kind === filter.kind)
    && (!filter.owner_class || e.owner_class === filter.owner_class));
}

function find(chain, address) {
  const a = norm(chain, address);
  return load().entries.filter((e) => e.chain === chain && norm(chain, e.address) === a);
}

// Any registry address that is not merely watched: a transfer between two of these is internal, never revenue or loss.
// Agent and citizen wallets count only if we hold their key and can spend from them (same rule as isOursPayer, Fable
// review v2 #15): value sent to a wallet a renter controls has left us.
function isInternal(chain, address) {
  return find(chain, address).some((e) => e.owner_class !== 'external' && (!(e.role === 'agent' || e.role === 'citizen') || !!(e.spendable && e.key_file_name)));
}

// "Ours" as a PAYER (a payment from it is a test, not a customer). Agent and citizen wallets count only if we hold
// their key and can spend from them; wallets handed to renters are not ours.
function isOursPayer(chain, address) {
  return find(chain, address).some((e) => {
    if (e.owner_class === 'program-locked' || e.owner_class === 'contract-held' || e.owner_class === 'external') return false;
    if (e.role === 'agent' || e.role === 'citizen') return !!(e.spendable && e.key_file_name);
    return e.owner_class === 'project' || e.owner_class === 'founder' || e.owner_class === 'founder-personal';
  });
}

module.exports = { DIR, FILE, CHAINS, OWNER_CLASSES, ROLES, validate, load, entries, find, isInternal, isOursPayer, validAddress, norm };
