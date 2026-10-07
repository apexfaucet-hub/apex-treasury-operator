/* Rate on Arc (2026-10-07). Any visitor rates an ERC-8004 agent from their OWN wallet, written straight to Arc's
 * Reputation Registry. Usage: <div class="apx-rate" data-agent="1" data-name="APEX Faucet"></div>
 * plus <script src="/arc/rate.js?v=1" defer></script>.
 * - The score shown is read from the registry in the browser (eth_call to rpc.mainnet.arc.io); a failed read says so, never 0.
 * - We never rate ourselves: wallets that belong to this project (public/arc/rate-ours.json, SHA-256 only) are refused here,
 *   and the contract itself refuses an agent's owner or operator.
 * - No default score: the visitor picks one. Tags: tag1 "quality", tag2 "apexfaucet.xyz" (same as /api/arc/rate-us since 2 Oct).
 */
(function () {
  'use strict';
  var REG = '0x8004baa17c55a88189ae136b182e5fda19de9b63';
  var RPC = 'https://rpc.mainnet.arc.io';
  // Every node here answers browser calls from our origin (checked 2026-10-07). The official one rate-limits in bursts,
  // so a read walks the list until one answers; a read that fails on all of them is shown as failed, never as zero.
  var READ_RPCS = ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.mainnet.arc.io', 'https://rpc.beamrpc.com', 'https://arc.drpc.org'];
  var CHAIN = '0x13b2';
  var SCORES = [20, 40, 60, 80, 100];
  var oursP = null;

  function hex(n, bytes) { var s = BigInt(n).toString(16); return s.padStart((bytes || 32) * 2, '0'); }
  function utf8(s) { return new TextEncoder().encode(s); }
  function encStr(s) {
    var b = utf8(s), h = '';
    for (var i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, '0');
    var padded = h.padEnd(Math.ceil(h.length / 64) * 64, '0');
    return hex(b.length) + padded;
  }
  // giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)
  function encGive(agentId, value, tag1, tag2) {
    var strs = [tag1, tag2, '', ''].map(encStr), head = 8 * 32, offs = [], o = head;
    for (var i = 0; i < 4; i++) { offs.push(o); o += strs[i].length / 2; }
    return '0x3c036a7e' + hex(agentId) + hex(value) + hex(0) + offs.map(function (x) { return hex(x); }).join('') + hex(0) + strs.join('');
  }
  // getSummary(uint256 agentId, address[] clients, string tag1, string tag2) -> (uint64 count, int128 value, uint8 decimals)
  function encSummary(agentId, clients) {
    var arr = hex(clients.length) + clients.map(function (a) { return a.replace(/^0x/, '').toLowerCase().padStart(64, '0'); }).join('');
    var off1 = 4 * 32, off2 = off1 + arr.length / 2, off3 = off2 + 32;
    return '0x81bbba58' + hex(agentId) + hex(off1) + hex(off2) + hex(off3) + arr + hex(0) + hex(0);
  }
  // A JSON-RPC error that comes from the contract (a revert) is final; a transport failure or rate limit tries the next node.
  function rpc(method, params, i) {
    i = i || 0;
    return fetch(READ_RPCS[i], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.error) { var e = new Error(j.error.message || 'rpc error'); e.revert = /revert|execution/i.test(e.message) || j.error.code === 3; throw e; }
        return j.result;
      })
      .catch(function (e) { if (e.revert || i + 1 >= READ_RPCS.length) throw e; return rpc(method, params, i + 1); });
  }
  function call(data) { return rpc('eth_call', [{ to: REG, data: data }, 'latest']); }
  function words(h) { h = h.replace(/^0x/, ''); var w = []; for (var i = 0; i < h.length; i += 64) w.push(h.slice(i, i + 64)); return w; }
  function readSummary(agentId) {
    return call('0x42dd519c' + hex(agentId)).then(function (r) {
      var w = words(r), n = Number(BigInt('0x' + w[1])), clients = [];
      for (var i = 0; i < n; i++) clients.push('0x' + w[2 + i].slice(24));
      if (!n) return { count: 0, wallets: 0, avg: null };
      return call(encSummary(agentId, clients)).then(function (s) {
        var v = words(s), count = Number(BigInt('0x' + v[0])), raw = BigInt('0x' + v[1]), dec = Number(BigInt('0x' + v[2]));
        if (raw >= (1n << 127n)) raw -= (1n << 128n);
        return { count: count, wallets: n, avg: Number(raw) / Math.pow(10, dec) };
      });
    });
  }
  function sha256(s) {
    return crypto.subtle.digest('SHA-256', utf8(s)).then(function (b) { return Array.prototype.map.call(new Uint8Array(b), function (x) { return x.toString(16).padStart(2, '0'); }).join(''); });
  }
  function isOurs(addr) {
    if (!oursP) oursP = fetch('/arc/rate-ours.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).then(function (j) { return j.hashes || []; });
    return Promise.all([oursP, sha256(addr.toLowerCase())]).then(function (x) { return x[0].indexOf(x[1]) !== -1; });
  }
  // Same wallet order as the agent page's first rate box (Bitget/BitKeep first: Martin's and many Arc users' wallet).
  function provider() {
    var w = window, e = w.ethereum;
    var c = [w.bitkeep && w.bitkeep.ethereum, w.bitget && w.bitget.ethereum, e && e.providers && e.providers.length ? (e.providers.find(function (p) { return p.isMetaMask; }) || e.providers[0]) : e, w.okxwallet, w.trustwallet && w.trustwallet.ethereum];
    for (var i = 0; i < c.length; i++) if (c[i] && typeof c[i].request === 'function') return c[i];
    return null;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var CSS = '' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate{background:#15110e!important;color:#f4efe6!important;border:1px solid #6f5a2a!important;border-radius:14px!important;padding:14px 16px!important;margin:14px 0!important;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif!important;text-align:left!important;max-width:560px}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate *{color:#f4efe6!important;-webkit-text-fill-color:#f4efe6!important;opacity:1!important;text-shadow:none!important}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate .apx-k{font-weight:800!important;letter-spacing:.12em!important;font-size:.72rem!important;color:#e7c766!important;-webkit-text-fill-color:#e7c766!important;text-transform:uppercase}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate .apx-t{font-size:1.05rem!important;font-weight:700!important;margin:2px 0 6px!important}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate .apx-s b{color:#e7c766!important;-webkit-text-fill-color:#e7c766!important}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate .apx-row{display:flex!important;flex-wrap:wrap!important;gap:8px!important;align-items:center!important;margin:10px 0 6px!important}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate button{all:unset;box-sizing:border-box!important;cursor:pointer!important;border-radius:10px!important;font-weight:700!important;font-size:.95rem!important;line-height:1!important;background:#231c15!important;background-image:none!important;border:1px solid #8a7035!important;color:#f4efe6!important;-webkit-text-fill-color:#f4efe6!important;padding:10px 12px!important;min-width:46px!important;text-align:center!important;box-shadow:none!important}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate button[aria-pressed="true"]{background:#e7c766!important;border-color:#e7c766!important;color:#15110e!important;-webkit-text-fill-color:#15110e!important}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate button.apx-go{background:#e7c766!important;border-color:#e7c766!important;color:#15110e!important;-webkit-text-fill-color:#15110e!important;padding:11px 16px!important}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate button.apx-go[disabled]{background:#231c15!important;border:1px dashed #8a7035!important;color:#f4efe6!important;-webkit-text-fill-color:#f4efe6!important;cursor:default!important}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate .apx-m{margin-top:6px!important;font-size:.9rem!important}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate .apx-m a,html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate .apx-f a{color:#e7c766!important;-webkit-text-fill-color:#e7c766!important;text-decoration:underline!important}' +
    'html body:not(#a):not(#b):not(#c):not(#d):not(#e):not(#f) .apx-rate.apx-rate .apx-f{margin-top:8px!important;font-size:.8rem!important;color:#d8cfbf!important;-webkit-text-fill-color:#d8cfbf!important}';

  function mount(el) {
    if (el.getAttribute('data-apx-mounted')) return;
    el.setAttribute('data-apx-mounted', '1');
    el.setAttribute('data-keep-color', '');
    el.setAttribute('data-no-translate', '');
    var id = Number(el.getAttribute('data-agent'));
    if (!(id > 0)) return;
    var name = el.getAttribute('data-name') || ('agent #' + id);
    var score = null;
    el.innerHTML = '<div class="apx-k">Rate on Arc · ERC-8004 #' + id + '</div>' +
      '<div class="apx-t">How was ' + esc(name) + '?</div>' +
      '<div class="apx-s">On-chain reputation: <b class="apx-sum">reading the registry…</b></div>' +
      '<div class="apx-row">' + SCORES.map(function (s) { return '<button type="button" class="apx-sc" aria-pressed="false" data-s="' + s + '">' + s + '</button>'; }).join('') +
      '<button type="button" class="apx-go" disabled>Pick a score</button></div>' +
      '<div class="apx-m" role="status"></div>' +
      '<div class="apx-f">Written from your own wallet to Arc’s public reputation registry (about $0.005 of USDC gas). ' +
      'An agent’s owner cannot rate it, and APEX never rates itself.</div>';
    var sum = el.querySelector('.apx-sum'), go = el.querySelector('.apx-go'), msg = el.querySelector('.apx-m');
    function refresh() {
      readSummary(id).then(function (s) {
        sum.textContent = s.count ? (Math.round(s.avg) + '/100 · ' + s.count + ' rating' + (s.count === 1 ? '' : 's') + ' from ' + s.wallets + ' wallet' + (s.wallets === 1 ? '' : 's')) : 'no ratings yet — yours would be the first';
      }).catch(function () { sum.textContent = 'could not read the registry just now'; });
    }
    refresh();
    Array.prototype.forEach.call(el.querySelectorAll('.apx-sc'), function (b) {
      b.addEventListener('click', function () {
        score = Number(b.getAttribute('data-s'));
        Array.prototype.forEach.call(el.querySelectorAll('.apx-sc'), function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        go.disabled = false; go.textContent = 'Rate ' + score + ' on Arc';
      });
    });
    go.addEventListener('click', function () {
      if (score == null) return;
      var eth = provider();
      if (!eth) { msg.innerHTML = 'No wallet in this browser. Open this page inside a wallet app (MetaMask, Rabby, Coinbase Wallet) to rate.'; return; }
      go.disabled = true; msg.textContent = 'Check your wallet…';
      var from;
      eth.request({ method: 'eth_requestAccounts' }).then(function (acc) {
        from = acc && acc[0];
        if (!from) throw new Error('no account');
        return isOurs(from);
      }).then(function (ours) {
        if (ours) throw new Error('OURS');
        return eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN }] }).catch(function (e) {
          if (e && (e.code === 4902 || /unrecognized|not added|unknown chain/i.test(e.message || ''))) {
            return eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: CHAIN, chainName: 'Arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: [RPC], blockExplorerUrls: ['https://explorer.arc.io'] }] });
          }
          throw e;
        });
      }).then(function () {
        var data = encGive(id, score, 'quality', 'apexfaucet.xyz');
        // Ask the chain first: an owner, an operator or an empty wallet fails here with a clear message, not in the wallet.
        return rpc('eth_call', [{ from: from, to: REG, data: data }, 'latest']).then(function () { return data; }, function (e) { var m = String(e.message || ''); throw new Error(/self|owner|operator|authori/i.test(m) ? 'OWNER' : m); });
      }).then(function (data) {
        return eth.request({ method: 'eth_sendTransaction', params: [{ from: from, to: REG, data: data }] });
      }).then(function (hash) {
        msg.innerHTML = 'Thank you — rated ' + score + '/100 on Arc. <a href="https://explorer.arc.io/tx/' + esc(hash) + '" target="_blank" rel="noopener">See the transaction</a>';
        setTimeout(refresh, 4000);
      }).catch(function (e) {
        var m = String((e && e.message) || e);
        if (m === 'OURS') msg.textContent = 'This wallet belongs to the APEX project. We don’t rate ourselves.';
        else if (m === 'OWNER') msg.textContent = 'This wallet owns or operates this agent, and ERC-8004 does not let an owner rate their own agent.';
        else if (e && e.code === 4001) msg.textContent = 'Cancelled in the wallet. Nothing was sent.';
        else if (/insufficient|funds|balance/i.test(m)) msg.textContent = 'This wallet has no USDC for gas on Arc yet (about $0.005 is enough).';
        else msg.textContent = 'Not sent: ' + m.slice(0, 140);
        go.disabled = false;
      });
    });
  }
  function boot() {
    if (!document.getElementById('apx-rate-css')) { var st = document.createElement('style'); st.id = 'apx-rate-css'; st.textContent = CSS; document.head.appendChild(st); }
    Array.prototype.forEach.call(document.querySelectorAll('.apx-rate[data-agent]'), mount);
  }
  window.ApexRate = { mount: function (el) { boot(); mount(el); }, readSummary: readSummary, encGive: encGive };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
