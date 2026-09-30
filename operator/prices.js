'use strict';
// ONE PRICE LIST (2026-09-25). Every paid door reads its price from here: the x402 gate and its 402 on every rail,
// discovery (/.well-known/x402, openapi, facilitator catalogue), the pricing page, llms.txt, the machine meter, MCP,
// the web unlocks and the Telegram bot. One product, one price, on every rail (CLAUDE.md 1: one fact, one number).
//
// How the numbers were chosen (Martin, 2026-09-25: "make it just a tiny bit cheaper than the competition"; pricing
// is Claude's to set from now on, CLAUDE.md 2):
// - Competition = the market Arc buyers actually use: Circle's x402 catalogue, 482 Arc resources read 2026-09-25
//   (api.circle.com/v2/x402/discovery/resources), grouped by category. Each tier sits one step under the cluster of
//   the closest comparable services in its category.
// - Floor = what settling ONE standard payment costs us, measured from our own receipts on 2026-09-25:
//   Arc $0.0017 (85,460 gas x 20.1 gwei, USDC gas), Base $0.0010 (62,159 gas x 0.006 gwei at ETH $2,677),
//   Solana $0.0012 (10,001 lamports at SOL $116.91). Nothing sold on every rail is priced under $0.003, so every settlement
//   keeps a margin. The exceptions are Base-only products at $0.001 (email-check, page-snap): Coinbase's facilitator settles Base
//   for free up to 1,000 a month (2026-09-27), so they keep a margin there and are not offered on the other rails. Where a competitor is cheaper than that (Exa /contents at $0.001), we sit at the floor rather than
//   lose money on each call.
// - Prices have at most three decimals: several 402 fields print usdTarget.toFixed(3).
// - Stop rule: if 14 days at these prices (to 2026-10-09) still bring no outside payer, the problem is footfall,
//   not price. Stop touching prices and work on reach.

const FLOOR_USD = 0.003;

const TIER_USD = {
  cheap:   0.003,  // single lookups: OHLC / wallet / price rows go for $0.003-0.008; we sit at the floor
  default: 0.004,  // one analysis: financial-analysis rows cluster at $0.005 (Goldsky edge, BlockRun)
  premium: 0.025,  // bulk and full databases: data-enrichment / intel rows cluster at $0.03
  heavy:   0.09,   // an archive in one call: the few batch rows sit at $0.10
};

// Products with a direct competitor of their own, priced against it rather than against the tier.
const PATH_USD = {
  '/api/x402/page-extract':      0.009, // one rendered page: Olostep, Notte and Tavily extract are $0.01
  '/api/x402/site-extract':      0.14,  // up to 25 rendered pages of one site: Tavily crawl is $0.15
  '/api/x402/web-read':          0.003, // up to 10 pages, no JavaScript: Exa /contents is $0.001, under our floor
  '/api/x402/email-verify-bulk': 0.009, // up to 100 addresses: Icypeas, Tomba and Minerva charge $0.01
  '/api/x402/arc-passport':      0.99,  // an agent's ERC-8004 identity minted and handed over: fuci.family asks 1 USDC
  '/api/x402/x1-passport':       0.99,  // the same identity on X1's 8004 registry, paid in XNT; same price as the Arc one (one product, one price)
  // Base only, 2026-09-27 (Martin: 'a bit cheaper than the competition'). Under our $0.003 floor on purpose: on Base,
  // Coinbase's facilitator settles for free (1,000 a month), so a $0.001 call no longer loses money there. $0.001 is also
  // the lowest amount Coinbase's Bazaar accepts. Competitors measured in the Bazaar that night (30-day repeat use):
  '/api/x402/email-check':       0.001, // ONE address: oneshotagent email verify $0.001 (13 payers, 8,787 calls) - matched, cannot go under
  '/api/x402/base-exit-check':   0.01,  // executed buy+sell on Base: ax1.vc's AI-written Base token verdict is $0.02 (3,407 payers, 212,791 calls)
  '/api/x402/x402-seller-check': 0.005, // new: nobody sells 'are this seller's buyers real?'; priced like a lookup, above our floor so every rail keeps a margin
  '/api/x402/arc-token-check': 0.006, // 09-27: arc-verdict ($0.004) + contract-flags ($0.004) in one call, cheaper together
  '/api/x402/basename': 0.001, // 09-27: Basename <-> address, forward-verified, Base only
  '/api/x402/base-gas': 0.001, // new 09-27 (night build 8), Base only: real Base tx costs incl. the L1 data fee, from receipts
  '/api/x402/site-map': 0.003, // new 09-27 (night build 7): every URL a site publishes from its own sitemaps; charged only when one is found
  '/api/x402/x402-bazaar-rank': 0.005, // new 09-27: where a seller ranks in Coinbase's Bazaar search and what to fix; nobody else sells it
  '/api/x402/x402-endpoint-doctor': 0.005, // new: nobody sells 'why will Coinbase not list me' with the fixes; Coinbase's own validator is free but says only 'invalid discovery configuration'
  '/api/x402/domain-check':      0.002, // Base only: registration age + registrar + DNS + TLS + brand lookalike in one call; WHOIS/RDAP lookups sell at $0.002-0.01 in the Bazaar
  '/api/x402/contract-flags':    0.004, // owner powers from bytecode + proxy + owner(): token-security scans sell at $0.005-0.03 in the Bazaar
  '/api/x402/tx-explain':        0.003, // decoded Base/Arc transaction in plain words; tx lookups sell at $0.005-0.008 (onesource tx/receipt) - at our floor
  '/api/x402/page-markdown':     0.002, // Base only: rendered page as Markdown; oneshotagent read-as-markdown + screenshot is $0.002, Exa contents $0.002 per URL
  '/api/x402/pdf-text':          0.003, // a public PDF's text page by page; PDF-extraction listings sit at $0.005-0.02 - at our floor so every rail keeps a margin
  '/api/x402/page-snap':         0.001, // text + screenshot of one page: oneshotagent read + screenshot $0.002 (8 payers, 10,650 calls)
};

// Web unlocks for people paying by hand (lib/unlock.js): the same price as the call they replace.
const UNLOCK_USD = {
  check:  TIER_USD.default,  // one token check = one exit-check call
  threat: TIER_USD.premium,  // 24 h of the threat files = one threat-intel-bulk call
  watch:  0.10,              // 30 days of alerts for one Arc agent
  settle: 0.10,              // 30 days of settlement webhooks for one Arc address
};

function pathOf(p) {
  let s = String(p || '');
  try { if (/^https?:/i.test(s)) s = new URL(s).pathname; } catch (e) { /* keep as given */ }
  return s.split('?')[0].replace(/\/+$/, '');
}

// The price of an ENDPOINTS row (x402-routes.js): its own path price, else its tier.
function priceOfEndpoint(e) {
  if (!e) return TIER_USD.default;
  const own = PATH_USD[pathOf(e.path)];
  if (own != null) return own;
  if (e.usdPrice != null) return e.usdPrice;
  return TIER_USD[e.tier] != null ? TIER_USD[e.tier] : TIER_USD.default;
}

// The price of a paid URL or path, for surfaces that only know where the paid door is (meter, MCP).
function priceOfPath(p) {
  const path = pathOf(p);
  if (PATH_USD[path] != null) return PATH_USD[path];
  try {
    const { ENDPOINTS } = require('../x402-routes.js');
    const row = ENDPOINTS.find((e) => pathOf(e.path) === path || path.startsWith(pathOf(e.path) + '/'));
    if (row) return priceOfEndpoint(row);
  } catch (e) { /* x402-routes not loadable here: fall through to the default tier */ }
  return TIER_USD.default;
}

// "$0.004", "$0.14", "$0.09": the shortest exact form, never a rounded one.
function usdLabel(v) {
  const n = Number(v);
  if (!isFinite(n)) return '$?';
  let s = n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (/\.\d$/.test(s)) s += '0';
  return '$' + s;
}

module.exports = { FLOOR_USD, TIER_USD, PATH_USD, UNLOCK_USD, priceOfEndpoint, priceOfPath, usdLabel, pathOf };
