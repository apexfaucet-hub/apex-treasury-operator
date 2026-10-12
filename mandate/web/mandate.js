/* Arc Mandate: a spending box with rules for an AI agent, created and controlled from the visitor's OWN wallet.
 * The page sets window.MANDATE = { factory, deployBlock } (the MandateFactory on Arc mainnet and the block it was deployed in).
 * Rules this file keeps:
 *   - every transaction is sent from the connected wallet; the owner of a new box is always that wallet (the contract makes
 *     msg.sender the owner, nothing on this page can change it);
 *   - every transaction is first run as eth_call from the wallet's address: a refusal is shown with its reason, nothing is sent;
 *   - this page and its server never hold the money or any key: USDC goes from the wallet into the owner's own box and back;
 *   - "Take it all back" always sends to the connected wallet, which must be the box owner.
 */
(function () {
  'use strict';
  var CFG = window.MANDATE || {};
  var FACTORY = CFG.factory ? String(CFG.factory).toLowerCase() : null;
  var FROM_BLOCK = Number(CFG.deployBlock || 0);
  var CHAIN = '0x13b2'; // 5042, Arc mainnet
  var USDC = '0x3600000000000000000000000000000000000000';
  var RPCS = (CFG.rpcs && CFG.rpcs.length) ? CFG.rpcs : ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io', 'https://rpc.beamrpc.com'];
  var EXPLORER = 'https://explorer.arc.io/';
  var GAS_RESERVE = 50000n; // 0.05 USDC kept back: on Arc the USDC you put in is also what pays the fees
  var T_CREATED = '0x8702d09efe615a7f0f9696a82a431609752ec99b8ca2a4ee888e7a8d5ee5a81d';
  var T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  var REFUSALS = ['ok', 'no agent set', 'the caller is not the agent', 'paused by the owner', 'the mandate has ended',
    'zero amount', 'over the per-payment limit', 'that payee is not on the list', 'bad payee', 'no payments left today',
    'that slot is already used', 'the signature is not for this transfer', 'not signed by the agent', 'malformed signature'];
  var SEL = {
    create: '0x6fe2f35c', predict: '0x64fb6f5e', isMandate: '0x8a1b6d8b', owner: '0x8da5cb5b', agent: '0xf5ff5c76',
    maxPerPayment: '0x7329966f', maxPaymentsPerDay: '0x779e0c79', expiresAt: '0x8622a689', paused: '0x5c975abb',
    anyPayee: '0x90fdb0ab', isPayee: '0x366653a9', leftToday: '0x3c594844', balance: '0xb69ef8a8', setRules: '0xcd30edbd',
    setPayees: '0x9c849b30', setPaused: '0x16c38b3c', withdrawAll: '0xfa09e630', version: '0xffa1ad74', refused: '0xbd5adfec'
  };

  // ------------------------------------------------------------------ chain helpers
  function rpc(m, p, i) {
    i = i || 0;
    return fetch(RPCS[i], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) { var e = new Error(j.error.message || 'rpc error'); e.data = j.error.data; e.revert = /revert|execution/i.test(e.message) || j.error.code === 3; throw e; }
        return j.result;
      })
      .catch(function (e) { if (e.revert || i + 1 >= RPCS.length) throw e; return rpc(m, p, i + 1); });
  }
  function word(n) { return BigInt(n).toString(16).padStart(64, '0'); }
  function addr(a) { return String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
  function isAddr(a) { return /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim()); }
  function arr(list) { return word(list.length) + list.map(addr).join(''); }
  function call(to, data, from, value) {
    var o = { to: to, data: data };
    if (from) o.from = from;
    if (value) o.value = '0x' + BigInt(value).toString(16);
    return rpc('eth_call', [o, 'latest']);
  }
  function u(hex, k) { return BigInt('0x' + (String(hex).slice(2 + 64 * (k || 0), 2 + 64 * ((k || 0) + 1)) || '0')); }
  function a(hex) { return '0x' + String(hex).slice(26, 66); }
  // "1.5" -> 1500000n (USDC has 6 decimals). Anything else is refused, never guessed.
  function toUnits(s) {
    var m = String(s == null ? '' : s).trim().match(/^(\d{1,12})(?:\.(\d{0,6}))?$/);
    if (!m) return null;
    return BigInt(m[1]) * 1000000n + BigInt((m[2] || '').padEnd(6, '0') || '0');
  }
  function fmt(x) { var s = BigInt(x).toString().padStart(7, '0'); var t = s.slice(0, -6) + '.' + s.slice(-6); return t.replace(/(\.\d\d\d*?)0+$/, '$1'); }
  function short(x) { x = String(x); return x.slice(0, 6) + '…' + x.slice(-4); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function reason(e) {
    var d = e && (e.data && (e.data.data || e.data)) || '';
    if (typeof d === 'string' && d.slice(0, 10) === SEL.refused) return 'Refused by the box: ' + (REFUSALS[Number(u('0x' + d.slice(10)))] || 'reason ' + Number(u('0x' + d.slice(10))));
    var m = String((e && e.message) || e);
    if ((e && e.code === 4001) || /reject|denied|cancel/i.test(m)) return 'Cancelled in the wallet. Nothing was sent.';
    if (/insufficient funds/i.test(m)) return 'Not enough USDC in your wallet for this and the fee.';
    return m.slice(0, 220);
  }
  function provider() {
    var w = window, e = w.ethereum;
    var c = [e && e.providers && e.providers.length ? (e.providers.find(function (p) { return p.isMetaMask; }) || e.providers[0]) : e,
      w.bitkeep && w.bitkeep.ethereum, w.okxwallet, w.trustwallet && w.trustwallet.ethereum];
    for (var i = 0; i < c.length; i++) if (c[i] && typeof c[i].request === 'function') return c[i];
    return null;
  }

  // ------------------------------------------------------------------ wallet
  var eth = null, me = null;
  function connect() {
    if (me) return Promise.resolve(me);
    eth = provider();
    if (!eth) return Promise.reject(new Error('No wallet found in this browser. Open this page in MetaMask, Rabby or another wallet app.'));
    return eth.request({ method: 'eth_requestAccounts' }).then(function (acc) {
      if (!acc || !acc[0]) throw new Error('The wallet gave no account.');
      return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN }] }).catch(function (e) {
        if (e && (e.code === 4902 || /unrecognized|not added|unknown chain/i.test(String(e.message)))) {
          return eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: CHAIN, chainName: 'Arc', rpcUrls: [RPCS[1]],
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, blockExplorerUrls: [EXPLORER] }] });
        }
        throw e;
      }).then(function () { me = String(acc[0]).toLowerCase(); paintMe(); return me; });
    });
  }
  function paintMe() { var el = $('mme'); if (el) el.textContent = me ? 'Connected: ' + short(me) : ''; }
  function waitReceipt(hash, tries) {
    tries = tries || 0;
    return rpc('eth_getTransactionReceipt', [hash]).then(function (r) {
      if (r) { if (r.status !== '0x1') throw new Error('The transaction failed on chain: ' + hash); return r; }
      if (tries > 60) throw new Error('Still waiting for ' + hash + ' after 3 minutes. Check it on the explorer.');
      return new Promise(function (ok) { setTimeout(ok, 3000); }).then(function () { return waitReceipt(hash, tries + 1); });
    });
  }
  // Simulate from the wallet's address, then ask the wallet to sign, then wait for the chain.
  function send(to, data, value, msgEl, label) {
    var tx = { from: me, to: to, data: data };
    if (value) tx.value = '0x' + BigInt(value).toString(16);
    say(msgEl, 'Checking ' + label + ' first…');
    return call(to, data, me, value).then(function () {
      say(msgEl, 'Confirm ' + label + ' in your wallet…');
      return eth.request({ method: 'eth_sendTransaction', params: [tx] });
    }).then(function (hash) {
      say(msgEl, 'Sent. Waiting for Arc… <a href="' + EXPLORER + 'tx/' + hash + '" target="_blank" rel="noopener">' + short(hash) + '</a>', true);
      return waitReceipt(hash).then(function (r) { return { hash: hash, receipt: r }; });
    });
  }
  function say(el, html, raw) { if (el) el.innerHTML = raw ? html : esc(html); }

  // ------------------------------------------------------------------ create
  function readForm() {
    var f = $('mform');
    var agent = f.agent.value.trim();
    var per = toUnits(f.per.value), n = Number(f.n.value), put = toUnits(f.put.value || '0');
    var any = f.any.checked;
    var payees = f.payees.value.split(/[\s,;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var end = f.end.value ? Math.floor(new Date(f.end.value + 'T23:59:59Z').getTime() / 1000) : 0;
    var err = null;
    if (!isAddr(agent)) err = 'The agent address must be a 0x address (the wallet your agent signs with).';
    else if (per == null || per <= 0n) err = 'Write the most one payment may be, in USDC, for example 0.10.';
    else if (!(n >= 1 && n <= 1000 && Math.floor(n) === n)) err = 'Payments per day: a whole number from 1 to 1000.';
    else if (!any && !payees.length) err = 'Add at least one payee address, or tick "any service".';
    else if (payees.some(function (p) { return !isAddr(p); })) err = 'One of the payee lines is not a 0x address.';
    else if (!end || end <= Date.now() / 1000) err = 'Pick an end date in the future.';
    else if (end > Date.now() / 1000 + 3650 * 86400) err = 'The end date can be at most ten years away.';
    else if (put == null) err = 'The amount to put in must be a number, for example 2.';
    return { err: err, agent: agent, per: per, n: n, any: any, payees: any ? [] : payees, end: end, put: put || 0n };
  }
  function summary() {
    var r = readForm(), el = $('msum');
    if (r.err) { el.textContent = ''; return; }
    var day = r.per * BigInt(r.n);
    el.textContent = 'Your agent can pay at most ' + fmt(r.per) + ' USDC at a time and ' + r.n + ' times a day (at most ' + fmt(day) +
      ' USDC a day), ' + (r.any ? 'to any address' : 'only to the ' + r.payees.length + ' payee' + (r.payees.length > 1 ? 's' : '') + ' you listed') +
      ', until ' + new Date(r.end * 1000).toISOString().slice(0, 10) + '. You can stop it or take everything back at any time.';
  }
  function create() {
    var msg = $('mmsg');
    if (!FACTORY) { say(msg, 'Not open yet: the contract is being reviewed before anyone puts money in.'); return; }
    var r = readForm();
    if (r.err) { say(msg, r.err); return; }
    var salt = new Uint8Array(32); crypto.getRandomValues(salt);
    var saltHex = Array.prototype.map.call(salt, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    var value = r.put * 1000000000000n; // 6 -> 18 decimals: native USDC
    connect().then(function () {
      return rpc('eth_getBalance', [me, 'latest']).then(function (b) {
        if (BigInt(b) < value + GAS_RESERVE * 1000000000000n) throw new Error('Your wallet has ' + fmt(BigInt(b) / 1000000000000n) + ' USDC. Keep about 0.05 for fees.');
      });
    }).then(function () {
      return call(FACTORY, SEL.predict + addr(me) + saltHex);
    }).then(function (p) {
      var box = a(p);
      var data = SEL.create + saltHex + addr(r.agent) + word(r.per) + word(r.n) + word(r.end) + word(r.any ? 1 : 0) + word(7 * 32) + arr(r.payees);
      return send(FACTORY, data, value, msg, 'creating your box').then(function (res) {
        remember(box);
        say(msg, 'Your box is live: <a href="' + EXPLORER + 'address/' + box + '" target="_blank" rel="noopener">' + esc(box) + '</a>. Give this address to your agent.', true);
        return showBox(box);
      });
    }).catch(function (e) { say(msg, reason(e)); });
  }

  // ------------------------------------------------------------------ boxes
  function remember(box) { try { var k = 'arc-mandate-boxes'; var l = JSON.parse(localStorage.getItem(k) || '[]'); if (l.indexOf(box) < 0) l.push(box); localStorage.setItem(k, JSON.stringify(l.slice(-20))); } catch (e) {} }
  function remembered() { try { return JSON.parse(localStorage.getItem('arc-mandate-boxes') || '[]'); } catch (e) { return []; } }

  // Our server's record of the chain (tools/arc-mandate-index.js, every 10 min): boxes and the USDC that left them. Arc's public
  // nodes keep ~70 h of logs and refuse wide ranges, so the browser alone could not list older boxes or payments. Used when it
  // is fresh (under an hour old) and for this factory; otherwise the page reads the chain itself.
  var INDEX = null;
  function index() {
    if (INDEX) return INDEX;
    INDEX = fetch('/arc/mandate/index.json?t=' + Math.floor(Date.now() / 300000), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return j && FACTORY && String(j.factory).toLowerCase() === FACTORY && Date.now() - Date.parse(j.updatedAt) < 3600000 ? j : null; })
      .catch(function () { return null; });
    return INDEX;
  }
  // Boxes this wallet owns: from the index, else MandateCreated(box, owner, agent) logs read in chunks Arc RPCs accept.
  function findMine() {
    if (!FACTORY || !me) return Promise.resolve([]);
    return index().then(function (ix) {
      if (ix) return ix.boxes.filter(function (b) { return String(b.owner).toLowerCase() === me; }).map(function (b) { return b.box; });
      return findMineOnChain();
    });
  }
  function findMineOnChain() {
    return rpc('eth_blockNumber', []).then(function (h) {
      var head = Number(h), out = [], from = FROM_BLOCK || Math.max(0, head - 90000), step = 90000;
      function next(start) {
        if (start > head) return Promise.resolve(out);
        var end = Math.min(head, start + step);
        return rpc('eth_getLogs', [{ address: FACTORY, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16), topics: [T_CREATED, null, '0x' + addr(me)] }])
          .then(function (logs) { logs.forEach(function (l) { out.push('0x' + l.topics[1].slice(26)); }); return next(end + 1); });
      }
      return next(from);
    });
  }
  function readBox(box) {
    var r = function (sel) { return call(box, sel); };
    return Promise.all([r(SEL.owner), r(SEL.agent), r(SEL.maxPerPayment), r(SEL.maxPaymentsPerDay), r(SEL.expiresAt), r(SEL.paused),
      r(SEL.anyPayee), r(SEL.leftToday), r(SEL.balance), FACTORY ? call(FACTORY, SEL.isMandate + addr(box)) : Promise.resolve('0x' + word(1))])
      .then(function (v) {
        return { box: box.toLowerCase(), owner: a(v[0]), agent: a(v[1]), per: u(v[2]), n: Number(u(v[3])), end: Number(u(v[4])), paused: u(v[5]) === 1n,
          any: u(v[6]) === 1n, left: Number(u(v[7], 0)), leftValue: u(v[7], 1), balance: u(v[8]), genuine: u(v[9]) === 1n };
      });
  }
  // Money that left the box: USDC Transfer logs from the box (agent payments by either path, and withdrawals). From the index when
  // it knows the box, else the chain's last ~12 h (the widest range the public nodes serve in one read).
  function outflows(box) {
    var b = String(box).toLowerCase();
    return index().then(function (ix) {
      if (ix && ix.boxes.some(function (x) { return x.box === b; })) {
        return (ix.outflows[b] || []).slice(0, 8).map(function (o) { return { to: o.to, value: BigInt(o.value), tx: o.tx }; });
      }
      return outflowsOnChain(box);
    });
  }
  function outflowsOnChain(box) {
    return rpc('eth_blockNumber', []).then(function (h) {
      var head = Number(h), from = Math.max(FROM_BLOCK || 0, head - 90000);
      return rpc('eth_getLogs', [{ address: USDC, fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16), topics: [T_TRANSFER, '0x' + addr(box)] }]);
    }).then(function (logs) {
      return logs.slice(-8).reverse().map(function (l) { return { to: '0x' + l.topics[2].slice(26), value: BigInt(l.data), tx: l.transactionHash }; });
    }).catch(function () { return null; });
  }
  function showBox(box) {
    var wrap = $('mboxes');
    var id = 'b' + box.toLowerCase().slice(2, 12);
    var card = $(id);
    if (!card) { card = document.createElement('div'); card.className = 'mcard'; card.id = id; card.setAttribute('data-keep-color', ''); wrap.insertBefore(card, wrap.firstChild); }
    card.innerHTML = '<p class="soft">Reading ' + esc(short(box)) + ' from Arc…</p>';
    return Promise.all([readBox(box), outflows(box)]).then(function (x) {
      var b = x[0], outs = x[1];
      var mine = me && b.owner === me;
      var state = b.paused ? 'STOPPED by the owner' : (b.end <= Date.now() / 1000 ? 'ENDED' : (b.agent === '0x0000000000000000000000000000000000000000' ? 'NO AGENT' : 'ACTIVE'));
      var h = '<p class="mst"><b>' + esc(state) + '</b> · <a href="' + EXPLORER + 'address/' + b.box + '" target="_blank" rel="noopener">' + esc(short(b.box)) + '</a>' +
        (b.genuine ? '' : ' · <b>not made by our factory: do not trust this page for it</b>') + '</p>' +
        '<div class="mfacts"><div><b>' + fmt(b.balance) + '</b><span>USDC in the box</span></div>' +
        '<div><b>' + fmt(b.per) + '</b><span>most per payment</span></div>' +
        '<div><b>' + b.left + ' of ' + b.n + '</b><span>payments left today (UTC)</span></div>' +
        '<div><b>' + new Date(b.end * 1000).toISOString().slice(0, 10) + '</b><span>ends</span></div></div>' +
        '<p class="soft">Agent ' + esc(b.agent) + ' · pays ' + (b.any ? 'any address' : 'only listed payees') + ' · owner ' + esc(short(b.owner)) + (mine ? ' (you)' : '') + '</p>';
      if (outs && outs.length) {
        h += '<p class="soft" style="margin:6px 0 2px">Money out, newest first:</p><ul class="mout">' + outs.map(function (o) {
          return '<li>' + fmt(o.value) + ' USDC to ' + esc(short(o.to)) + ' · <a href="' + EXPLORER + 'tx/' + o.tx + '" target="_blank" rel="noopener">tx</a></li>';
        }).join('') + '</ul>';
      }
      if (mine) {
        h += '<p class="mbtns"><button type="button" class="pb" data-act="pause">' + (b.paused ? 'Let the agent pay again' : 'Stop the agent now') + '</button> ' +
          '<button type="button" class="pb" data-act="add">Put money in</button> ' +
          '<button type="button" class="pb" data-act="back">Take it all back</button> ' +
          '<button type="button" class="pb" data-act="payee">Add a payee</button></p>' +
          '<p class="mmsg2"></p>';
      }
      card.innerHTML = h;
      if (mine) wire(card, b);
    }).catch(function (e) { card.innerHTML = '<p>Could not read this box: ' + esc(reason(e)) + '</p>'; });
  }
  function wire(card, b) {
    var msg = card.querySelector('.mmsg2');
    card.querySelectorAll('button[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-act');
        connect().then(function () {
          if (b.owner !== me) throw new Error('Only the owner can do this. Connected: ' + short(me));
          if (act === 'pause') return send(b.box, SEL.setPaused + word(b.paused ? 0 : 1), 0n, msg, b.paused ? 'letting the agent pay again' : 'stopping the agent');
          if (act === 'back') return send(b.box, SEL.withdrawAll + addr(me), 0n, msg, 'taking everything back to your wallet');
          if (act === 'add') {
            var amt = toUnits(window.prompt('How much USDC to put in?', '1'));
            if (amt == null || amt <= 0n) throw new Error('Nothing put in.');
            return send(b.box, '0x', amt * 1000000000000n, msg, 'putting ' + fmt(amt) + ' USDC in');
          }
          if (act === 'payee') {
            var p = String(window.prompt('Payee address the agent may pay (0x…)', '') || '').trim();
            if (!isAddr(p)) throw new Error('Not a 0x address. Nothing changed.');
            return send(b.box, SEL.setPayees + word(64) + word(64 + 64) + arr([p]) + arr([]), 0n, msg, 'adding ' + short(p) + ' as a payee');
          }
        }).then(function (res) { if (res) return showBox(b.box); }).catch(function (e) { say(msg, reason(e)); });
      });
    });
  }

  // ------------------------------------------------------------------ wiring
  function init() {
    var f = $('mform');
    if (!f) return;
    var d = new Date(Date.now() + 30 * 86400000); f.end.value = d.toISOString().slice(0, 10);
    ['input', 'change'].forEach(function (ev) { f.addEventListener(ev, summary); });
    summary();
    f.addEventListener('submit', function (ev) { ev.preventDefault(); create(); });
    $('mmine').addEventListener('click', function () {
      var msg = $('mminemsg');
      connect().then(function () { say(msg, 'Looking for your boxes on Arc…'); return findMine(); }).then(function (list) {
        var all = list.concat(remembered()).map(function (x) { return x.toLowerCase(); }).filter(function (x, i, s) { return s.indexOf(x) === i; });
        say(msg, all.length ? '' : 'No box yet for ' + short(me) + '.');
        return Promise.all(all.map(showBox));
      }).catch(function (e) { say(msg, reason(e)); });
    });
    $('mopen').addEventListener('click', function () {
      var v = String($('mopenaddr').value || '').trim();
      if (!isAddr(v)) { say($('mminemsg'), 'Paste a box address (0x…).'); return; }
      showBox(v);
    });
    $('mgo').addEventListener('click', function () { $('create').scrollIntoView({ behavior: 'smooth' }); setTimeout(function () { f.agent.focus(); }, 400); });
    if (!FACTORY) { var st = $('mstate'); if (st) st.style.display = ''; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
