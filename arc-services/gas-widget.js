/* APEX free Arc gas button (2026-10-13). Any Arc app can give its new users their first USDC on Arc, so an empty wallet can send
 * its first transaction. USDC is the gas on Arc. The claim is free and gasless for the user, and needs no API key:
 *   <div data-apex-arc-gas></div>
 *   <script src="https://apexfaucet.xyz/arc/gas-widget.js" async></script>
 * The user's own wallet signs today's challenge (EIP-191, no transaction, no cost). Our faucet contract on Arc mainnet
 * (0x53fb2e89834050afaa9b3090a1fc9d1064615805, no withdraw function) then pays 0.01 USDC. Limits are the faucet's:
 * one claim per address every 8 hours, the daily cap, one claim per connection every 8 hours.
 * Options on the div: data-theme="light|dark" (default: follows the page's colour scheme), data-address="0x..." (claim to
 * this address instead of asking the wallet; it still has to sign).
 * Source and docs: https://apexfaucet.xyz/arc/gas-widget/
 */
(function () {
  'use strict';
  var API = 'https://apexfaucet.xyz';
  var CSS = ':host{all:initial;display:inline-block;font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
    + '.box{border:1px solid var(--bd);background:var(--bg);color:var(--fg);border-radius:14px;padding:14px 16px;max-width:360px;box-sizing:border-box}'
    + '.t{font-weight:600;margin:0 0 4px}.s{color:var(--mu);font-size:13px;margin:0 0 12px}'
    + 'button{all:unset;cursor:pointer;display:inline-block;background:var(--ac);color:var(--acf);font-weight:600;padding:10px 16px;border-radius:10px;text-align:center}'
    + 'button[disabled]{opacity:1;cursor:default;background:var(--dis);color:var(--disf)}'
    + '.m{margin-top:10px;font-size:13px;color:var(--fg);word-break:break-word}.m a{color:var(--ln)}.e{color:var(--er)}'
    + '.f{margin-top:10px;font-size:12px;color:var(--mu)}.f a{color:var(--mu)}'
    + '.light{--bg:#FFFDF8;--fg:#2A2113;--mu:#6B5E48;--bd:#E4D9C2;--ac:#7A5A12;--acf:#FFFFFF;--dis:#E9E1CF;--disf:#5C513E;--ln:#6B4E0E;--er:#A3282E}'
    + '.dark{--bg:#151213;--fg:#F4EFE4;--mu:#B9B0A2;--bd:#3A3133;--ac:#D4AF37;--acf:#141112;--dis:#2A2426;--disf:#CFC7B8;--ln:#F1DB93;--er:#F26B71}';
  function hex(s) { var b = new TextEncoder().encode(s), o = '0x'; for (var i = 0; i < b.length; i++) o += ('0' + b[i].toString(16)).slice(-2); return o; }
  function get(path) { return fetch(API + path, { headers: { accept: 'application/json' } }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); }); }
  function mount(host) {
    if (host.__apexGas) return; host.__apexGas = true;
    var dark = host.getAttribute('data-theme') ? host.getAttribute('data-theme') === 'dark'
      : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var st = document.createElement('style'); st.textContent = CSS; root.appendChild(st);
    var box = document.createElement('div'); box.className = 'box ' + (dark ? 'dark' : 'light');
    box.innerHTML = '<p class="t">New on Arc? Get free gas.</p><p class="s">0.01 USDC on Arc mainnet, free, sent to your wallet. You only sign a message: no transaction, no fee.</p>'
      + '<button type="button">Get free gas on Arc</button><div class="m" role="status" aria-live="polite"></div>'
      + '<div class="f">Free faucet by <a href="https://apexfaucet.xyz/arc/" target="_blank" rel="noopener">APEX Faucet</a> · one claim per wallet every 8 hours</div>';
    root.appendChild(box);
    var btn = box.querySelector('button'), msg = box.querySelector('.m');
    function say(text, err, link) {
      msg.className = 'm' + (err ? ' e' : ''); msg.textContent = text;
      if (link) { var a = document.createElement('a'); a.href = link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = ' View the transaction'; msg.appendChild(a); }
    }
    btn.addEventListener('click', function () {
      var eth = window.ethereum;
      if (!eth || !eth.request) { say('No wallet found in this browser. Open this page in your wallet app, or claim at apexfaucet.xyz/arc/.', true); return; }
      btn.disabled = true; say('Connecting your wallet…');
      var fixed = host.getAttribute('data-address'), addr;
      eth.request({ method: 'eth_requestAccounts' }).then(function (accs) {
        addr = fixed && /^0x[0-9a-fA-F]{40}$/.test(fixed) ? fixed : (accs && accs[0]);
        if (!addr) throw new Error('the wallet gave no address');
        return get('/api/arc/faucet/next/' + addr);
      }).then(function (n) {
        if (n && n.ok && n.canClaimNow === false) {
          var w = n.potEmpty ? 'The faucet pot is empty right now.' : 'Not yet: this wallet or today\'s share is on a pause. Try again in about ' + Math.max(1, Math.ceil((n.waitSeconds || 0) / 60)) + ' minutes.';
          throw new Error(w);
        }
        return get('/api/arc/faucet/challenge/' + addr);
      }).then(function (c) {
        if (!c || !c.ok || !c.message) throw new Error((c && c.error) || 'could not get today\'s challenge');
        say('Please sign the message in your wallet (free, no transaction)…');
        return eth.request({ method: 'personal_sign', params: [hex(c.message), addr] });
      }).then(function (sig) {
        say('Sending your gas…');
        return fetch(API + '/api/arc/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: addr, signature: sig }) })
          .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }); });
      }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || 'the claim failed; nothing was sent');
        say('Sent ' + r.amountUsdc + ' USDC to ' + addr.slice(0, 6) + '…' + addr.slice(-4) + '.', false, r.explorer);
        btn.textContent = 'Done';
      }).catch(function (e) {
        btn.disabled = false;
        var t = String((e && (e.message || e.reason)) || e);
        if (e && e.code === 4001) t = 'You cancelled in the wallet. Nothing was sent.';
        say(t, true);
      });
    });
  }
  function scan() { var els = document.querySelectorAll('[data-apex-arc-gas]'); for (var i = 0; i < els.length; i++) mount(els[i]); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();
