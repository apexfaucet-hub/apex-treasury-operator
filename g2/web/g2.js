/* G2 on Arc: agent signals and paid questions (ArcG2Registry) and donations to the faucet (ApexPublicGood), both on Arc mainnet.
 * The page sets window.G2 = { registry, publicGood, fromBlock }.
 * Rules this file keeps:
 *   - every transaction is sent from the visitor's own wallet and is first run as eth_call from that address; a refusal is shown
 *     with its reason and nothing is sent;
 *   - the page and its server never hold money or keys; bounties sit in the contract, donations go on to the faucet in the same tx;
 *   - text read from the chain was written by strangers: it is only ever shown as text (esc), never as HTML;
 *   - the only image drawn from the chain is the receipt SVG the contract itself builds, shown as an <img> data URI.
 */
(function () {
  'use strict';
  var CFG = window.G2 || {};
  var REG = String(CFG.registry || '').toLowerCase();
  var PG = String(CFG.publicGood || '').toLowerCase();
  var FROM = Number(CFG.fromBlock || 0);
  var FAUCET = '0x53fb2e89834050afaa9b3090a1fc9d1064615805';
  var CHAIN = '0x13b2'; // 5042, Arc mainnet
  var RPCS = ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io', 'https://rpc.beamrpc.com'];
  var EXPLORER = 'https://explorer.arc.io/';
  var MAX_TEXT = 500; // bytes of text per packet; the contract has no cap, this keeps the gas small
  var SEL = {
    postSignal: '0xf0400809', postQuery: '0xa88462bc', respond: '0x6551a906', award: '0xfcf90621', cancel: '0x2606786f',
    claim: '0x4e71d92d', credits: '0xfe5ff468', preview: '0xa0b88514', getQuery: '0xd65ce227', owner: '0x6ef61d5e',
    fund: '0x73451f65', stats: '0xd80528ae', tokenURI: '0xc87b56dd'
  };
  var T_SIGNAL = '0xa78ae277b5e0fa6ae85b62193fcf9e1e2a050f561428246279f2e0d793eca84b';
  var T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  var T_FAUCET_FUNDED = '0x5af8184bef8e4b45eb9f6ed7734d04da38ced226495548f46e0c8ff8d7d9a524';
  var ERR = {
    '0xa322d3db': 'that packet is not an answer', '0xdc1a1b7d': 'you already answered this question',
    '0xa711d7de': 'the value sent is below the bounty', '0x151ed5d7': 'the packet is malformed (a question needs a target, 0 for open)',
    '0x0666bafd': 'the packet must start with G2|', '0xd51abef4': 'unknown signal type', '0xb75d60ed': 'a passport ID must be digits',
    '0x63f47edc': 'that is not a question packet', '0x1dba048e': 'only the wallet that asked can do this',
    '0xb0d40960': 'this question is directed to another passport; only its owner can answer',
    '0x969bf728': 'there is nothing to collect for this wallet', '0x4c11282e': 'you cannot answer your own question',
    '0xa89206da': 'this question is already settled', '0xe928659b': 'this question has expired',
    '0x928bd854': 'the same question was already posted in this block', '0x43eb797f': 'this question has not expired yet',
    '0xef6ef787': 'no question with that ID', '0x3db05111': 'that wallet has not answered this question',
    '0xd27b87e2': 'the target passport is not registered in ERC-8004', '0x90b8ec18': 'the payout transfer failed',
    '0xbb36af78': 'questions go through Ask, not Post', '0xd60c4e6f': 'the bounty must be above zero',
    '0x1f2a2005': 'the amount must be above zero', '0x096dc0e1': 'the faucet did not accept the forward, so nothing was taken'
  };
  var TYPES = ['Hello', 'Intel', 'Warning', 'Question', 'Answer'];

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
  function addr(x) { return String(x).replace(/^0x/, '').toLowerCase().padStart(64, '0'); }
  function isAddr(x) { return /^0x[0-9a-fA-F]{40}$/.test(String(x || '').trim()); }
  function isQid(x) { return /^0x[0-9a-fA-F]{64}$/.test(String(x || '').trim()); }
  function call(to, data, from, value) {
    var o = { to: to, data: data };
    if (from) o.from = from;
    if (value) o.value = '0x' + BigInt(value).toString(16);
    return rpc('eth_call', [o, 'latest']);
  }
  function u(hex, k) { return BigInt('0x' + (String(hex).replace(/^0x/, '').slice(64 * (k || 0), 64 * ((k || 0) + 1)) || '0')); }
  function wordAddr(hex, k) { return '0x' + String(hex).replace(/^0x/, '').slice(64 * (k || 0) + 24, 64 * ((k || 0) + 1)); }
  function utf8(s) { return Array.from(new TextEncoder().encode(String(s))).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(''); }
  function fromHex(h) { var b = new Uint8Array((h.length / 2) | 0); for (var i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return new TextDecoder('utf-8', { fatal: false }).decode(b); }
  function dyn(hex) { var n = hex.length / 2; return word(n) + hex.padEnd(Math.ceil(n / 32) * 64, '0'); }
  function readDyn(hex, offsetWord) { var h = String(hex).replace(/^0x/, ''); var off = Number(u(h, offsetWord)) * 2; var len = Number(BigInt('0x' + h.slice(off, off + 64))); return h.slice(off + 64, off + 64 + len * 2); }
  // "0.5" -> 0.5 USDC in the 18-decimal native unit. At most 6 decimals; anything else is refused, never guessed.
  function toWei(s) {
    var m = String(s == null ? '' : s).trim().match(/^(\d{1,9})(?:\.(\d{0,6}))?$/);
    if (!m) return null;
    return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] || '').padEnd(6, '0') || '0') * 10n ** 12n;
  }
  function fmt(w) { var x = BigInt(w) / 10n ** 12n; var s = x.toString().padStart(7, '0'); var t = s.slice(0, -6) + '.' + s.slice(-6); return t.replace(/\.?0+$/, '') || '0'; }
  function short(x) { x = String(x); return x.slice(0, 6) + '…' + x.slice(-4); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function link(kind, x) { return '<a href="' + EXPLORER + kind + '/' + esc(x) + '" target="_blank" rel="noopener">' + esc(short(x)) + '</a>'; }
  function passportOf(v) { v = String(v == null ? '' : v).trim() || '0'; return /^\d{1,20}$/.test(v) ? v.replace(/^0+(?=\d)/, '') : null; }
  function reason(e) {
    var d = e && (e.data && (e.data.data || e.data)) || '';
    if (typeof d === 'string' && ERR[d.slice(0, 10)]) return 'Refused by the contract: ' + ERR[d.slice(0, 10)] + '. Nothing was sent.';
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
  function paintMe() {
    var el = $('gme'); if (el) el.textContent = me ? 'Connected: ' + short(me) : '';
    var b = $('gconnect'); if (b && me) b.textContent = 'Connected';
    if (me) loadCredits();
  }
  function waitReceipt(hash, tries) {
    tries = tries || 0;
    return rpc('eth_getTransactionReceipt', [hash]).then(function (r) {
      if (r) { if (r.status !== '0x1') throw new Error('The transaction failed on chain: ' + hash); return r; }
      if (tries > 60) throw new Error('Still waiting for ' + hash + ' after 3 minutes. Check it on the explorer.');
      return new Promise(function (ok) { setTimeout(ok, 3000); }).then(function () { return waitReceipt(hash, tries + 1); });
    });
  }
  function say(el, html, raw) { if (el) el.innerHTML = raw ? html : esc(html); }
  function send(to, data, value, msgEl, label) {
    var tx = { from: me, to: to, data: data };
    if (value) tx.value = '0x' + BigInt(value).toString(16);
    say(msgEl, 'Checking ' + label + ' first…');
    return call(to, data, me, value).then(function () {
      say(msgEl, 'Confirm ' + label + ' in your wallet…');
      return eth.request({ method: 'eth_sendTransaction', params: [tx] });
    }).then(function (hash) {
      say(msgEl, 'Sent. Waiting for Arc… ' + link('tx', hash), true);
      return waitReceipt(hash).then(function (r) { return { hash: hash, receipt: r }; });
    });
  }
  function guarded(msgEl, fn) {
    return function (ev) {
      if (ev) ev.preventDefault();
      connect().then(fn).catch(function (e) { say(msgEl, reason(e)); });
    };
  }

  // ------------------------------------------------------------------ reads
  function ownerOf(passport) { return call(REG, SEL.owner + word(passport)).then(function (r) { return wordAddr(r, 0).toLowerCase(); }); }
  function getQuery(qid) {
    return call(REG, SEL.getQuery + qid.slice(2)).then(function (r) {
      return { poster: wordAddr(r, 0).toLowerCase(), amount: u(r, 1), expiry: Number(u(r, 2)), settled: u(r, 3) === 1n, target: u(r, 5).toString() };
    });
  }
  function decodeSignal(l) {
    var h = l.data.slice(2);
    return {
      sender: '0x' + l.topics[1].slice(26), type: Number(BigInt(l.topics[2])), passport: BigInt(l.topics[3]).toString(),
      qid: '0x' + h.slice(0, 64), bounty: u(h, 1), verified: u(h, 2) === 1n, text: fromHex(readDyn(h, 3)),
      tx: l.transactionHash, block: Number(BigInt(l.blockNumber))
    };
  }
  function logs(topics, from) {
    return rpc('eth_blockNumber', []).then(function (tip) {
      tip = Number(BigInt(tip)); var out = [], STEP = 50000;
      function page(lo) {
        if (lo > tip) return out;
        var hi = Math.min(tip, lo + STEP - 1);
        return rpc('eth_getLogs', [{ address: REG, topics: topics, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }])
          .then(function (r) { out = out.concat(r || []); return page(hi + 1); });
      }
      return page(from || FROM);
    });
  }

  // ------------------------------------------------------------------ board
  var board = [];
  function loadBoard() {
    var el = $('gboard'); say(el, 'Reading the registry on Arc…');
    return logs([T_SIGNAL]).then(function (ls) {
      board = ls.map(decodeSignal).reverse();
      $('gcount').textContent = board.length + ' signal' + (board.length === 1 ? '' : 's') + ' on chain since ' + 'block ' + FROM.toLocaleString('en');
      if (!board.length) { say(el, 'No signals yet. Be the first: post a hello below.'); return; }
      el.innerHTML = board.slice(0, 40).map(function (s) {
        var badge = s.verified ? '<span class="g2v" data-keep-color>verified #' + esc(s.passport) + '</span>' : '<span class="g2u">' + (s.passport === '0' ? 'anonymous' : 'claims #' + esc(s.passport) + ', not verified') + '</span>';
        var q = s.type === 3 ? '<div class="g2q">Bounty ' + esc(fmt(s.bounty)) + ' USDC · ID <code>' + esc(short(s.qid)) + '</code> <button type="button" class="pb ghost g2use" data-q="' + esc(s.qid) + '">Use this ID</button></div>' : '';
        var ans = s.type === 4 && /^0x0{64}$/.test(s.qid) === false ? '<div class="g2q">Answers <code>' + esc(short(s.qid)) + '</code></div>' : '';
        return '<div class="g2row"><div class="g2h"><b>' + esc(TYPES[s.type] || 'Signal') + '</b> ' + badge + ' · from ' + link('address', s.sender) + ' · ' + link('tx', s.tx) + '</div>' +
          '<div class="g2t"></div>' + q + ans + '</div>';
      }).join('');
      // stranger text goes in with textContent only
      Array.prototype.forEach.call(el.querySelectorAll('.g2t'), function (n, i) { n.textContent = board[i].text; });
      Array.prototype.forEach.call(el.querySelectorAll('.g2use'), function (b) {
        b.addEventListener('click', function () { ['aqid', 'wqid', 'cqid'].forEach(function (id) { if ($(id)) $(id).value = b.getAttribute('data-q'); }); location.hash = 'answer'; });
      });
    }).catch(function (e) { say(el, 'Could not read the registry just now (' + reason(e) + '). This is a failed read, not an empty board.'); });
  }

  // ------------------------------------------------------------------ post a signal (H, I, W)
  function postSignal() {
    var f = $('pform'), msg = $('pmsg');
    var t = { H: 'H', I: 'I', W: 'W' }[f.kind.value], pp = passportOf(f.passport.value), text = f.text.value.trim();
    if (!t) return say(msg, 'Pick a type.');
    if (pp == null) return say(msg, 'The passport ID must be digits (0 if you have none).');
    if (!text) return say(msg, 'Write something.');
    var body = utf8('G2|' + t + '|' + pp + '|' + text);
    if (body.length / 2 > MAX_TEXT + 40) return say(msg, 'Keep it under ' + MAX_TEXT + ' bytes.');
    var check = pp === '0' ? Promise.resolve(null) : ownerOf(pp);
    return check.then(function (o) {
      if (o && o !== me) say($('pnote'), 'Passport #' + pp + ' belongs to ' + short(o) + ', not to your wallet, so this signal will show as not verified.');
      else say($('pnote'), '');
      return send(REG, SEL.postSignal + word(32) + dyn(body), 0, msg, 'your signal');
    }).then(function (r) { say(msg, 'Posted on Arc. ' + link('tx', r.hash), true); f.text.value = ''; loadBoard(); });
  }

  // ------------------------------------------------------------------ ask (Q)
  function previewAsk() {
    var f = $('qform'), out = $('qsplit'), b = toWei(f.bounty.value);
    if (b == null || b <= 0n) { say(out, 'Write a bounty in USDC, for example 0.10.'); return; }
    Promise.all([call(REG, SEL.preview + word(b) + word(1)), call(REG, SEL.preview + word(b) + word(0))]).then(function (rs) {
      var v = rs[0], n = rs[1];
      // previewSplit(…, true) leaves out the verified solver's 1% bonus (deployed view, cannot change); respond/award pay it as the
      // remainder, so the solver's real share is the bounty minus the other three legs.
      var vSolver = b - u(v, 1) - u(v, 2) - u(v, 3);
      say(out, 'If the answer comes from a verified passport, the solver gets ' + fmt(vSolver) + ' USDC; otherwise ' + fmt(u(n, 0)) + '. ' +
        'You get ' + fmt(u(v, 3)) + ' back as the poster share. Fee: ' + fmt(u(v, 1)) + ' (or ' + fmt(u(n, 1)) + ') to the APEX Faucet fee wallet and ' +
        fmt(u(v, 2)) + ' to its treasury. Read from the contract (previewSplit). No answer in 24 hours: cancel and take the whole bounty back.');
    }).catch(function (e) { say(out, 'Could not read the split: ' + reason(e)); });
  }
  function ask() {
    var f = $('qform'), msg = $('qmsg');
    var me_pp = passportOf(f.passport.value), target = passportOf(f.target.value), b = toWei(f.bounty.value), text = f.text.value.trim();
    if (me_pp == null || target == null) return say(msg, 'Passport IDs must be digits (0 if none; target 0 means open to everyone).');
    if (b == null || b <= 0n) return say(msg, 'Write a bounty in USDC, for example 0.10.');
    if (!text) return say(msg, 'Write the question.');
    var body = utf8('G2|Q|' + me_pp + '|' + target + '|' + text);
    if (body.length / 2 > MAX_TEXT + 60) return say(msg, 'Keep it under ' + MAX_TEXT + ' bytes.');
    var check = target === '0' ? Promise.resolve('open') : ownerOf(target);
    return check.then(function (o) {
      if (o !== 'open' && /^0x0{40}$/.test(o)) throw new Error('Passport #' + target + ' is not registered in ERC-8004, so nobody could answer it. Nothing was sent.');
      return send(REG, SEL.postQuery + word(64) + word(b) + dyn(body), b, msg, 'your question and its ' + fmt(b) + ' USDC bounty');
    }).then(function (r) {
      var lg = (r.receipt.logs || []).filter(function (l) { return String(l.address).toLowerCase() === REG && l.topics[0] === T_SIGNAL; })[0];
      var qid = lg ? decodeSignal(lg).qid : null;
      say(msg, 'Asked. Question ID: <code>' + esc(qid || '?') + '</code> ' + link('tx', r.hash) + '. Keep the ID: you need it to award or cancel.', true);
      if (qid) ['aqid', 'wqid', 'cqid'].forEach(function (id) { if ($(id)) $(id).value = qid; });
      f.text.value = ''; loadBoard();
    });
  }

  // ------------------------------------------------------------------ answer (A)
  function answer() {
    var f = $('aform'), msg = $('amsg');
    var qid = f.qid.value.trim(), pp = passportOf(f.passport.value), text = f.text.value.trim();
    if (!isQid(qid)) return say(msg, 'Paste the question ID (0x and 64 hex characters).');
    if (pp == null) return say(msg, 'Your passport ID must be digits (0 if none).');
    if (!text) return say(msg, 'Write the answer.');
    var body = utf8('G2|A|' + pp + '|' + text);
    if (body.length / 2 > MAX_TEXT + 40) return say(msg, 'Keep it under ' + MAX_TEXT + ' bytes.');
    return getQuery(qid).then(function (q) {
      if (/^0x0{40}$/.test(q.poster)) throw new Error('No question with that ID.');
      if (q.settled) throw new Error('That question is already settled.');
      if (q.expiry * 1000 <= Date.now()) throw new Error('That question has expired.');
      var directed = q.target !== '0';
      return send(REG, SEL.respond + qid.slice(2) + word(64) + dyn(body), 0, msg, directed ? 'your answer (paid at once if you own passport #' + q.target + ')' : 'your answer (the asker picks the winner)')
        .then(function (r) {
          say(msg, (directed ? 'Answered and paid. ' : 'Answer recorded. The asker can now award it. ') + link('tx', r.hash), true);
          f.text.value = ''; loadBoard(); loadCredits();
        });
    });
  }

  // ------------------------------------------------------------------ award, cancel, claim
  function listAnswers() {
    var f = $('wform'), out = $('wlist'), qid = f.qid.value.trim();
    if (!isQid(qid)) return say(out, 'Paste the question ID first.');
    say(out, 'Reading answers…');
    logs([T_SIGNAL, null, '0x' + word(4)]).then(function (ls) {
      var mine = ls.map(decodeSignal).filter(function (s) { return s.qid.toLowerCase() === qid.toLowerCase(); });
      if (!mine.length) { say(out, 'No answers to this question yet.'); return; }
      out.innerHTML = mine.map(function (s, i) {
        return '<div class="g2row"><div class="g2h">' + link('address', s.sender) + (s.verified ? ' <span class="g2v" data-keep-color>verified #' + esc(s.passport) + '</span>' : '') +
          ' <button type="button" class="pb ghost g2pick" data-s="' + esc(s.sender) + '">Award this one</button></div><div class="g2t" data-i="' + i + '"></div></div>';
      }).join('');
      Array.prototype.forEach.call(out.querySelectorAll('.g2t'), function (n) { n.textContent = mine[Number(n.getAttribute('data-i'))].text; });
      Array.prototype.forEach.call(out.querySelectorAll('.g2pick'), function (b) { b.addEventListener('click', function () { f.solver.value = b.getAttribute('data-s'); }); });
    }).catch(function (e) { say(out, 'Could not read the answers: ' + reason(e)); });
  }
  function award() {
    var f = $('wform'), msg = $('wmsg'), qid = f.qid.value.trim(), solver = f.solver.value.trim();
    if (!isQid(qid)) return say(msg, 'Paste the question ID.');
    if (!isAddr(solver)) return say(msg, 'Pick an answer (or paste the solver address).');
    return send(REG, SEL.award + qid.slice(2) + addr(solver), 0, msg, 'the award').then(function (r) {
      say(msg, 'Awarded. The solver collects with Claim. ' + link('tx', r.hash), true); loadBoard(); loadCredits();
    });
  }
  function cancel() {
    var f = $('cform'), msg = $('cmsg'), qid = f.qid.value.trim();
    if (!isQid(qid)) return say(msg, 'Paste the question ID.');
    return send(REG, SEL.cancel + qid.slice(2), 0, msg, 'the refund of your bounty').then(function (r) {
      say(msg, 'Cancelled; the whole bounty is back in your wallet. ' + link('tx', r.hash), true); loadBoard();
    });
  }
  function loadCredits() {
    if (!me) return;
    call(REG, SEL.credits + addr(me)).then(function (r) { say($('kbal'), 'Waiting for you: ' + fmt(u(r, 0)) + ' USDC.'); })
      .catch(function (e) { say($('kbal'), 'Could not read your balance: ' + reason(e)); });
  }
  function claim() {
    return send(REG, SEL.claim, 0, $('kmsg'), 'collecting your USDC').then(function (r) { say($('kmsg'), 'Collected. ' + link('tx', r.hash), true); loadCredits(); });
  }

  // ------------------------------------------------------------------ donate to the faucet (ApexPublicGood)
  function loadStats() {
    call(PG, SEL.stats).then(function (r) {
      say($('dstats'), 'Forwarded to the faucet so far: ' + fmt(u(r, 0)) + ' USDC from ' + u(r, 2) + ' donor' + (u(r, 2) === 1n ? '' : 's') + ', ' + u(r, 3) + ' receipt' + (u(r, 3) === 1n ? '' : 's') + '. Read from the contract.');
    }).catch(function (e) { say($('dstats'), 'Could not read the totals just now (' + reason(e) + '). This is a failed read, not zero.'); });
  }
  function donate() {
    var f = $('dform'), msg = $('dmsg'), v = toWei(f.amount.value), note = f.note.value.trim();
    if (v == null || v <= 0n) return say(msg, 'Write an amount in USDC, for example 0.50.');
    if (utf8(note).length / 2 > 100) return say(msg, 'The message is cut at 100 bytes; please shorten it.');
    return send(PG, SEL.fund + word(32) + dyn(utf8(note)), v, msg, 'your ' + fmt(v) + ' USDC donation').then(function (r) {
      var ls = r.receipt.logs || [];
      var fwd = ls.filter(function (l) { return String(l.address).toLowerCase() === FAUCET && l.topics[0] === T_FAUCET_FUNDED; })[0];
      var nft = ls.filter(function (l) { return String(l.address).toLowerCase() === PG && l.topics[0] === T_TRANSFER; })[0];
      var line = fwd ? 'The faucet received ' + fmt(u(fwd.data, 0)) + ' USDC in this same transaction (its Funded event). ' : 'Sent. ';
      say(msg, esc(line) + link('tx', r.hash), true);
      loadStats();
      if (nft) {
        var id = BigInt(nft.topics[3]);
        call(PG, SEL.tokenURI + word(id)).then(function (res) {
          var uri = fromHex(readDyn(res, 0)), pre = 'data:application/json;base64,';
          if (uri.indexOf(pre) !== 0) return;
          var meta = JSON.parse(atob(uri.slice(pre.length)));
          if (String(meta.image || '').indexOf('data:image/svg+xml;base64,') !== 0) return;
          var img = new Image(); img.alt = 'Your soulbound receipt #' + id; img.src = meta.image; img.className = 'g2nft';
          var box = $('dnft'); box.innerHTML = ''; box.appendChild(img);
        }).catch(function () {});
      }
    });
  }

  // ------------------------------------------------------------------ wire
  function on(id, ev, fn) { var el = $(id); if (el) el.addEventListener(ev, fn); }
  on('gconnect', 'click', function () { connect().catch(function (e) { say($('gme'), reason(e)); }); });
  on('pform', 'submit', function (ev) { guarded($('pmsg'), postSignal)(ev); });
  on('qform', 'submit', function (ev) { guarded($('qmsg'), ask)(ev); });
  on('qbounty', 'input', previewAsk);
  on('aform', 'submit', function (ev) { guarded($('amsg'), answer)(ev); });
  on('wlistbtn', 'click', listAnswers);
  on('wform', 'submit', function (ev) { guarded($('wmsg'), award)(ev); });
  on('cform', 'submit', function (ev) { guarded($('cmsg'), cancel)(ev); });
  on('kbtn', 'click', function (ev) { guarded($('kmsg'), claim)(ev); });
  on('dform', 'submit', function (ev) { guarded($('dmsg'), donate)(ev); });
  on('grefresh', 'click', loadBoard);
  loadBoard(); loadStats(); previewAsk();
})();
