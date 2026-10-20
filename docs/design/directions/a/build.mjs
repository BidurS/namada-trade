#!/usr/bin/env node
/* ============================================================================
   NamadaTrade, Direction A "The Reading": static page builder.

   Reads ../../data/snapshot.json and writes home.html, trade.html and
   holders.html next to this file. Nothing numeric is typed by hand: every
   figure is a snapshot field or a derive() of snapshot fields, and every age
   is computed from the field's own timestamp relative to snapshot.capturedAt.

   The only literals that are not data are UI constants: labels, copy, the
   chart's x-tick spacing and the ruler scale (0 25 50 75 100). They are
   named in the CONFIG block.

   usage: node build.mjs            (writes next to this file)
          OUT_DIR=/some/dir THEME=light node build.mjs   (scratch variants)
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const S = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../data/snapshot.json'), 'utf8'));
const OUT = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : HERE;
const THEME = process.env.THEME === 'light' ? 'light' : 'dark';
const NOW = S.capturedAt;
const SITE_CSS = fs.readFileSync(path.join(HERE, 'site.css'), 'utf8');

/* ---------- CONFIG: UI constants (not data) ---------- */
const CONFIG = {
  tagline: 'What moved, who moved it, and what it costs to trade NAM.',
  presetSizes: S.curve.curve.map((r) => r.amountNam),     // preset chips come from the ladder
  defaultSize: 5000,                                       // the brief's default mini-ticket size
  defaultRange: '30d',
  ranges: { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 },
  holderRowsOnHome: 10,
  poolsShown: 9,
  fonts: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap',
};

/* ---------- formatting ---------- */
const nf = (min, max) => new Intl.NumberFormat('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
const NF0 = nf(0, 0);
const fInt = (n) => NF0.format(Math.round(n));
const fDec = (n, d) => nf(d, d).format(n);
const trimZ = (s) => s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
const fPct = (n, d = 1) => `${fDec(n, d)}%`;
const MINUS = '−';
const fSigned = (n, d = 2, suffix = '%') => (n > 0 ? '+' : n < 0 ? MINUS : '') + fDec(Math.abs(n), d) + suffix;
const fPrice = (n) => `$${n.toFixed(6)}`;                  // price keeps 6 decimals; never prints $0
const fUsdc = (n) => fDec(n, 2);
const fUsd = (n) => (n >= 1 ? `$${nf(2, 2).format(n)}` : `$${n.toFixed(6)}`);
const fUsd0 = (n) => `$${NF0.format(Math.round(n))}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
const fDate = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const fTime = (t) => { const d = new Date(t); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
const fUTC = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${fTime(t)} UTC`; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Human age of a timestamp, measured from the snapshot's own capture time. */
function fAge(at) {
  const ms = Math.max(0, NOW - at);
  if (ms < 5000) return 'now';
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 48) return `${trimZ(h.toFixed(1))} h`;
  return `${trimZ((h / 24).toFixed(1))} days`;
}
const ageAgo = (at) => (fAge(at) === 'now' ? 'just now' : `${fAge(at)} ago`);

/* ---------- provenance ---------- */
const STATUS = { live: 'fresh', stale: 'old', missing: 'none', conflict: 'disagree' };
const STATUS_WORD = { fresh: 'fresh', old: 'old', none: 'no data', disagree: 'sources disagree', age: 'age only' };
const PLAIN = {
  'Osmosis SQS': 'Osmosis quote',
  'Osmosis SQS pools': 'Osmosis pools',
  'Namada RPC abci_query': 'Namada node',
  'Namada RPC (MASP balance)': 'Namada node',
  'Keplr Osmosis bank/supply': 'Osmosis supply',
  'D1 flow index': 'Flow index',
  'executed NAM/USDC swaps (hourly median)': 'Executed swaps',
  'Namada indexer (indexer.namada.net)': 'Namada indexer',
  'chain parameter': 'Chain parameter',
};
const plain = (src) => PLAIN[src] || src;

const popovers = new Map();   // key -> {id, html}
let pvCount = 0;
/** p: {source, at, status, note?, derivedFrom?, extra?:[[k,v]]} */
function chip(p, { src = false, pre = '', label = '', cls = '' } = {}) {
  const status = p.status ? (STATUS[p.status] || p.status) : 'age';
  const name = p.plain || plain(p.source);
  const key = JSON.stringify([name, p.at, status, p.note || '', p.derivedFrom || '', label, p.extra || '']);
  let rec = popovers.get(key);
  if (!rec) {
    const id = `pv${++pvCount}`;
    const rows = [
      ['Status', `<span class="dot" data-status="${status}"></span>${esc(STATUS_WORD[status])}`],
      ['As of', esc(fUTC(p.at))],
      ['Age', esc(fAge(p.at) === 'now' ? 'just now' : fAge(p.at))],
      ['Source', esc(name)],
    ];
    if (p.derivedFrom) rows.push(['Derived', esc(p.derivedFrom)]);
    if (p.note) rows.push(['Note', esc(p.note)]);
    for (const [k, v] of p.extra || []) rows.push([k, v]);
    if (p.source && p.source !== name) rows.push(['Technical name', `<span class="mono">${esc(p.source)}</span>`]);
    rec = {
      id,
      html: `<div id="${id}" popover class="sheet ground-ink" aria-label="${esc(label || name)}">
  <div class="sheet__head"><h2 class="sheet__t">${esc(label || name)}</h2>
    <button class="icon-btn" popovertarget="${id}" popovertargetaction="hide" aria-label="Close"><svg class="ico"><use href="#i-close"/></svg></button></div>
  <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
  <div class="sheet__foot"><a class="btn btn--secondary" href="#">Rewind to this time</a></div>
</div>`,
    };
    popovers.set(key, rec);
  }
  const age = fAge(p.at);
  let text;
  if (status === 'none') text = 'no data';
  else if (status === 'disagree') text = `disagree · ${age}`;
  else if (status === 'old') text = src ? `${name} · old ${age}` : `old · ${age}`;
  else text = src ? `${name} · ${age}` : age;
  if (pre && status !== 'disagree') text = `${pre} ${text}`;
  const aria = `${label || name}: ${STATUS_WORD[status]}, ${age === 'now' ? 'just now' : age}. Show source.`;
  return `<button type="button" class="chip ${cls}" data-status="${status}" popovertarget="${rec.id}" aria-label="${esc(aria)}"><i class="dot" data-status="${status}"></i><span>${esc(text)}</span></button>`;
}
const popoverHtml = () => [...popovers.values()].map((r) => r.html).join('\n');

/** derive(): a derived value takes the oldest `at` and the worst status of its inputs. */
const RANK = { live: 0, stale: 1, missing: 2, conflict: 3 };
function derive(inputs, derivedFrom) {
  const at = Math.min(...inputs.map((i) => i.at));
  const status = inputs.map((i) => i.status).sort((a, b) => RANK[b] - RANK[a])[0];
  return { source: derivedFrom, plain: 'Derived', at, status, derivedFrom };
}

/* ---------- snapshot bindings (everything the pages print comes from here) ---------- */
const O = S.overview;
const PRICE = O.price.usd.value;
const PRICE_PROV = O.price.usd.prov;
const CHG24 = O.price.change24h;
const SUP = O.supply;
const TOTAL = SUP.total;
const DEX = O.dex;
const NAMADA = O.namada;
const CHECKS = O.checks;
const PRESS = S.pressure;
const BLIND = S.blindspot;
const CURVE = S.curve;
const RULES = Object.fromEntries(S.rules.map((r) => [r.id, r]));
const HOLDERS = S.holders;
const WINDOW_H = Math.round((S.alerts.until - S.alerts.since) / 3600e3);   // the alerts window itself: 24 hours
const CHANGE_DAYS = 7;   // the holders field is named change7d
const pct = (v) => (v / TOTAL) * 100;
const ladder = (n) => CURVE.curve.find((r) => r.amountNam === n);

/* ---------- icons ---------- */
const ICONS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="i-home" viewBox="0 0 24 24"><path d="M4 11 12 4l8 7v8.5a.5.5 0 0 1-.5.5H15v-6H9v6H4.5a.5.5 0 0 1-.5-.5z"/></symbol>
<symbol id="i-trade" viewBox="0 0 24 24"><path d="M7 20V5M7 5 3.5 8.5M7 5l3.5 3.5M17 4v15M17 19l-3.5-3.5M17 19l3.5-3.5"/></symbol>
<symbol id="i-supply" viewBox="0 0 24 24"><path d="m12 4-9 4.5 9 4.5 9-4.5zM3 12.5l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5"/></symbol>
<symbol id="i-shielded" viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.5c0 4.4 3.1 7.8 7.5 9.5 4.4-1.7 7.5-5.1 7.5-9.5V6z"/></symbol>
<symbol id="i-activity" viewBox="0 0 24 24"><path d="M3 12h4l2.5-6 4 12 2.5-6H21"/></symbol>
<symbol id="i-alerts" viewBox="0 0 24 24"><path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0"/></symbol>
<symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></symbol>
<symbol id="i-account" viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5"/></symbol>
<symbol id="i-rewind" viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.6-5.9M4 4.5v4h4M12 8v4.5l3 1.8"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24"><path d="M4 12h15M13.5 6.5 19 12l-5.5 5.5"/></symbol>
<symbol id="i-close" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></symbol>
<symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/></symbol>
<symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 4 2.8 19.5h18.4zM12 10v4.5M12 16.8v.4"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></symbol>
<symbol id="g-buy" viewBox="0 0 12 12"><path d="M3 9l6-6M4 3h5v5"/></symbol>
<symbol id="g-sell" viewBox="0 0 12 12"><path d="M3 3l6 6M9 4v5H4"/></symbol>
<symbol id="g-shield" viewBox="0 0 12 12"><path d="M6 1.2 2.2 2.7v3c0 2.4 1.6 4 3.8 4.9 2.2-.9 3.8-2.5 3.8-4.9v-3z"/></symbol>
<symbol id="g-lock" viewBox="0 0 12 12"><rect x="2.5" y="5.5" width="7" height="5" rx=".5"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/></symbol>
<symbol id="g-ring" viewBox="0 0 12 12"><circle cx="6" cy="6" r="3.6"/></symbol>
<symbol id="mark" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12.5" fill="none" stroke="currentColor" stroke-width="4.5"/><path d="M16 9.2l4.7 5.8h-9.4zM16 22.8l-4.7-5.8h9.4z" fill="currentColor"/></symbol>
</defs></svg>`;
const ico = (id, cls = 'ico') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
const gly = (id) => `<svg class="gly" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#000"/><circle cx="16" cy="16" r="12.5" fill="none" stroke="#ff0" stroke-width="4.5"/><path d="M16 9.2l4.7 5.8h-9.4zM16 22.8l-4.7-5.8h9.4z" fill="#ff0"/></svg>');

/* ---------- tags ---------- */
const FLOW = {
  buy:       { word: 'Buy',         glyph: 'g-buy',    hue: 'buy',    tip: 'buy' },
  sell:      { word: 'Sell',        glyph: 'g-sell',   hue: 'sell',   tip: 'sell' },
  shieldIn:  { word: 'Shielded in', glyph: 'g-shield', hue: 'shield', tip: 'shield' },
  shieldOut: { word: 'Shielded out',glyph: 'g-shield', hue: 'shield', tip: 'unshield' },
  staked:    { word: 'Staked',      glyph: 'g-lock',   hue: 'pos',    tip: 'bond' },
  unlocked:  { word: 'Unlocked',    glyph: 'g-lock',   hue: 'pos',    tip: 'withdraw' },
};
const tag = (k) => `<span class="tag tag--flow" style="--hue:var(--${FLOW[k].hue})" title="Expert term: ${FLOW[k].tip}">${gly(FLOW[k].glyph)}${FLOW[k].word}</span>`;
const CATS = { foundation: 'Foundation', genesis: 'Genesis', backer: 'Backer' };
const catTag = (c) => (c && CATS[c] ? `<span class="tag tag--cat">${gly('g-ring')}${CATS[c]}</span>` : '');

/* ---------- shared chrome ---------- */
const NAV = [
  ['home', 'Home', 'home.html', 'i-home'],
  ['trade', 'Trade', 'trade.html', 'i-trade'],
  ['supply', 'Supply', '#', 'i-supply'],
  ['shielded', 'Shielded', '#', 'i-shielded'],
  ['activity', 'Activity', 'holders.html', 'i-activity'],
  ['alerts', 'Alerts', '#', 'i-alerts'],
];
const okCount = CHECKS.filter((c) => c.status === 'ok').length;
const warnCount = CHECKS.length - okCount;

function header(active) {
  const priceChip = chip(PRICE_PROV, { src: true, label: 'NAM price' });
  const pvId = /popovertarget="(pv\d+)"/.exec(priceChip)[1];
  const dotStatus = STATUS[PRICE_PROV.status];
  return `<header class="hdr"><div class="hdr__in">
  <a class="brand" href="home.html" aria-label="Namada Trade, home"><svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true"><use href="#mark"/></svg><span class="brand__word">Namada <b>Trade</b></span></a>
  <nav class="tabs" aria-label="Primary"><ul>${NAV.map(([k, label, href]) => `<li><a href="${href}"${k === active ? ' aria-current="page"' : ''}>${label}</a></li>`).join('')}</ul></nav>
  <span class="hdr__sp"></span>
  <button type="button" class="hprice" popovertarget="${pvId}" aria-label="NAM price ${fPrice(PRICE)}, ${fSigned(CHG24)} since this time yesterday. Show source.">
    <i class="dot" data-status="${dotStatus}"></i><span class="hprice__v" data-num>${fPrice(PRICE)}</span><span class="hprice__d">${fSigned(CHG24, 1)}</span></button>
  <button type="button" class="hbtn hbtn--rewind" aria-label="Rewind to a date">${ico('i-rewind')}<span>Rewind</span></button>
  <button type="button" class="hbtn hbtn--status" popovertarget="sources" aria-label="${okCount} of ${CHECKS.length} checks pass. Where every number comes from."><i class="dot" data-status="${warnCount ? 'old' : 'fresh'}"></i><span><span class="hbtn__s">${okCount}/${CHECKS.length}</span><span class="hbtn__l">${okCount} of ${CHECKS.length}</span><span class="hbtn__more"> checks</span></span></button>
  <button type="button" class="ibtn" aria-label="Search">${ico('i-search')}</button>
  <button type="button" class="ibtn" aria-label="Account">${ico('i-account')}</button>
</div></header>`;
}

function tabbar(active) {
  return `<nav class="tabbar" aria-label="Primary"><ul>${NAV.map(([k, label, href, icon]) => `<li><a href="${href}"${k === active ? ' aria-current="page"' : ''}>${ico(icon)}<span>${label}</span></a></li>`).join('')}</ul></nav>`;
}

const CHECK_PLAIN = {
  ibc_conservation:    ['NAM held at the bridge matches NAM on Osmosis', (d) => `${fInt(d.driftNam)} NAM apart`],
  rpc_consensus:       ['Two Namada nodes agree on the latest block', (d) => `${fInt(d.heightDiff)} blocks apart`],
  supply_integrity:    ['Staked and escrowed NAM never exceed what exists', (d) => `${d.pctLocked} of NAM is locked or escrowed`],
  indexer_lag:         ['The indexer keeps up with the chain', (d) => `${fInt(d.lagBlocks)} blocks behind`],
  supply_cross_source: ['Total supply is the same in two sources', (d) => `${fInt(d.diffNam)} NAM apart`],
  price_vs_execution:  ['The quoted price matches what trades paid', (d) => `${d.deviationPct}% apart`],
  bonded_coverage:     ['Staked NAM adds up address by address', (d) => `${d.coveragePct} of staked NAM matched to addresses`],
};
const checkRows = () => CHECKS.map((c) => {
  const [title, fmt] = CHECK_PLAIN[c.key] || [c.title, () => ''];
  const st = c.status === 'ok' ? 'fresh' : 'old';
  const word = c.status === 'ok' ? 'Passes' : 'Needs a look';
  return `<li class="chk" data-key="${esc(c.key)}" data-status="${st}"><span class="chk__t"><i class="dot" data-status="${st}"></i>${esc(title)}</span>
    <span class="chk__w">${word}</span><span class="chk__d">${esc(fmt(c.detail))}</span>
    <span class="chk__c">${chip({ source: 'cross-check', plain: 'Cross-check', at: c.checkedAt, status: 'live' }, { label: title })}</span></li>`;
}).join('');

function sourcesSheet() {
  const ok = O.sources.filter((s) => s.ok).length;
  return `<div id="sources" popover class="sheet sheet--lg ground-ink" aria-label="Where every number comes from">
  <div class="sheet__head"><h2 class="sheet__t">Where every number comes from</h2>
    <button class="icon-btn" popovertarget="sources" popovertargetaction="hide" aria-label="Close">${ico('i-close')}</button></div>
  <p class="sheet__lead"><b>${okCount} of ${CHECKS.length}</b> cross-checks pass${warnCount ? `, ${warnCount} need a look` : ''}. This page is a snapshot taken ${esc(fUTC(NOW))}; every age is measured from that moment.</p>
  <ul class="chks">${checkRows()}</ul>
  <details class="how"><summary>How it is computed</summary>
    <p class="cap">${ok} of ${O.sources.length} data sources answered at the snapshot. Last answer, oldest first:</p>
    <ul class="srcs">${[...O.sources].sort((a, b) => a.at - b.at).map((s) => `<li><span class="mono">${esc(s.name)}</span><span class="mono">${s.ok ? 'ok' : 'down'} · ${esc(fAge(s.at))}</span></li>`).join('')}</ul>
  </details>
</div>`;
}

const FOOTER_LINKS = ['How we know', 'Settings', 'API', 'Source code'];
function footer() {
  return `<footer class="band ground-accent foot">
  <div class="ruler ruler--top" aria-hidden="true"></div>
  <div class="wrap foot__grid">
    <div class="foot__id">
      <a class="foot__brand" href="home.html"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#mark"/></svg><span>Namada Trade</span></a>
      <p class="foot__snap">Snapshot of ${esc(fUTC(NOW))}. Ages are measured from that moment.</p>
    </div>
    <p class="foot__legal">Every number shows its source and age. Data: Osmosis router, Namada nodes, indexer.namada.net; records current as of ${esc(fAge(DEX.coverage.at))}. Not investment advice. Not affiliated with Namada or the Anoma Foundation.</p>
    <ul class="foot__links">${FOOTER_LINKS.map((l) => `<li>${l === 'How we know' ? `<button type="button" class="linkbtn" popovertarget="sources">${l}</button>` : `<a href="#">${l}</a>`}</li>`).join('')}</ul>
  </div>
</footer>`;
}

function page({ file, title, desc, active, body, css = '', js = '' }) {
  const html = `<!doctype html>
<html lang="en"${THEME === 'light' ? ' data-theme="light"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#000000">
<link rel="icon" href="${FAVICON}">
<!-- Mockup only: production self-hosts Space Grotesk and JetBrains Mono (see notes.md) -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${CONFIG.fonts}">
<link rel="stylesheet" href="tokens.css">
<style>
${SITE_CSS}
${css}
</style>
</head>
<body>
${ICONS}
<a class="skip" href="#main">Skip to content</a>
${header(active)}
<main id="main">
${body}
</main>
${tabbar(active)}
${sourcesSheet()}
${popoverHtml()}
${js ? `<script>\n${js}\n</script>` : ''}
</body>
</html>
`;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, file), html);
  console.log('wrote', path.join(OUT, file), (html.length / 1024).toFixed(0) + ' KB');
}

/* ---------- shared pieces ---------- */
function priceBig(value) {
  const s = fPrice(value);
  const m = /^(\$0\.0*)(\d+)$/.exec(s);
  return m ? `<span class="lz">${m[1]}</span>${m[2]}` : s;
}
const nam = (n, d = 0) => `${d ? fDec(n, d) : fInt(n)}<span class="u"> NAM</span>`;
const ruler = (cls = '') => `<div class="ruler ${cls}" aria-hidden="true"></div>`;
const shortAddr = (a) => `${a.slice(0, 10)}…${a.slice(-5)}`;
const niceLabel = (l) => l.replace(/_/g, ' ');

/* the 5,000 NAM sell estimate from the size ladder, used by Home mini-ticket and Trade default */
const L5 = ladder(CONFIG.defaultSize);
const curveProv = CURVE.prov;

/* ============================================================================
   HOME
   ============================================================================ */
function home() {
  popovers.clear(); pvCount = 0;
  /* hero */
  const priceChipHero = chip(PRICE_PROV, { src: true, label: 'NAM price' });
  const facts = [
    { n: fInt(NAMADA.holders), l: 'holders on Namada', p: { source: 'Namada indexer (indexer.namada.net)', at: O.sources.find((s) => s.name.startsWith('Namada indexer')).at, status: 'live' } },
    { n: fPct(BLIND.sharePct), l: 'shielded', p: BLIND.shielded.prov },
    { n: fPct(pct(SUP.osmosis)), l: 'on Osmosis', p: SUP.osmosisProv },
  ];
  const hero = `<section class="band ground-accent hero" aria-labelledby="h1">
  <div class="wrap">
    <div class="hero__grid">
      <div class="hero__lead">
        <p class="eyebrow">Namada Trade · NAM on Osmosis</p>
        <h1 id="h1" class="h1">${esc(CONFIG.tagline)}</h1>
        <p class="sub">Live price, who holds NAM, who might sell, and how much is shielded. Every number shows where it came from and how old it is.</p>
      </div>
      <div class="hero__price price">
        <p class="price__label">NAM price</p>
        <p class="price__val" data-num>${priceBig(PRICE)}</p>
        <p class="price__meta"><span class="delta" data-num><svg class="gly" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2.5 10 9H2z" fill="currentColor"/></svg>${fSigned(CHG24)}</span><span class="price__since">since this time yesterday</span></p>
        <p class="price__prov">${priceChipHero}</p>
        ${sparkline()}
      </div>
      <div class="actions">
        <a class="btn btn--primary" href="trade.html">See what a trade costs ${ico('i-arrow', 'ico ico--btn')}</a>
        <button class="btn btn--secondary" type="button" popovertarget="sources">How we know</button>
      </div>
    </div>
    <ul class="facts">${facts.map((f) => `<li class="fact"><span class="fact__n" data-num>${f.n}</span><span class="fact__l">${f.l}</span>${chip(f.p)}</li>`).join('')}</ul>
  </div>
  ${ruler('ruler--bottom')}
</section>`;

  /* what changed */
  const impact10k = ladder(10000);
  const alertsEmpty = S.alerts.hits.length === 0;
  const bigSwap = RULES.big_swap.thresholdNam;
  const bigSwapUsd = derive([{ at: PRICE_PROV.at, status: PRICE_PROV.status }], 'price x alert size');
  const dexCov = DEX.coverage;
  const nmCov = NAMADA.coverage;
  const rowsOsmo = [
    ['buy', DEX.buyNam24h, `${fInt(DEX.buys24h)} trades in ${WINDOW_H} hours`],
    ['sell', DEX.sellNam24h, `${fInt(DEX.sells24h)} trades in ${WINDOW_H} hours`],
  ];
  const rowsNamada = [
    ['shieldIn', NAMADA.shielded24h, 'moved into the shielded set'],
    ['shieldOut', NAMADA.unshielded24h, 'moved out of the shielded set'],
    ['staked', NAMADA.bonded24h, 'newly staked with validators'],
    ['unlocked', NAMADA.withdrawn24h, NAMADA.withdrawn24h === 0 ? 'No NAM finished unstaking' : 'finished unstaking'],
  ];
  const mvRow = ([k, v, cap]) => `<li class="mv${v === 0 ? ' mv--zero' : ''}">${tag(k)}<span class="mv__n" data-num>${nam(v)}</span><span class="mv__c">${esc(cap)}</span></li>`;
  const changed = `<section class="sec" aria-labelledby="h-changed">
    <h2 id="h-changed" class="h2">What changed in the last ${WINDOW_H} hours</h2>
    ${alertsEmpty ? `<div class="empty">
      <svg class="empty__ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 5"/></svg>
      <div><p class="empty__t">Nothing crossed an alert size in ${WINDOW_H} hours.</p>
      <p class="empty__s">Alert sizes are small on purpose: at today's price ${fInt(bigSwap)} NAM is <span data-num>${fUsd(bigSwap * PRICE)}</span> ${chip(bigSwapUsd, { pre: 'derived', label: 'Alert size in dollars' })}</p></div>
    </div>` : ''}
    <div class="mvgroup"><div class="mvgroup__h"><h3 class="h3">On Osmosis <span class="h3__s">bot trades removed</span></h3>${chip(dexCov, { src: true })}</div>
      <ul class="mvlist">${rowsOsmo.map(mvRow).join('')}</ul></div>
    <div class="mvgroup"><div class="mvgroup__h"><h3 class="h3">On Namada <span class="h3__s">${fInt(NAMADA.flows24h)} moves</span></h3>${chip(nmCov, { src: true })}</div>
      <ul class="mvlist">${rowsNamada.map(mvRow).join('')}</ul></div>
    <p class="cap cap--note">Records can lag the chain: the flow index shows its own age above. Rows with an alert-size hit would appear first, in the rule's own words.</p>
  </section>`;

  /* where is all the NAM */
  const segs = [
    { k: 'pgf', label: 'Public funding', v: SUP.pgf, note: 'held for public goods' },
    { k: 'bonded', label: 'Staked', v: SUP.bonded, note: 'locked with validators' },
    { k: 'shielded', label: 'Shielded', v: SUP.shielded, note: 'total public, owners not' },
    { k: 'rest', label: 'Everything else spendable', v: SUP.transparentLiquid, note: 'could be bridged and sold' },
    { k: 'osmosis', label: 'On Osmosis', v: SUP.osmosis, note: 'the one place it can be sold' },
  ];
  const osmoPct = pct(SUP.osmosis);
  const supplyChip = chip(SUP.prov, { src: true });
  const osmoChip = chip(SUP.osmosisProv, { src: true });
  const where = `<section class="sec" aria-labelledby="h-where">
    <h2 id="h-where" class="h2">Where is all the NAM?</h2>
    <p class="lead">Only <b data-num>${fPct(osmoPct)}</b> of NAM, <b data-num>${fInt(SUP.osmosis)} NAM</b>, is on Osmosis, the one place it can be sold. The pools there hold <b data-num>${fUsd0(DEX.liquidityUsd)}</b>.</p>
    <div class="supply" role="img" aria-label="Supply bar: ${segs.map((s) => `${s.label} ${fPct(pct(s.v))}`).join(', ')}">
      <div class="supply__flag"><span>${fPct(osmoPct)} on Osmosis</span></div>
      <div class="supply__bar">${segs.map((s, i) => `<i class="sg sg--${s.k}" style="flex:${pct(s.v).toFixed(4)} 1 0%;--i:${i}"></i>`).join('')}</div>
      <div class="ruler ruler--scale" aria-hidden="true"></div>
      <div class="supply__scale" aria-hidden="true"><span>0</span><span>25</span><span>50</span><span>75</span><span>100%</span></div>
    </div>
    <ul class="legend">${segs.map((s) => `<li class="lg lg--${s.k}"><i class="lg__sw sg sg--${s.k}"></i><span class="lg__n">${s.label}</span><span class="lg__p" data-num>${fPct(pct(s.v))}</span><span class="lg__v"><span data-num>${fInt(s.v)} NAM</span> · ${s.note}</span></li>`).join('')}</ul>
    <p class="srcline">${supplyChip} ${osmoChip}</p>
  </section>`;

  /* who holds NAM */
  const top = HOLDERS.holders.slice(0, CONFIG.holderRowsOnHome);
  const topMax = top[0].total;
  const holdRow = (h) => holderRow(h, topMax, true);
  const who = `<section class="sec" aria-labelledby="h-who">
    <h2 id="h-who" class="h2">Who holds NAM</h2>
    <p class="lead">The ${top.length} biggest holders own <b data-num>${fPct(O.concentration.namadaTop10Pct)}</b> of NAM on Namada. Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone.</p>
    <div class="dl dl--holders" role="table" aria-label="Ten biggest NAM holders">
      <div class="dl__head" role="row"><span role="columnheader">#</span><span role="columnheader">Holder</span><span role="columnheader" class="r">Total NAM</span><span role="columnheader" class="r">Share</span><span role="columnheader" class="r">7 days</span><span role="columnheader" class="r">Checked</span></div>
      ${top.map(holdRow).join('')}
    </div>
    <p class="more"><a class="link" href="holders.html"><span>All <span data-num>${fInt(HOLDERS.total)}</span> holders</span>${ico('i-arrow', 'ico ico--inline')}</a></p>
  </section>`;

  /* rail (desktop) */
  const rail = `<aside class="rail" aria-label="Right now"><div class="rail__in">
    <h2 class="rail__h">Right now</h2>
    <dl class="rail__list">
      <div><dt>Pool depth</dt><dd data-num>${fUsd0(DEX.liquidityUsd)}</dd><dd>${chip(DEX.prov)}</dd></div>
      <div><dt>NAM on Osmosis</dt><dd data-num>${nam(SUP.osmosis)}</dd><dd>${chip(SUP.osmosisProv)}</dd></div>
      <div><dt>Unstaking wait</dt><dd data-num>${trimZ(String(PRESS.unbondingDays))}<span class="u"> days</span></dd><dd>${chip({ source: 'chain parameter', at: PRESS.asOf, status: 'live' })}</dd></div>
      <div><dt>Cross-checks</dt><dd data-num>${okCount} of ${CHECKS.length}<span class="u"> pass</span></dd><dd>${chip({ source: 'cross-check', plain: 'Cross-checks', at: Math.max(...CHECKS.map((c) => c.checkedAt)), status: 'live' })}</dd></div>
    </dl></div></aside>`;

  /* path of a NAM */
  const steps = [
    { t: 'Staked', copy: 'Staked NAM is locked with validators and can\'t be sold.', n: fInt(SUP.bonded), u: 'NAM', note: `${fPct(pct(SUP.bonded))} of all NAM`, p: SUP.prov },
    { t: 'Unlocked', copy: `Asking to unstake starts a wait of about ${trimZ(String(PRESS.unbondingDays))} days.`, n: trimZ(String(PRESS.unbondingDays)), u: 'days', note: 'the unstaking wait', p: { source: 'chain parameter', at: PRESS.asOf, status: 'live' } },
    { t: 'Bridged', copy: 'To be sold, NAM crosses to Osmosis. Crossings usually come before sales.', n: fInt(PRESS.ibcIn7d), u: 'NAM', note: `crossed in the last ${PRESS.windowDays} days`, p: PRESS.coverage },
    { t: 'Sold', copy: `On Osmosis, NAM trades in small pools. An order to sell ${fInt(impact10k.amountNam)} NAM moves the price ${fPct(impact10k.sellImpactPct)}.`, n: fPct(impact10k.sellImpactPct), u: 'price move', note: `selling ${fInt(impact10k.amountNam)} NAM`, p: curveProv },
  ];
  const path_ = `<section class="band ground-accent path" aria-labelledby="h-path">
  <div class="wrap">
    <p class="eyebrow">Four steps</p>
    <h2 id="h-path" class="h2 h2--big">How NAM gets from a wallet to a sale</h2>
    <ol class="steps">${steps.map((s, i) => `<li class="step" style="--i:${i}">
      <span class="step__ring" aria-hidden="true"><svg viewBox="0 0 28 28"><circle class="r0" cx="14" cy="14" r="11.5" fill="none" stroke="currentColor" stroke-width="2.5"/><circle class="r1" cx="14" cy="14" r="6" fill="currentColor"/></svg></span>
      <div class="step__body">
        <p class="step__k"><span class="step__i">${i + 1}</span>${s.t}</p>
        <p class="step__copy">${esc(s.copy)}</p>
        <p class="step__fig"><span class="step__n" data-num>${s.n}</span><span class="step__u">${s.u}</span></p>
        <p class="step__note">${s.note} ${chip(s.p)}</p>
      </div></li>`).join('')}</ol>
    <p class="sidenote"><svg class="gly gly--lg" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-shield"/></svg>Shielded NAM sits in a pool whose total is public and whose owners are not: <b data-num>${fPct(BLIND.sharePct)}</b> of all NAM. ${chip(BLIND.shielded.prov)}</p>
  </div>
</section>`;

  /* mini ticket */
  const ticket = `<section class="sec sec--ticket" aria-labelledby="h-ticket">
    <h2 id="h-ticket" class="h2">What would you get right now?</h2>
    <p class="srcline"><span class="tag tag--cat">Snapshot</span> taken ${esc(fUTC(curveProv.at))}, not a live quote</p>
    <div class="mini">
      <div class="mini__row"><span class="mini__k">Sell</span><span class="mini__amt" data-num>${fInt(L5.amountNam)}<span class="u"> NAM</span></span></div>
      <div class="mini__get"><span class="mini__k">You get about</span><span class="mini__v" data-num>${fUsdc(L5.sellOutUsdc)}<span class="u"> USDC</span></span>
        <span class="mini__chip">${chip(curveProv, { label: 'From the size ladder', src: true })}</span></div>
      <div class="mini__row"><span class="mini__k">Price move</span><span class="mini__mv" data-num>${fPct(L5.sellImpactPct, 2)}</span></div>
    </div>
    <div class="notice" data-tone="warn">${ico('i-warn', 'ico notice__i')}<div><p class="notice__t">The Osmosis quote service is not answering.</p>
      <p class="notice__s">Last quoted price: <span data-num>${fPrice(PRICE)}</span>, ${esc(ageAgo(PRICE_PROV.at))}. The figures above come from the size ladder, not a fresh quote. This card is a snapshot of ${esc(fUTC(curveProv.at))}.</p></div></div>
    <p class="more"><a class="link" href="trade.html"><span>Full quote</span>${ico('i-arrow', 'ico ico--inline')}</a></p>
  </section>`;

  /* why trust it */
  const trust = `<section class="sec sec--trust" aria-labelledby="h-trust">
    <h2 id="h-trust" class="h2">Why you can trust these numbers</h2>
    <ol class="why">
      <li><b>Every number shows its source and age.</b> Tap the dot and age beside any number to see them.</li>
      <li><b data-num>${okCount} of ${CHECKS.length}</b> cross-checks pass right now${warnCount ? `, <b data-num>${warnCount}</b> need a look` : ''}.</li>
      <li><b>Rewind:</b> pick a past moment and every number on the site shows as it was then. Live prices pause.</li>
    </ol>
    <ul class="chks chks--page">${checkRows()}</ul>
  </section>`;

  const body = `${hero}
<div class="band ground-ink narrative"><div class="wrap narrative__grid">
  <div class="narrative__main">${changed}${where}${who}</div>
  ${rail}
</div></div>
${path_}
<div class="band ground-ink closing"><div class="wrap closing__grid">${ticket}${trust}</div></div>
${footer()}`;

  page({
    file: 'home.html',
    title: 'Namada Trade: what moved NAM, who moved it',
    desc: 'NAM price, holders, supply and what a trade costs on Osmosis. Every number shows its source and age.',
    active: 'home',
    body,
    js: `if(document.documentElement.scrollHeight<=innerHeight+2)document.documentElement.classList.add('static');`,
  });
}

/* hero sparkline: 30-day executed price, geometry only (wipes in once) */
function sparkline() {
  const pts = S.executedHistory30d;
  const W = 360, H = 64, pad = 4;
  const t0 = pts[0].ts, t1 = NOW;
  const vs = pts.map((p) => p.value);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const X = (t) => pad + ((t - t0) / (t1 - t0)) * (W - 2 * pad);
  const Y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.ts).toFixed(1)} ${Y(p.value).toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  const ch = (last.value / pts[0].value - 1) * 100;
  const prov = { source: 'executed NAM/USDC swaps (hourly median)', at: S.overview.price.swap1h.prov.at, status: S.overview.price.swap1h.prov.status };
  return `<div class="spark">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Executed price, ${fPrice(pts[0].value)} on ${fDate(pts[0].ts)} to ${fPrice(last.value)} on ${fDate(last.ts)}"><path class="spark__line" d="${d}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>
    <p class="spark__c"><span data-num>${fSigned(ch, 0)}</span> since ${fDate(pts[0].ts)}, executed price ${chip(prov)}</p>
  </div>`;
}

/* ---------- holder row, shared by Home and Holders ---------- */
function holderRow(h, maxTotal, compact = false) {
  const name = h.label ? niceLabel(h.label) : null;
  const est = h.bondedEstimated != null && Math.abs(h.bondedEstimated - h.bonded) > 1;
  const checked = { source: 'Namada indexer (indexer.namada.net)', plain: 'Namada indexer', at: h.verifiedAt, status: est ? 'conflict' : null,
    extra: [['Balance checked', esc(fUTC(h.verifiedAt))], ['Staked checked', esc(fUTC(h.bondedVerifiedAt))],
      ...(est ? [['Staked, verified', `${fInt(h.bonded)} NAM`], ['Staked, flow estimate', `${fInt(h.bondedEstimated)} NAM (${fInt(Math.abs(h.bonded - h.bondedEstimated))} apart)`]] : []),
      ...(h.linked && h.linked.length ? [['Linked Osmosis addresses', fInt(h.linked.length)]] : [])] };
  const chgA = h.change7d === 0 ? 'no change' : fSigned(h.change7d, 0, ' NAM');
  const cat = h.category || 'none';
  const linked = h.linked && h.linked.length ? `${h.linked.length} linked Osmosis address${h.linked.length > 1 ? 'es' : ''}` : '';
  return `<div class="hrow" role="row" data-cat="${cat}">
    <span class="hrow__rk" role="cell">${h.rank}</span>
    <div class="hrow__body">
      <div class="hln hln1"><span class="hrow__name${name ? '' : ' mono'}" role="cell">${esc(name || shortAddr(h.address))}</span>
        <span class="hrow__tot" role="cell" data-num>${fInt(h.total)}<span class="u"> NAM</span></span></div>
      <div class="hln hln2"><span class="hrow__sub" role="cell"><span class="mono">${name ? esc(shortAddr(h.address)) : 'no label'}</span>${catTag(h.category)}</span>
        <span class="hrow__pct" role="cell" data-num>${fPct(h.pctSupply, 2)}<span class="u"> of supply</span></span></div>
      <div class="hln hln3"><span class="hrow__spend" role="cell" data-num>${fInt(h.balance)}</span>
        <span class="hrow__stake" role="cell" data-num>${fInt(h.bonded)}${est ? `<span class="hrow__est" title="Verified on chain ${fInt(h.bonded)} NAM; the flow estimate is ${fInt(h.bondedEstimated)} NAM"><i class="dot" data-status="disagree"></i>estimate ${fInt(h.bondedEstimated)}</span>` : ''}</span></div>
      <div class="hln hln4"><span class="hrow__chg" role="cell"><span class="chg__a">${esc(chgA)}</span><span class="chg__b"> in ${CHANGE_DAYS} days</span>${linked && !compact ? `<span class="hrow__link">${linked}</span>` : ''}</span>
        <span class="hrow__prov" role="cell">${chip(checked, { pre: 'checked', label: 'Balance check' })}</span></div>
    </div>
    <i class="hrow__bar" style="--w:${((h.total / maxTotal) * 100).toFixed(2)}%" aria-hidden="true"></i>
  </div>`;
}

/* ============================================================================
   TRADE
   ============================================================================ */
/* chart: executed (solid) and quoted (dashed) from the snapshot's histories */
function niceStep(range, target) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}
function chartSvg(rangeKey, size) {
  const span = CONFIG.ranges[rangeKey];
  const t0 = NOW - span, t1 = NOW;
  const exec = S.executedHistory30d.filter((p) => p.ts >= t0);
  const spot = { ts: PRICE_PROV.at > NOW ? NOW : PRICE_PROV.at, value: PRICE };
  const quoted = [...S.priceHistory7d.filter((p) => p.ts >= t0), { ts: Math.min(spot.ts, NOW), value: spot.value }];
  const all = [...exec.map((p) => p.value), ...quoted.map((p) => p.value)];
  let lo = Math.min(...all), hi = Math.max(...all);
  const step = niceStep((hi - lo) * 1.25, size === 'p' ? 4 : 5);
  lo = Math.floor((lo - (hi - lo) * 0.05) / step) * step;
  hi = Math.ceil((hi + (hi - lo) * 0.05) / step) * step;
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const phone = size === 'p';
  const W = phone ? 328 : 600, H = phone ? 208 : 288;
  const fs = phone ? 11 : 13;   // desktop viewBox is 600 wide: 13 stays 11 px or more down to a 1024 px window
  const tickVals = [];
  for (let v = lo; v <= hi + step / 2; v += step) tickVals.push(v);
  const labelChars = Math.max(...tickVals.map((v) => v.toFixed(dec).length));
  const m = { l: Math.ceil(labelChars * fs * 0.62) + 14, r: phone ? 10 : 14, t: phone ? 14 : 16, b: phone ? 26 : 28 };
  const X = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  let yTicks = '';
  for (const v of tickVals) {
    yTicks += `<line class="c-grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="c-tick" x="${m.l - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" style="font-size:${fs}px">${v.toFixed(dec)}</text>`;
  }
  /* x ticks: 24h every 6 h, 7d every 2 days, 30d every 7 days, counted back from the capture time */
  const xStep = rangeKey === '24h' ? 6 * 3600e3 : rangeKey === '7d' ? 2 * 86400e3 : 7 * 86400e3;
  const xAnchor = rangeKey === '24h' ? Math.floor(NOW / xStep) * xStep : Math.floor(NOW / 86400e3) * 86400e3;
  let xTicks = '';
  const maxTicks = phone ? 5 : 6;
  const stepMul = Math.ceil(((t1 - t0) / xStep + 1) / maxTicks) || 1;
  for (let t = xAnchor, i = 0; t >= t0; t -= xStep * stepMul, i++) {
    const anchor = X(t) < m.l + 18 ? 'start' : X(t) > W - m.r - 18 ? 'end' : 'middle';
    xTicks += `<text class="c-tick" x="${X(t).toFixed(1)}" y="${H - 6}" text-anchor="${anchor}" style="font-size:${fs}px">${rangeKey === '24h' ? fTime(t) : fDate(t)}</text>`;
  }
  const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.ts).toFixed(1)} ${Y(p.value).toFixed(1)}`).join('');
  const lastE = exec[exec.length - 1];
  const dots = (pts, cls, r) => pts.map((p) => `<circle class="${cls}" cx="${X(p.ts).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="${r}"/>`).join('');
  const pillT = lastE ? lastE.value.toFixed(6) : '';
  const pw = phone ? 62 : 74, ph = phone ? 20 : 24;
  const px = lastE ? Math.min(X(lastE.ts) + 6, W - m.r) - pw : 0;
  const py = lastE ? Math.max(Y(lastE.value) - ph - 10, m.t) : 0;
  const pill = lastE ? `<g class="c-pill"><rect x="${px.toFixed(1)}" y="${py.toFixed(1)}" width="${pw}" height="${ph}" rx="${ph / 2}"/><text x="${(px + pw / 2).toFixed(1)}" y="${(py + ph / 2 + 4).toFixed(1)}" text-anchor="middle" style="font-size:${phone ? 11 : 13}px">${pillT}</text></g>` : '';
  const sparse = exec.length < 3;
  const data = JSON.stringify(exec.map((p) => [Math.round(X(p.ts) * 10) / 10, p.ts, p.value]));
  return `<svg class="chart chart--${size}" viewBox="0 0 ${W} ${H}" role="img" data-pts='${data}' data-w="${W}" data-h="${H}" data-top="${m.t}" data-bot="${H - m.b}" aria-label="Price chart, ${rangeKey}. Executed price solid, quoted price dashed.">
    ${yTicks}${xTicks}
    ${quoted.length > 1 ? `<path class="c-quote" d="${line(quoted)}" fill="none"/>${dots(quoted, 'c-quote-dot', 2.5)}` : ''}
    ${exec.length > 1 ? `<g class="c-wipe"><path class="c-exec" d="${line(exec)}" fill="none"/></g>` : ''}
    ${dots(exec, 'c-exec-dot', sparse ? 3.5 : 2)}
    <line class="c-cursor" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}"/>
    ${pill}
  </svg>`;
}
function chartTakeaway(rangeKey) {
  const t0 = NOW - CONFIG.ranges[rangeKey];
  const exec = S.executedHistory30d.filter((p) => p.ts >= t0);
  if (exec.length < 2) return { head: `Only ${exec.length} trades in ${CONFIG.ranges['24h'] / 3600e3} hours`, sub: 'Too few executed trades to draw a trend. Dots show the hourly median where trades happened.', n: exec.length };
  const a = exec[0], b = exec[exec.length - 1];
  const ch = (b.value / a.value - 1) * 100;
  return { head: `Executed price ${ch >= 0 ? 'up' : 'down'} ${fDec(Math.abs(ch), 0)}% since ${fDate(a.ts)}`, sub: `USDC per NAM, hourly median of executed swaps, ${exec.length} points.`, n: exec.length };
}

function trade() {
  popovers.clear(); pvCount = 0;
  const sizes = CONFIG.presetSizes;
  const sell = (r) => ({ get: r.sellOutUsdc, avg: r.sellEffectiveUsd, move: r.sellImpactPct });
  const buy = (r) => ({ pay: r.buyInUsdc, avg: r.buyEffectiveUsd, move: r.buyImpactPct, out: r.buyInUsdc / r.buyEffectiveUsd });
  const estChip = chip(curveProv, { label: 'From the size ladder', src: true });
  const deriveChip = chip(derive([{ at: curveProv.at, status: curveProv.status }], 'USDC paid divided by average price'), { pre: 'derived', label: 'About how many NAM' });
  const maxSell = Math.max(...CURVE.curve.map((r) => r.sellImpactPct));
  const maxBuy = Math.max(...CURVE.curve.map((r) => r.buyImpactPct));
  const topPool = S.pools.pools[0];

  /* result panels: one per side x size */
  const resPanels = [];
  for (const r of CURVE.curve) {
    const s = sell(r), b = buy(r);
    resPanels.push(`<div class="res" data-side="sell" data-size="${r.amountNam}"${r.amountNam === CONFIG.defaultSize ? '' : ' hidden'}>
      <p class="get__k">You get</p>
      <p class="get__v" data-num>${fUsdc(s.get)}<span class="get__u">USDC</span></p>
      <p class="get__s">for <span data-num>${fInt(r.amountNam)} NAM</span> at an average <span data-num>${fPrice(s.avg)}</span> each</p>
      <dl class="pair"><div><dt>Quoted price</dt><dd data-num>${fPrice(CURVE.spotUsd)}</dd></div><div><dt>Price move</dt><dd data-num class="pair__big">${fPct(s.move, 2)}</dd></div></dl>
    </div>`);
    resPanels.push(`<div class="res" data-side="buy" data-size="${r.amountNam}" hidden>
      <p class="get__k">You pay</p>
      <p class="get__v" data-num>${fUsdc(b.pay)}<span class="get__u">USDC</span></p>
      <p class="get__s">for about <span data-num>${fInt(b.out)} NAM</span> at an average <span data-num>${fPrice(b.avg)}</span> each</p>
      <dl class="pair"><div><dt>Quoted price</dt><dd data-num>${fPrice(CURVE.spotUsd)}</dd></div><div><dt>Price move</dt><dd data-num class="pair__big">${fPct(b.move, 2)}</dd></div></dl>
    </div>`);
  }
  /* amount field mirrors the chosen preset */
  const amtSpans = sizes.map((n) => `<span class="amt" data-size="${n}"${n === CONFIG.defaultSize ? '' : ' hidden'}>${fInt(n)}</span>`).join('');
  const usdSpans = sizes.map((n) => `<span class="amt-usd" data-size="${n}"${n === CONFIG.defaultSize ? '' : ' hidden'}>${fUsd(ladder(n).usdSize)}</span>`).join('');

  const radios = `<input class="sr-only" type="radio" name="side" id="sd-sell" checked><input class="sr-only" type="radio" name="side" id="sd-buy">
    ${sizes.map((n) => `<input class="sr-only" type="radio" name="size" id="sz-${n}"${n === CONFIG.defaultSize ? ' checked' : ''}>`).join('')}
    ${Object.keys(CONFIG.ranges).map((k) => `<input class="sr-only" type="radio" name="range" id="rg-${k}"${k === CONFIG.defaultRange ? ' checked' : ''}>`).join('')}`;

  /* ticket (the yellow panel) */
  const ticketPanel = `<div class="ticket">
    <p class="eyebrow">Trade · NAM on Osmosis</p>
    <h1 id="h1" class="h1"><span class="only-sell">What would I get if I sold NAM now?</span><span class="only-buy">What would I pay to buy NAM now?</span></h1>
    <p class="sub">An Osmosis quote, not an order. This site never trades for you.</p>
    <div class="seg seg--2 seg--side" role="radiogroup" aria-label="Side">
      <label class="seg__opt" for="sd-sell"><span>Sell NAM for USDC</span></label>
      <label class="seg__opt" for="sd-buy"><span>Buy NAM with USDC</span></label>
    </div>
    <div class="field">
      <div class="field__top"><span class="field__l">Amount</span><span class="field__hint"><span class="only-sell">Worth about </span><span class="only-buy">Spend the value of about </span><span data-num>${usdSpans}</span></span></div>
      <div class="field__box"><span class="field__v" data-num>${amtSpans}</span><span class="field__u">NAM</span></div>
    </div>
    <div class="presets" role="radiogroup" aria-label="Amount presets">${sizes.map((n) => `<label class="pre" for="sz-${n}"><span data-num>${fInt(n)}</span></label>`).join('')}</div>
    <p class="field__note">Listed sizes only: the quote service is not answering, so other sizes cannot be quoted today.</p>
    <div class="get" aria-live="polite">${resPanels.join('\n')}
      <p class="get__prov">${estChip}</p>
      <p class="get__why only-buy">About how many NAM: derived from USDC paid and average price ${deriveChip}</p>
    </div>
  </div>`;

  const thin = `<div class="notice notice--thin" data-tone="warn">${ico('i-warn', 'ico notice__i')}<div>
    <p class="notice__t">Thin market.</p>
    <p class="notice__s">The pools on Osmosis hold <span data-num>${fUsd0(CURVE.totalLiquidityUsd)}</span> in total, across <span data-num>${fInt(CURVE.poolsCount)}</span> pools. <span class="only-sell">A sale of ${fInt(CONFIG.defaultSize)} NAM already moves the price ${fPct(L5.sellImpactPct)}.</span><span class="only-buy">The largest order that moves the price 1% or less is <span data-num>${fInt(CURVE.maxSafeClip1PctNam)} NAM</span>; for 3% or less, <span data-num>${fInt(CURVE.maxSafeClip3PctNam)} NAM</span>.</span> ${chip(curveProv, { src: true })}</p></div></div>`;

  /* chart block */
  const ranges = Object.keys(CONFIG.ranges);
  const quotedSince = S.priceHistory7d[0].ts;
  const exProv = { source: 'executed NAM/USDC swaps (hourly median)', at: O.price.swap1h.prov.at, status: O.price.swap1h.prov.status };
  const chartBlock = `<section class="sec chartsec" aria-labelledby="h-chart">
    <div class="chartsec__top">
      ${ranges.map((k) => {
        const t = chartTakeaway(k);
        return `<div class="rg-title" data-range="${k}"${k === CONFIG.defaultRange ? '' : ' hidden'}><h2 id="${k === CONFIG.defaultRange ? 'h-chart' : 'h-chart-' + k}" class="h2 h2--chart">${esc(t.head)}</h2><p class="cap">${esc(t.sub)}</p></div>`;
      }).join('')}
      <div class="seg seg--3 seg--range" role="radiogroup" aria-label="Chart range">
        ${ranges.map((k) => `<label class="seg__opt" for="rg-${k}"><span>${k}</span></label>`).join('')}
      </div>
    </div>
    <p class="readout" aria-live="polite"><span class="readout__k">Last executed</span> <b data-num class="readout__v">${fPrice(S.executedHistory30d.at(-1).value)}</b> <span class="readout__t">${esc(fDate(S.executedHistory30d.at(-1).ts))}, ${esc(fTime(S.executedHistory30d.at(-1).ts))} UTC</span></p>
    ${ranges.map((k) => `<div class="rg" data-range="${k}"${k === CONFIG.defaultRange ? '' : ' hidden'}>${chartSvg(k, 'p')}${chartSvg(k, 'd')}</div>`).join('')}
    <ul class="key"><li><i class="key__ln"></i>Executed price</li><li><i class="key__ln key__ln--dash"></i>Quoted price, recorded since <span data-num>${esc(fDate(quotedSince))}</span></li></ul>
    <p class="srcline">Source: Osmosis quote (dashed); executed swaps, hourly median (solid) · as of ${esc(fTime(exProv.at))} UTC ${chip(exProv)}</p>
    <p class="sr-only">First executed price ${fPrice(S.executedHistory30d[0].value)}, lowest ${fPrice(Math.min(...S.executedHistory30d.map((p) => p.value)))}, highest ${fPrice(Math.max(...S.executedHistory30d.map((p) => p.value)))}, last ${fPrice(S.executedHistory30d.at(-1).value)}.</p>
  </section>`;

  /* ladder */
  const lRow = (r) => {
    const s = sell(r), b = buy(r);
    return `<label class="lrow" role="row" for="sz-${r.amountNam}" data-size="${r.amountNam}">
      <span class="lrow__size" role="cell" data-num>${fInt(r.amountNam)}<span class="u"> NAM</span></span>
      <span class="lrow__val" role="cell" data-num>${fUsd(r.usdSize)}</span>
      <span class="lrow__sget" role="cell" data-col="sell" data-num>${fUsdc(s.get)}<span class="u"> USDC</span></span>
      <span class="lrow__smv" role="cell" data-col="sell" data-num>${fPct(s.move, 2)}</span>
      <span class="lrow__bpay" role="cell" data-col="buy" data-num>${fUsdc(b.pay)}<span class="u"> USDC</span></span>
      <span class="lrow__bmv" role="cell" data-col="buy" data-num>${fPct(b.move, 2)}</span>
      <i class="lrow__bar lrow__bar--sell" style="--w:${((s.move / maxSell) * 100).toFixed(1)}%" aria-hidden="true"></i>
      <i class="lrow__bar lrow__bar--buy" style="--w:${((b.move / maxBuy) * 100).toFixed(1)}%" aria-hidden="true"></i>
    </label>`;
  };
  const ladderSec = `<section class="band g-accent-to-ink ladder" aria-labelledby="h-ladder"><div class="wrap">
    <h2 id="h-ladder" class="h2">How size moves the price</h2>
    <p class="lead">Tap a size to quote it. Bars compare the price move with the biggest one listed.</p>
    <div class="dl dl--ladder" role="table" aria-label="Price move by order size">
      <div class="dl__head" role="row"><span role="columnheader">Size</span><span role="columnheader" class="r">Value</span>
        <span role="columnheader" class="r" data-col="sell">You get</span><span role="columnheader" class="r" data-col="sell">Price move</span>
        <span role="columnheader" class="r" data-col="buy">You pay</span><span role="columnheader" class="r" data-col="buy">Price move</span></div>
      ${CURVE.curve.map(lRow).join('')}
    </div>
    <p class="srcline">${chip(curveProv, { src: true })} <span>Both sides are shown on wide screens; the side you picked is highlighted.</span></p>
  </div></section>`;

  /* pools */
  const pools = S.pools.pools;
  const shownPools = pools.slice(0, CONFIG.poolsShown);
  const rest = pools.slice(CONFIG.poolsShown);
  const restSum = rest.reduce((a, p) => a + p.liquidityUsd, 0);
  const maxLiq = pools[0].liquidityUsd;
  const pairLabel = (p) => {
    const c = p.counterSymbol;
    if (c === 'UNKNOWN') return 'NAM / unknown coin';
    if (c.startsWith('factory/')) return `NAM / ${c.split('/').pop()}`;
    if (c.startsWith('ibc/')) return `NAM / coin ${c.slice(4, 10)}…`;
    return `NAM / ${c}`;
  };
  const poolRow = (p) => `<div class="prow" role="row">
    <span class="prow__id" role="cell"><span class="prow__pair">${esc(pairLabel(p))}</span><span class="prow__sub"><span class="mono">${p.id ? `#${esc(p.id)}` : 'no id'} · ${esc(p.type)}</span>${p.id === '3005' ? '<span class="tag tag--cat tag--ref">Sets the price</span>' : ''}</span></span>
    <span class="prow__liq" role="cell" data-num>${fUsd0(p.liquidityUsd)}</span>
    <span class="prow__share" role="cell" data-num>${fPct((p.liquidityUsd / CURVE.totalLiquidityUsd) * 100)}<span class="u"> of all depth</span></span>
    <span class="prow__nam" role="cell" data-num>${fInt(p.namReserve)}<span class="u"> NAM</span></span>
    <span class="prow__fee" role="cell" data-num>${fPct(p.spreadFactor * 100, 2)}<span class="u"> fee</span></span>
    <i class="prow__bar" style="--w:${((p.liquidityUsd / maxLiq) * 100).toFixed(1)}%" aria-hidden="true"></i>
  </div>`;
  const poolsSec = `<section class="sec" aria-labelledby="h-pools">
    <h2 id="h-pools" class="h2">Where NAM trades</h2>
    <p class="lead"><b data-num>${fInt(CURVE.poolsCount)}</b> pools hold <b data-num>${fUsd0(CURVE.totalLiquidityUsd)}</b>. The biggest holds <b data-num>${fPct((topPool.liquidityUsd / CURVE.totalLiquidityUsd) * 100)}</b> of it and sets the quoted price.</p>
    <div class="dl dl--pools" role="table" aria-label="Pools that trade NAM">
      <div class="dl__head" role="row"><span role="columnheader">Pool</span><span role="columnheader" class="r">Depth</span><span role="columnheader" class="r">Share</span><span role="columnheader" class="r">NAM inside</span><span role="columnheader" class="r">Fee</span></div>
      ${shownPools.map(poolRow).join('')}
      <div class="prow prow--rest" role="row"><span role="cell"><b data-num>${fInt(rest.length)}</b> more pools</span><span role="cell" class="r"><span data-num>${fUsd0(restSum)}</span> together, none above <span data-num>${fUsd0(Math.max(...rest.map((p) => p.liquidityUsd)))}</span></span></div>
    </div>
    <p class="srcline">${chip(S.pools.prov, { src: true })} <span>Pool types in plain words are in the glossary.</span></p>
  </section>`;

  /* generated state rules: side x size, size highlight, range. Defaults render via the hidden attribute, so the
     page is correct before any rule applies; the radios then drive everything with :has() and no script. */
  const rules = [];
  const SEL = 'background:var(--c-sel-bg);color:var(--c-sel-ink)';
  for (const n of sizes) {
    rules.push(`.trade:has(#sz-${n}:checked) :is(.res,.amt,.amt-usd):not([data-size="${n}"]){display:none}`);
    rules.push(`.trade:has(#sz-${n}:checked) :is(.amt,.amt-usd)[data-size="${n}"]{display:inline}`);
    rules.push(`.trade:has(#sz-${n}:checked) label.pre[for="sz-${n}"]{${SEL};border-color:var(--c-sel-bg)}`);
    rules.push(`.trade:has(#sz-${n}:checked) .lrow[data-size="${n}"]{${SEL};--c-ink-2:var(--c-sel-ink);--c-ink-3:var(--c-sel-ink);--c-line:transparent}`);
    for (const side of ['sell', 'buy']) rules.push(`.trade:has(#sd-${side}:checked):has(#sz-${n}:checked) .res[data-side="${side}"][data-size="${n}"]{display:block}`);
  }
  rules.push('.trade:has(#sd-buy:checked) .res[data-side="sell"],.trade:has(#sd-sell:checked) .res[data-side="buy"]{display:none}');
  for (const k of ranges) {
    rules.push(`.trade:has(#rg-${k}:checked) :is(.rg,.rg-title):not([data-range="${k}"]){display:none}`);
    rules.push(`.trade:has(#rg-${k}:checked) :is(.rg,.rg-title)[data-range="${k}"]{display:block}`);
    rules.push(`.trade:has(#rg-${k}:checked) label.seg__opt[for="rg-${k}"] span{${SEL}}`);
  }
  rules.push(`.trade:has(#sd-sell:checked) label.seg__opt[for="sd-sell"] span,.trade:has(#sd-buy:checked) label.seg__opt[for="sd-buy"] span{${SEL}}`);
  rules.push('.trade:has(#sd-sell:checked) .only-buy,.trade:has(#sd-buy:checked) .only-sell{display:none !important}');
  rules.push('.trade:has(#sd-buy:checked) span.only-buy{display:inline}.trade:has(#sd-buy:checked) p.only-buy{display:block}');
  rules.push('.trade:has(#sd-sell:checked) [data-col="buy"]{opacity:.45}.trade:has(#sd-buy:checked) [data-col="sell"]{opacity:.45}');
  rules.push('.trade:has(#sd-sell:checked) .lrow__bar--buy,.trade:has(#sd-buy:checked) .lrow__bar--sell{display:none}');
  rules.push('@container ladder (max-width: 599px){.trade:has(#sd-sell:checked) :is(.lrow__bpay,.lrow__bmv){display:none}.trade:has(#sd-buy:checked) :is(.lrow__sget,.lrow__smv){display:none}}');
  for (const id of [...sizes.map((n) => `sz-${n}`), 'sd-sell', 'sd-buy', ...ranges.map((k) => `rg-${k}`)]) {
    rules.push(`.trade:has(#${id}:focus-visible) label[for="${id}"]{outline:2px solid var(--c-focus);outline-offset:2px}`);
  }

  const body = `<div class="trade">
  ${radios}
  <div class="split">
    <div class="split__a ground-accent"><div class="split__stick">${ticketPanel}${thin}</div></div>
    <div class="split__b ground-ink">${chartBlock}${ladderSec}${poolsSec}</div>
  </div>
</div>
${footer()}`;

  /* The ladder sits on a yellow band on phones and on black beside the sticky ticket on desktop */
  page({
    file: 'trade.html',
    title: 'Trade: what would I get if I sold NAM now?',
    desc: 'An Osmosis quote for NAM, how order size moves the price, and the pools that trade it. Not an order.',
    active: 'trade',
    body,
    css: rules.join('\n'),
    js: `(function(){var svgs=document.querySelectorAll('svg.chart'),ro=document.querySelector('.readout'),rv=ro&&ro.querySelector('.readout__v'),rt=ro&&ro.querySelector('.readout__t');
var M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];function p2(n){return String(n).padStart(2,'0')}
var base=ro&&{k:ro.querySelector('.readout__k').textContent,v:rv.textContent,t:rt.textContent};
svgs.forEach(function(s){var pts=JSON.parse(s.getAttribute('data-pts')||'[]'),cur=s.querySelector('.c-cursor'),W=+s.getAttribute('data-w');
function at(e){var r=s.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*W,b=null,d=1e9;pts.forEach(function(p){var dd=Math.abs(p[0]-x);if(dd<d){d=dd;b=p}});return b}
function move(e){var b=at(e);if(!b)return;cur.setAttribute('x1',b[0]);cur.setAttribute('x2',b[0]);cur.style.opacity=1;var d=new Date(b[1]);ro.querySelector('.readout__k').textContent='Executed';rv.textContent='$'+b[2].toFixed(6);rt.textContent=d.getUTCDate()+' '+M[d.getUTCMonth()]+', '+p2(d.getUTCHours())+':'+p2(d.getUTCMinutes())+' UTC'}
function leave(){cur.style.opacity=0;if(base){ro.querySelector('.readout__k').textContent=base.k;rv.textContent=base.v;rt.textContent=base.t}}
s.addEventListener('pointermove',move);s.addEventListener('pointerleave',leave);s.addEventListener('pointerdown',move)});})();`,
  });
}

/* ============================================================================
   HOLDERS (Activity, Holders tab)
   ============================================================================ */
function holders() {
  popovers.clear(); pvCount = 0;
  const rows = HOLDERS.holders;
  const maxTotal = rows[0].total;
  const cats = [['all', 'All'], ['foundation', 'Foundation'], ['genesis', 'Genesis'], ['backer', 'Backer'], ['none', 'No label']];
  const counts = Object.fromEntries(cats.map(([k]) => [k, k === 'all' ? rows.length : rows.filter((r) => (r.category || 'none') === k).length]));
  const indexerAt = O.sources.find((s) => s.name.startsWith('Namada indexer')).at;

  const radios = `<input class="sr-only" type="radio" name="chain" id="ch-namada" checked><input class="sr-only" type="radio" name="chain" id="ch-osmosis">
    ${cats.map(([k]) => `<input class="sr-only" type="radio" name="cat" id="ct-${k}"${k === 'all' ? ' checked' : ''}>`).join('')}`;

  const filterGroups = `<fieldset class="fset"><legend class="fset__l">Chain</legend><div class="seg seg--2" role="radiogroup">
      <label class="seg__opt" for="ch-namada"><span>Namada</span></label><label class="seg__opt" for="ch-osmosis"><span>Osmosis</span></label></div></fieldset>
    <fieldset class="fset"><legend class="fset__l">What</legend><div class="chipsel" role="radiogroup">
      ${cats.map(([k, l]) => `<label class="chipsel__o" for="ct-${k}"><span>${l}<span class="chipsel__n" data-num>${counts[k]}</span></span></label>`).join('')}</div></fieldset>`;

  const summary = [
    { n: fInt(NAMADA.holders), l: 'holders on Namada', p: { source: 'Namada indexer (indexer.namada.net)', at: indexerAt, status: 'live' } },
    { n: fPct(O.concentration.namadaTop10Pct), l: 'owned by the top 10', p: { source: 'Namada indexer (indexer.namada.net)', at: indexerAt, status: 'live' } },
    { n: fInt(DEX.holders), l: 'holders on Osmosis', p: DEX.prov },
    { n: fPct(O.concentration.osmosisTop10Pct), l: 'owned by the top 10 there', p: DEX.prov },
  ];

  const hero = `<section class="band ground-accent hhero" aria-labelledby="h1"><div class="wrap">
    <p class="eyebrow">Activity · Holders</p>
    <h1 id="h1" class="h1">Who holds NAM?</h1>
    <p class="sub">The biggest holders, with when each balance was last checked. Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone.</p>
    <ul class="facts facts--4">${summary.map((f) => `<li class="fact"><span class="fact__n" data-num>${f.n}</span><span class="fact__l">${f.l}</span>${chip(f.p)}</li>`).join('')}</ul>
  </div>${ruler('ruler--bottom')}</section>`;

  const list = `<div class="band ground-ink hl-band"><div class="wrap">
  <div class="hl">
    ${radios}
    <div class="hl__bar">
      <nav class="utabs" aria-label="Activity views"><a href="#">Transactions</a><a href="holders.html" aria-current="page">Holders</a></nav>
      <button type="button" class="btn btn--secondary filterbtn" popovertarget="filters">${ico('i-filter', 'ico ico--btn')}Filter<span class="badge" hidden>0</span></button>
    </div>
    <div id="filters" popover class="sheet ground-ink filters" aria-label="Filter holders">
      <div class="sheet__head"><h2 class="sheet__t">Filter holders</h2><button class="icon-btn" popovertarget="filters" popovertargetaction="hide" aria-label="Close">${ico('i-close')}</button></div>
      <div class="filters__body">${filterGroups}</div>
      <div class="sheet__foot"><button class="btn btn--primary" popovertarget="filters" popovertargetaction="hide">Show holders</button></div>
    </div>
    <p class="hl__count" aria-live="polite"><span data-num class="hl__n">${rows.length}</span> of <span data-num>${fInt(HOLDERS.total)}</span> holders captured in this snapshot, biggest first.</p>
    <div class="dl dl--holders dl--full" role="table" aria-label="Holders of NAM on Namada">
      <div class="dl__head" role="row"><span role="columnheader">#</span><span role="columnheader">Holder</span><span role="columnheader" class="r">Total NAM</span><span role="columnheader" class="r">Share</span><span role="columnheader" class="r">Spendable</span><span role="columnheader" class="r">Staked</span><span role="columnheader">7 days</span><span role="columnheader" class="r">Checked</span></div>
      ${rows.map((h) => holderRow(h, maxTotal)).join('')}
    </div>
    <div class="empty empty--filter" id="empty-filter"><svg class="empty__ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 5"/></svg>
      <div><p class="empty__t">No holder in this snapshot matches.</p><p class="empty__s">Only the top ${rows.length} holders were captured. Clear the filter to see them.</p></div></div>
    <div class="empty empty--osmosis" id="empty-osmosis"><svg class="empty__ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 5"/></svg>
      <div><p class="empty__t">The Osmosis list was not captured.</p>
      <p class="empty__s"><span data-num>${fInt(DEX.holders)}</span> addresses hold NAM on Osmosis and the top 10 own <span data-num>${fPct(O.concentration.osmosisTop10Pct)}</span> of it ${chip(DEX.prov)}. Choose Namada to see the rows.</p></div></div>
    <div class="more more--load"><button class="btn btn--secondary" type="button" disabled>Load more holders</button><p class="cap">The snapshot holds the first ${rows.length} rows only.</p></div>
  </div>
  </div></div>`;

  /* generated filter rules */
  const rules = [];
  for (const [k] of cats) {
    if (k !== 'all') rules.push(`.hl:has(#ct-${k}:checked) .hrow:not([data-cat="${k}"]){display:none}`);
    rules.push(`.hl:has(#ct-${k}:checked) label.chipsel__o[for="ct-${k}"] span{background:var(--c-sel-bg);color:var(--c-sel-ink);border-color:var(--c-sel-bg)}`);
    rules.push(`.hl:has(#ct-${k}:focus-visible) label[for="ct-${k}"]{outline:2px solid var(--c-focus);outline-offset:2px}`);
    if (k !== 'all' && counts[k] === 0) rules.push(`.hl:has(#ct-${k}:checked) #empty-filter{display:grid}`);
  }
  for (const k of ['namada', 'osmosis']) {
    rules.push(`.hl:has(#ch-${k}:checked) label.seg__opt[for="ch-${k}"] span{background:var(--c-sel-bg);color:var(--c-sel-ink)}`);
    rules.push(`.hl:has(#ch-${k}:focus-visible) label[for="ch-${k}"]{outline:2px solid var(--c-focus);outline-offset:2px}`);
  }
  rules.push('.hl:has(#ch-osmosis:checked) :is(.dl,.hl__count,.more--load,#empty-filter){display:none !important}.hl:has(#ch-osmosis:checked) #empty-osmosis{display:grid}');

  page({
    file: 'holders.html',
    title: 'Holders: who holds NAM?',
    desc: 'The biggest NAM holders with share of supply, 7-day change and when each balance was last checked.',
    active: 'activity',
    body: `${hero}${list}${footer()}`,
    css: rules.join('\n'),
    js: `(function(){var hl=document.querySelector('.hl'),b=hl.querySelector('.badge'),n=hl.querySelector('.hl__n'),go=hl.querySelector('.filters .btn--primary');function upd(){var c=0;if(hl.querySelector('#ch-osmosis').checked)c++;var all=hl.querySelector('#ct-all');if(!all.checked)c++;b.hidden=!c;b.textContent=c;var v=hl.querySelectorAll('.hrow'),k=0;v.forEach(function(r){if(r.offsetParent!==null)k++});n.textContent=k;if(go)go.textContent='Show '+k+' holder'+(k===1?'':'s')}
hl.addEventListener('change',upd);upd()})();`,
  });
}

home();
trade();
holders();
if (OUT !== HERE) fs.copyFileSync(path.join(HERE, 'tokens.css'), path.join(OUT, 'tokens.css'));
