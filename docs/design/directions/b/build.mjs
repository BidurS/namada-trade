// NamadaTrade, Direction B "Editorial instrument": static build.
//   node build.mjs          writes home.html, trade.html, holders.html next to this file.
// Every number on every page is read from ../../data/snapshot.json (plus two dated documents named below),
// formatted here, and printed with its provenance. Nothing numeric is typed into the markup by hand.
// Ages are computed relative to snapshot.capturedAt, never to the wall clock, so the pages are reproducible.
//
// Inputs:  ../../data/snapshot.json                 (live API snapshot)
//          ../../../replay-report.md                (static, dated proof block on Home; parsed, not retyped)
//          ../../../events.json                     (price-move markers on the Trade chart)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(here, p), 'utf8');
const snap = JSON.parse(read('../../data/snapshot.json'));
const CSS = read('styles.css');
const CAP = snap.capturedAt;
const DAY = 86_400_000, HOUR = 3_600_000;
const keyDays = (re) => +Object.keys(snap).find((k) => re.test(k)).match(/(\d+)/)[1];
const LONG_D = keyDays(/^executedHistory\d+d$/);   // 30, from the field name executedHistory30d
const SHORT_D = keyDays(/^priceHistory\d+d$/);     // 7, from priceHistory7d
const WIN_D = snap.pressure.windowDays;             // 7, pressure.windowDays
const CLIP_PCTS = Object.keys(snap.curve).map((k) => k.match(/^maxSafeClip(\d+)PctNam$/)).filter(Boolean).map((m) => +m[1]).sort((a, b) => a - b); // 1 and 3, from maxSafeClip1PctNam / maxSafeClip3PctNam
const NUMWORD = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
const OLD_AFTER_MS = 24 * HOUR; // design placeholder: rows with no explicit status are "old" after a day (production: server status)

/* ----------------------------------------------------------------- formatting */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nfs = {};
const N = (x, d = 0) => (nfs[d] ??= new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })).format(x);
const MINUS = '−';
const sgn = (x, d = 2) => (x < 0 ? MINUS : '+') + N(Math.abs(x), d) + '%';
const pc = (x, d = 1) => N(x, d) + '%';
const usdPrice = (x) => '$' + x.toFixed(6); // price keeps 6 decimals, sub-dollar never prints $0
const usd = (x) => (Number.isInteger(x) ? '$' + N(x, 0) : '$' + N(x, 2)); // whole-dollar fields stay whole, computed sizes get cents
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dUTC = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const dShort = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const tUTC = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
const tUTCs = (ms) => new Date(ms).toISOString().slice(11, 19) + ' UTC';
const dow = (ms) => DOW[new Date(ms).getUTCDay()];
const ageMs = (at) => Math.max(0, CAP - at);
function ageStr(at) {
  const s = ageMs(at) / 1000;
  if (s < 10) return 'just now';
  if (s < 60) return Math.round(s) + ' s';
  const m = s / 60; if (m < 60) return Math.round(m) + ' min';
  const h = m / 60; if (h < 24) return (h < 10 ? h.toFixed(1) : Math.round(h)) + ' h';
  const d = h / 24; return (d < 10 ? d.toFixed(1) : Math.round(d)) + ' days';
}
const ago = (at) => { const a = ageStr(at); return a === 'just now' ? a : a + ' ago'; };
function ageLong(at) {
  const s = ageMs(at) / 1000;
  if (s < 10) return 'just now';
  if (s < 60) return Math.round(s) + ' seconds ago';
  const m = s / 60; if (m < 60) return Math.round(m) + ' minutes ago';
  const h = m / 60; if (h < 24) return (h < 10 ? h.toFixed(1) : Math.round(h)) + ' hours ago';
  const d = h / 24; return (d < 10 ? d.toFixed(1) : Math.round(d)) + ' days ago';
}
const shortAddr = (a) => a.slice(0, 10) + '…' + a.slice(-4);

/* ----------------------------------------------------------------- provenance registry */
const PLAIN_SOURCE = {
  'Osmosis SQS': 'Osmosis quote',
  'Osmosis SQS pools': 'Osmosis pools',
  'executed NAM/USDC swaps (hourly median)': 'Executed trades, hourly median',
  'Namada RPC abci_query': 'Namada node',
  'Keplr Osmosis bank/supply': 'Osmosis supply record',
  'Namada RPC (MASP balance)': 'Namada node, shielded pool',
  'last indexed Osmosis flow': 'Flow index',
  'Namada RPC status': 'Namada node',
  'D1 flow index': 'Flow index',
  'Namada indexer (indexer.namada.net)': 'Namada indexer',
  'Keplr Osmosis REST (holders)': 'Osmosis holder list',
  'Namada RPC (stake verification)': 'Namada node, stake check',
};
const plain = (s) => PLAIN_SOURCE[s] ?? s;
const STATUS = { live: 'fresh', stale: 'old', missing: 'none', conflict: 'bad', fresh: 'fresh', old: 'old', none: 'none', bad: 'bad' };
const STATUS_WORD = { fresh: 'Fresh', old: 'Old', none: 'No data', bad: 'Sources disagree' };
const RANK = { fresh: 0, old: 1, none: 2, bad: 3 };
const statusOf = (given, at) => STATUS[given] ?? (at == null ? 'none' : ageMs(at) > OLD_AFTER_MS ? 'old' : 'fresh');
const srcAt = (name) => snap.overview.sources.find((s) => s.name === name);

function makeCtx() {
  const P = new Map();
  const ctx = {
    P,
    prov(key, o) {
      const status = statusOf(o.status, o.at);
      P.set(key, { key, label: o.label, source: plain(o.source), technical: o.technical ?? o.source, at: o.at, status, note: o.note, derived: o.derived });
      return key;
    },
    derive(key, label, keys, note) { // oldest "at", worst status of the inputs; every input named
      const ins = keys.map((k) => P.get(k));
      const at = Math.min(...ins.map((p) => p.at));
      const status = ins.reduce((w, p) => (RANK[p.status] > RANK[w] ? p.status : w), 'fresh');
      P.set(key, { key, label, source: 'Derived', technical: 'derived', at, status, note, derived: ins.map((p) => p.source).join(' and ') });
      return key;
    },
    num(html, key, cls = '', extra = '') {
      const p = P.get(key); if (!p) throw new Error('no prov ' + key);
      const sc = p.status === 'fresh' ? '' : ' num--' + p.status;
      return `<button type="button" class="num ${cls}${sc}" popovertarget="p-${key}" data-num data-status="${p.status}" ${extra}>${html}</button>`;
    },
    dot(status) { return `<span class="st st--${status}" aria-hidden="true"></span>`; },
    chip(key, text) {
      const p = P.get(key);
      return `<button type="button" class="chip" popovertarget="p-${key}"><span class="chip__p"><span class="st st--${p.status}" aria-hidden="true"></span>${esc(text ?? p.source)} · ${esc(ageStr(p.at))}</span></button>`;
    },
    age(key) {
      const p = P.get(key);
      return `<span class="age">${p.status === 'fresh' ? '' : ctx.dot(p.status)}${esc(ageStr(p.at))}</span>`;
    },
    // quiet source line under a panel: "Source: Name · as of HH:MM UTC · age"
    srcLine(keys, extra = '') {
      const parts = keys.map((k) => {
        const p = P.get(k);
        return `${ctx.num(esc(p.source), k)} <span class="when">as of ${tUTC(p.at)} · ${p.status === 'fresh' ? '' : ctx.dot(p.status) + ' '}${esc(ageStr(p.at))}${p.status === 'fresh' ? '' : ' (' + STATUS_WORD[p.status].toLowerCase() + ')'}</span>`;
      });
      return `<p class="src"><span>Source</span> ${parts.join(' <span>and</span> ')}${extra}</p>`;
    },
    sheets() {
      return [...P.values()].map((p) => `
<div id="p-${p.key}" popover class="sheet" aria-label="Where this number comes from">
  <div class="sheet__handle" aria-hidden="true"></div>
  <div class="sheet__h"><div><h3>${esc(p.label)}</h3><p>Where this number comes from</p></div>
    <button type="button" class="icon-btn" popovertarget="p-${p.key}" popovertargetaction="hide" aria-label="Close"><svg class="ico"><use href="#i-close"/></svg></button></div>
  <dl>
    <dt>Source</dt><dd>${esc(p.source)}</dd>
    ${p.technical && p.technical !== p.source && p.technical !== 'derived' ? `<dt>Technical name</dt><dd>${esc(p.technical)}</dd>` : ''}
    ${p.derived ? `<dt>Derived from</dt><dd>${esc(p.derived)}</dd>` : ''}
    <dt>As of</dt><dd>${dUTC(p.at)}, ${tUTCs(p.at)}</dd>
    <dt>Age</dt><dd>${esc(ageStr(p.at))}</dd>
    <dt>Status</dt><dd>${ctx.dot(p.status)}${STATUS_WORD[p.status]}</dd>
    ${p.note ? `<dt>Note</dt><dd>${esc(p.note)}</dd>` : ''}
  </dl>
  <div class="sheet__act"><a class="btn btn--outline" href="?at=${p.at}">Rewind to this time</a></div>
</div>`).join('\n');
    },
  };
  return ctx;
}

/* ----------------------------------------------------------------- icons */
const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="i-chev" viewBox="0 0 20 20"><path d="M5 8l5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-menu" viewBox="0 0 20 20"><path d="M3 6.5h14M3 13.5h14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
<symbol id="i-close" viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
<symbol id="i-arrow" viewBox="0 0 20 20"><path d="M4 10h12M11 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-check" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 10.3l2.4 2.4 4.6-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-alert" viewBox="0 0 20 20"><path d="M10 3.2l7.4 13H2.6z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8.3v3.6M10 14.3v.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
<symbol id="i-info" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v5M10 6.2v.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></symbol>
<symbol id="i-up" viewBox="0 0 10 10"><path d="M5 1.2l4 7H1z" fill="currentColor"/></symbol>
<symbol id="i-down" viewBox="0 0 10 10"><path d="M5 8.8l4-7H1z" fill="currentColor"/></symbol>
<symbol id="i-filter" viewBox="0 0 20 20"><path d="M3 5.5h14M6 10h8M8.5 14.5h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
<symbol id="i-lock" viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 7V5.2a2.8 2.8 0 015.6 0V7" fill="none" stroke="currentColor" stroke-width="1.4"/></symbol>
</defs></svg>`;

/* ----------------------------------------------------------------- shell */
const NAV = [
  { id: 'home', label: 'Home', href: 'home.html', gloss: 'What moved, who holds it, what it costs' },
  { id: 'trade', label: 'Price check', href: 'trade.html', gloss: 'What would I get if I sold NAM now?' },
  { id: 'sellers', label: 'Sellers', href: '#', gloss: 'Is a big sale coming?', unbuilt: true },
  { id: 'private', label: 'Private pool', href: '#', gloss: 'How much NAM can’t be seen?', unbuilt: true },
  { id: 'ledger', label: 'Ledger', href: 'holders.html', gloss: 'Every move, and who holds NAM' },
  { id: 'alerts', label: 'Alerts', href: '#', gloss: 'What should wake me up?', unbuilt: true },
];
const wordmark = '<a class="wm" href="home.html" aria-label="Namada Trade, home">Namada<i>Trade</i><b aria-hidden="true"></b></a>';

function topBar(ctx, current) {
  const chg = snap.overview.price.change24h;
  const chgHtml = `<span class="chg"><svg aria-hidden="true"><use href="#i-${chg < 0 ? 'down' : 'up'}"/></svg>${sgn(chg)}</span>`;
  const links = NAV.map((n) => `<a href="${n.href}"${n.id === current ? ' aria-current="page"' : ''}${n.unbuilt ? ' data-unbuilt' : ''}>${n.label}</a>`).join('');
  const items = NAV.map((n, i) => `<li><a href="${n.href}"${n.id === current ? ' aria-current="page"' : ''}${n.unbuilt ? ' data-unbuilt' : ''}>
      <span class="menu__no">0${i + 1}</span><span class="menu__name">${n.label}</span><span class="menu__gloss">${n.gloss}</span></a></li>`).join('');
  const checks = snap.overview.checks;
  const ok = checks.filter((c) => c.status === 'ok').length;
  return `
<a class="skip" href="#main">Skip to content</a>
<header class="bar"><div class="bar__in">
  ${wordmark}
  <nav class="bar__nav" aria-label="Primary">${links}</nav>
  <button type="button" class="bar__price" popovertarget="p-price" aria-label="NAM price, tap for source"><span>${usdPrice(snap.overview.price.usd.value)}</span>${chgHtml.replace('class="chg"', 'class="chg"').replace('<span class="chg">', '<span class="chg">')}</button>
  <button type="button" class="bar__menu" popovertarget="menu" aria-label="Open menu"><svg class="ico"><use href="#i-menu"/></svg></button>
</div></header>
<div id="menu" popover class="menu" aria-label="Menu">
  <div class="menu__top"><span>Menu</span><button type="button" class="icon-btn" popovertarget="menu" popovertargetaction="hide" aria-label="Close menu"><svg class="ico"><use href="#i-close"/></svg></button></div>
  <ul class="menu__list">${items}</ul>
  <div class="menu__foot"><p><span class="mono">${ok} of ${checks.length}</span> cross-checks pass. <a href="home.html#trust">Where every number comes from</a></p></div>
</div>`;
}

function footer(ctx) {
  const cov = snap.overview.namada.coverage; // oldest index in view
  return `
<footer class="foot"><div class="wrap">
  <div class="foot__wm" aria-hidden="true">Namada<i>Trade</i><b></b></div>
  <p>Every number shows its source and age. Data: Osmosis router, Namada nodes, indexer.namada.net. Flow records trail by up to ${ageLong(cov.at).replace(' ago', '')}. Not investment advice. Not affiliated with Namada or the Anoma Foundation.</p>
  <nav aria-label="Footer"><a href="home.html#trust">How we know</a><a href="#" data-unbuilt>Settings</a><a href="#" data-unbuilt>API</a></nav>
</div></footer>`;
}

const FONTS = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,300..600;1,6..72,300..600&family=Space+Grotesk:wght@400..700&display=swap';
function page({ title, desc, current, ctx, body, bandFirst = '', extraCss = '' }) {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#000000">
<!-- Mockup only: fonts load from Google Fonts. The production build self-hosts them (see notes.md). -->
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="tokens.css">
<style>
${CSS}
${extraCss}
</style>
</head>
<body>
${SPRITE}
${topBar(ctx, current)}
${body}
${footer(ctx)}
${ctx.sheets()}
<script>/* deep link to a sheet, for review: page.html#open-p-price */
(function(){var m=location.hash.match(/^#open-(.+)$/);if(!m)return;var e=document.getElementById(m[1]);if(e&&e.showPopover)requestAnimationFrame(function(){e.showPopover();});})();</script>
</body>
</html>
`;
}

/* ----------------------------------------------------------------- shared data */
const ov = snap.overview, sup = ov.supply, price = ov.price.usd.value;
const bs = snap.blindspot, pr = snap.pressure, cv = snap.curve;
const holders = snap.holders.holders;
const pctOf = (x) => (x / sup.total) * 100;
const curveRow = (n) => cv.curve.find((r) => r.amountNam === n);
const BY = (n) => snap.curve.curve.find((r) => r.amountNam === n);
const bandwidth = (pct) => Math.max(pct, 0);

// plain-language names for the five alert rules (rule ids unchanged; only the words are ours)
const RULE_WORDS = {
  ibc_inventory: { t: 'NAM bridged to Osmosis', tag: ['ibc', 'Bridged in', 'i-arrow'], d: (n) => `${N(n)} NAM or more crossed to Osmosis in one transfer` },
  unlock: { t: 'NAM unstaked', tag: ['pos', 'Unstaking', 'i-lock'], d: (n) => `${N(n)} NAM or more asked to leave staking, or came out` },
  big_swap: { t: 'Large trade', tag: ['buy', 'Trade', 'i-up'], d: (n) => `One buy or sell of ${N(n)} NAM or more, bot trades left out` },
  unshield: { t: 'NAM left the shielded set', tag: ['shield', 'Shielded out', 'i-arrow'], d: (n) => `${N(n)} NAM or more moved out of the shielded set to a personal address` },
  bond: { t: 'Large amount staked', tag: ['pos', 'Staked', 'i-lock'], d: (n) => `${N(n)} NAM or more staked at once` },
};
const tagHtml = (kind, word, icon) => `<span class="tag tag--${kind}"><svg aria-hidden="true"><use href="#${icon}"/></svg>${word}</span>`;

// the most recent past event that meets an alert rule (for the honest empty state)
function lastCrossing() {
  const rules = Object.fromEntries(snap.rules.map((r) => [r.id, r.thresholdNam]));
  const out = [];
  for (const u of pr.unlocks) {
    if (u.kind === 'bond' && u.amountNam >= rules.bond) out.push({ rule: 'bond', ts: u.ts, nam: u.amountNam, kind: 'staked' });
    if ((u.kind === 'unbond' || u.kind === 'withdraw') && u.amountNam >= rules.unlock) out.push({ rule: 'unlock', ts: u.ts, nam: u.amountNam, kind: 'unstaked' });
  }
  for (const u of bs.unshields) if (u.amount >= rules.unshield) out.push({ rule: 'unshield', ts: u.ts, nam: u.amount, kind: 'left the shielded set' });
  out.sort((a, b) => b.ts - a.ts);
  return out[0] ?? null;
}

// static, dated proof block: parsed from docs/replay-report.md at build time
function replayFacts() {
  try {
    const md = read('../../../replay-report.md');
    const gen = md.match(/Generated (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC/);
    const events = md.match(/\((\d+) events/);
    const flag = md.match(/flagged ahead of time: (\d+) \/ (\d+)/);
    const lead = md.match(/Median lead ([\d.]+) h/);
    const base = md.match(/Base rate:\*\* (\d+)%/);
    const win = md.match(/in the (\d+)h before/);
    const whale = md.match(/whale_namada:6C19[^|]*\| withdraw ([\d,]+)[^|]*\|[^|]*\| (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/);
    if (!gen || !events || !flag || !lead || !base || !win) return null;
    const g = new Date(gen[1].replace(' ', 'T') + ':00Z');
    let w = null;
    if (whale) { const ts = new Date(`${whale[2]}T${whale[3]}:00Z`).getTime(); w = { nam: whale[1], ts, date: dUTC(ts), time: tUTC(ts) }; }
    return { generated: `${dUTC(g.getTime())}, ${tUTC(g.getTime())}`, events: events[1], flagged: flag[1], of: flag[2], lead: lead[1], base: base[1], window: win[1], whale: w };
  } catch { return null; }
}

let secN = 0; // running index for numbered sections; reset per page
const sec = (id, no, title, body, cls = '') => `
  <section class="sec reveal ${cls}" id="${id}" aria-labelledby="h-${id}">
    <div class="sec__head"><p class="sec__no mono">${no ?? String(++secN).padStart(2, '0')}</p><h2 id="h-${id}">${title}</h2></div>
    <div class="sec__body">${body}</div>
  </section>`;

/* ============================================================================= HOME */
function home() {
  secN = 0;
  const c = makeCtx();
  const chg = ov.price.change24h;
  c.prov('price', { label: 'NAM price', source: ov.price.usd.prov.source, at: ov.price.usd.prov.at, status: ov.price.usd.prov.status, note: 'The change is measured against the price 24 hours earlier.' });
  const idx = srcAt('Namada indexer (indexer.namada.net)');
  c.prov('holders', { label: 'Holders on Namada', source: idx.name, at: idx.at, status: idx.ok ? 'live' : 'missing' });
  const oh = srcAt('Keplr Osmosis REST (holders)');
  c.prov('osmHolders', { label: 'Holders on Osmosis', source: oh.name, at: oh.at, status: oh.ok ? 'live' : 'missing' });
  c.prov('supply', { label: 'NAM supply, split', source: sup.prov.source, at: sup.prov.at, status: sup.prov.status });
  c.prov('osmSupply', { label: 'NAM on Osmosis', source: sup.osmosisProv.source, at: sup.osmosisProv.at, status: sup.osmosisProv.status });
  c.prov('shielded', { label: 'Shielded NAM', source: bs.shielded.prov.source, at: bs.shielded.prov.at, status: bs.shielded.prov.status });
  c.derive('shieldedShare', 'Share of NAM that is shielded', ['shielded', 'supply'], 'Shielded NAM divided by all NAM.');
  c.derive('osmShare', 'Share of NAM on Osmosis', ['osmSupply', 'supply'], 'NAM on Osmosis divided by all NAM.');
  c.prov('pools', { label: 'Pool liquidity on Osmosis', source: ov.dex.prov.source, at: ov.dex.prov.at, status: ov.dex.prov.status });
  c.prov('flowOsm', { label: 'Osmosis flow records', source: ov.dex.coverage.source, at: ov.dex.coverage.at, status: ov.dex.coverage.status, note: ov.dex.coverage.note });
  c.prov('flowNam', { label: 'Namada flow records', source: ov.namada.coverage.source, at: ov.namada.coverage.at, status: ov.namada.coverage.status, note: ov.namada.coverage.note });
  c.prov('alerts', { label: 'Alerts in the last 24 hours', source: 'Alert rules over the flow index', at: snap.alerts.until, status: 'live', note: 'Only as complete as the flow records beneath it.' });
  c.prov('unbond', { label: 'Unstaking wait', source: 'Namada chain parameter', at: pr.asOf, status: 'live' });
  c.prov('ibc7', { label: `NAM bridged to Osmosis, ${WIN_D} days`, source: pr.coverage.source, at: pr.coverage.at, status: pr.coverage.status, note: pr.coverage.note });
  c.prov('conc', { label: 'Top ten share, Namada', source: 'Namada indexer', at: idx.at, status: 'live' });
  c.prov('concOsm', { label: 'Top ten share, Osmosis', source: oh.name, at: oh.at, status: 'live' });
  c.prov('curve', { label: 'Size table', source: cv.prov.source, at: cv.prov.at, status: cv.prov.status, note: 'Quotes at six order sizes, measured at once.' });
  const hAt = Math.min(...holders.map((h) => Math.min(h.verifiedAt, h.bondedVerifiedAt)));
  c.prov('hold', { label: 'Holder balances', source: 'Namada indexer, stake check by Namada nodes', technical: 'Namada indexer (indexer.namada.net) + Namada RPC (stake verification)', at: hAt, status: undefined, note: 'Each row shows its own check time; this is the oldest.' });
  const chk = ov.checks; const checkAt = Math.min(...chk.map((k) => k.checkedAt));
  c.prov('checks', { label: 'Cross-checks', source: 'Namada nodes and Osmosis records', at: checkAt, status: 'live' });
  c.prov('price24', { label: 'Price 24 hours ago', source: ov.price.usd.prov.source, at: ov.price.usd.prov.at, status: ov.price.usd.prov.status });

  // ---- numbers
  const staked = pctOf(sup.bonded), pgf = pctOf(sup.pgf), osm = pctOf(sup.osmosis), spend = pctOf(sup.transparentLiquid);
  const shieldedPct = bs.sharePct;
  const segs = [
    { k: 'osm', w: 'On Osmosis', g: 'The one place NAM can be sold', pct: osm, amt: sup.osmosis, c: 'var(--ink)', key: 'osmSupply', cls: 'is-osm' },
    { k: 'spend', w: 'Everything else, spendable', g: 'Ordinary wallets on Namada, free to move', pct: spend, amt: sup.transparentLiquid, c: 'var(--line-strong)', key: 'supply' },
    { k: 'staked', w: 'Staked', g: 'Locked with validators, cannot be sold', pct: staked, amt: sup.bonded, c: 'var(--ink-2)', key: 'supply' },
    { k: 'pgf', w: 'Public funding', g: 'Set aside for public goods', pct: pgf, amt: sup.pgf, c: 'var(--ink-3)', key: 'supply' },
    { k: 'shield', w: 'Shielded', g: 'Total is public, owners are not', pct: shieldedPct, amt: bs.shielded.value, c: 'var(--shielded)', key: 'shielded' },
  ];
  const BAR_LABEL = { spend: 'Spendable', staked: 'Staked' }; // direct labels only on segments wide enough to hold them
  const segBar = segs.map((s, i) => `<span class="supply__seg" style="--c:${s.c};--i:${i};flex:${s.pct} 1 0${s.k === 'spend' ? ';--seg-ink:var(--ink)' : ''}" title="${esc(s.w)} ${pc(s.pct)}">${s.pct >= 15 && BAR_LABEL[s.k] ? BAR_LABEL[s.k] : ''}</span>`).join('');
  const segRows = segs.map((s) => `<li class="${s.cls ?? ''}"><span class="supply__sw" style="--c:${s.c}"></span>
      <div><div class="supply__w">${s.w}</div><div class="supply__g">${s.g}</div></div>
      <div class="supply__v"><span class="supply__pct">${c.num(pc(s.pct), s.k === "shield" ? "shieldedShare" : s.k === "osm" ? "osmShare" : s.key, "num--pad")}</span><span class="supply__amt">${N(s.amt)} NAM</span></div></li>`).join('');

  const maxPct = Math.max(...holders.map((h) => h.pctSupply));
  const allStill = holders.every((h) => h.change7d === 0);
  const holderRows = holders.map((h) => holderRowRows(c, h, maxPct, 'hold')).join('');
  const holderTbl = holdersTable(c, holders, maxPct, 'hold', { compact: true });

  // ---- what changed
  const last = lastCrossing();
  const winH = Math.round((snap.alerts.until - snap.alerts.since) / HOUR);
  const bigRule = snap.rules.find((r) => r.id === 'big_swap');
  const tenK = bigRule.thresholdNam * price;
  c.derive('tenK', `${N(bigRule.thresholdNam)} NAM at today’s price`, ['price'], `${N(bigRule.thresholdNam)} NAM times the quoted price.`);
  const hits = snap.alerts.hits;
  const changedBody = hits.length === 0 ? `
    <p class="big-sentence">Nothing crossed an alert size.</p>
    ${last ? `<p class="last"><span class="ink-2">The last one:</span> ${tagHtml(...(last.rule === 'unshield' ? ['shield', 'Shielded out', 'i-arrow'] : RULE_WORDS[last.rule].tag))}
      <span><span class="mono">${N(last.nam)}</span> NAM ${last.kind}, ${esc(ago(last.ts))}.</span>
      <a href="?at=${last.ts}">Rewind to it</a></p>` : '<p class="note">No past crossing in the records we hold.</p>'}
    <p class="note">Alert sizes are small on purpose: at today’s price ${N(bigRule.thresholdNam)} NAM is ${c.num(usd(tenK), 'tenK')}.</p>
    <p class="caveat"><span class="st st--old" aria-hidden="true"></span><span>This only covers what the flow index has seen. Osmosis moves are in up to ${c.num(esc(ageStr(ov.dex.coverage.at)), 'flowOsm')} ago, Namada moves up to ${c.num(esc(ageStr(ov.namada.coverage.at)), 'flowNam')} ago, so a very recent move may be missing.</span></p>`
    : `<ul class="hits">${hits.map((h) => `<li><span>${esc(h.title ?? h.ruleId ?? 'Alert')}</span><span class="mono">${esc(ago(h.ts ?? snap.alerts.until))}</span></li>`).join('')}</ul>`;
  const rulesList = snap.rules.map((r) => {
    const w = RULE_WORDS[r.id];
    return `<li><span class="rules__t">${w.t}</span><span class="rules__n">${c.num(N(r.thresholdNam), "alerts", "num--pad")}<small>NAM</small></span>
      <span class="rules__d">${w.d(r.thresholdNam)}</span></li>`;
  }).join('');

  // ---- five questions
  const stakedN = N(sup.bonded), osmN = N(sup.osmosis);
  const q = [
    { t: 'Who holds NAM?', peek: N(ov.namada.holders), big: c.num(N(ov.namada.holders), 'holders'), unit: `holders on Namada, and ${c.num(N(ov.dex.holders), 'osmHolders')} on Osmosis`,
      a: [`The ten biggest hold ${c.num(pc(ov.concentration.namadaTop10Pct), 'conc')} of NAM on Namada. On Osmosis the ten biggest hold ${c.num(pc(ov.concentration.osmosisTop10Pct), 'concOsm')} of what is there.`, `Most large holders are the foundation, early contributors and backers who received NAM at launch.`], key: 'holders' },
    { t: 'Can I sell it?', peek: pc(osm), big: c.num(pc(osm), 'osmShare'), unit: 'of all NAM is on Osmosis, the one place it can be sold',
      a: [`That is ${c.num(osmN, 'osmSupply')} NAM. Everything else is staked, shielded, set aside, or in wallets on Namada. To be sold, it has to cross to Osmosis first.`], key: 'osmShare' },
    { t: 'Where is the rest?', peek: pc(staked), big: c.num(pc(staked), 'supply'), unit: 'of all NAM is staked with validators',
      a: [`Staked NAM, ${c.num(stakedN, 'supply')} of it, cannot be sold. Another ${c.num(pc(pgf), 'supply')} is public funding and ${c.num(pc(shieldedPct), 'shieldedShare')} is in the shielded set, where the total is public and the owners are not.`, `The remaining ${c.num(pc(spend), 'supply')} sits in ordinary wallets on Namada.`], key: 'supply' },
    { t: 'How does it reach the market?', peek: N(pr.unbondingDays, 2) + ' days', big: c.num(N(pr.unbondingDays, 2), 'unbond') + '<span class="q__u" style="font-size:.4em;letter-spacing:0;margin-left:.2em">days</span>', unit: 'the wait to unstake NAM',
      a: [`Asking to unstake starts a ${c.num(N(pr.unbondingDays, 2), 'unbond')} day wait. After that NAM can cross to Osmosis: ${c.num(N(pr.ibcIn7d), 'ibc7')} NAM crossed in the last ${WIN_D} days.`, `Crossings usually come before sales.`], key: 'unbond' },
    { t: 'What does a sale cost?', peek: pc(BY(10000).sellImpactPct, 2), big: c.num(pc(BY(10000).sellImpactPct, 2), 'curve'), unit: `price move for selling ${N(BY(10000).amountNam)} NAM`,
      a: [`NAM trades in small pools on Osmosis: ${c.num(usd(ov.dex.liquidityUsd), 'pools')} in all, across ${N(snap.pools.pools.length)} pools. Selling ${N(BY(100000).amountNam)} NAM would move the price ${c.num(pc(BY(100000).sellImpactPct, 2), 'curve')}.`], key: 'curve' },
  ];
  const qHtml = q.map((x, i) => `
    <details class="q" name="five"${i === 0 ? ' open' : ''}>
      <summary><span class="q__t">${x.t}</span><span class="q__peek">${x.peek}</span><svg class="ico q__chev" aria-hidden="true"><use href="#i-chev"/></svg></summary>
      <div class="q__a"><p class="q__lead"><span class="q__big">${x.big}</span><span class="q__unit">${x.unit}</span></p>
        ${x.a.map((t) => `<p class="prose">${t}</p>`).join('')}
        ${c.srcLine([x.key])}</div>
    </details>`).join('');

  // ---- mini ticket (static snapshot; quote5000 has no quote)
  const q5 = snap.quote5000, row5 = BY(5000);
  const noQuote = !q5.quote;
  const ticket = `
    <div class="ticket">
      <div class="ticket__top">
        <div class="ticket__row"><span class="pill-state"><span class="st st--${noQuote ? 'none' : 'fresh'}" aria-hidden="true"></span>${noQuote ? 'No live quote' : 'Live quote'}</span>
          <span class="age">Snapshot, ${tUTC(CAP)}</span></div>
        <p class="ticket__amt">Sell <span class="mono">${N(row5.amountNam)}</span> NAM for USDC</p>
      </div>
      <div class="ticket__tear" aria-hidden="true"></div>
      <div class="ticket__body">
        <div class="ticket__get"><span class="l">You get</span><span class="ticket__none">—</span></div>
        <p class="ticket__why">The Osmosis quote service is not answering. Last quoted price: ${c.num(usdPrice(price), 'price')}, ${esc(ago(ov.price.usd.prov.at))}.</p>
        <p class="ticket__est"><span>From the size table instead:</span> <span class="mono">${c.num(N(row5.sellOutUsdc, 2) + ' USDC', 'curve')}</span> <span>with a price move of</span> <span class="mono">${c.num(MINUS + N(row5.sellImpactPct, 2) + '%', 'curve')}</span></p>
      </div>
    </div>
    <a class="more" href="trade.html">Full quote <svg class="ico" aria-hidden="true"><use href="#i-arrow"/></svg></a>`;

  // ---- trust
  const ok = chk.filter((k) => k.status === 'ok').length, warn = chk.length - ok;
  const CHECKS = {
    ibc_conservation: ['NAM held in escrow on Namada matches NAM issued on Osmosis', (k) => ['Off by', N(k.detail.driftNam) + ' NAM']],
    rpc_consensus: ['Two independent Namada nodes agree on the chain', (k) => ['Blocks apart', N(k.detail.heightDiff)]],
    supply_integrity: ['Locked and escrowed NAM never exceed what exists', (k) => ['Locked or set aside', k.detail.pctLocked]],
    indexer_lag: ['The Namada indexer is level with the chain', (k) => ['Blocks behind', N(k.detail.lagBlocks)]],
    supply_cross_source: ['Two sources report the same total supply', (k) => ['Difference', N(k.detail.diffNam) + ' NAM']],
    price_vs_execution: ['The quoted price is close to what trades paid', (k) => ['Gap', N(+k.detail.deviationPct, 2) + '%']],
    bonded_coverage: ['Staked NAM we can confirm address by address', (k) => ['Confirmed', k.detail.coveragePct]],
  };
  const sorted = [...chk].sort((a, b) => (a.status === b.status ? 0 : a.status === 'warn' ? -1 : 1));
  const checkRows = sorted.map((k) => {
    const [t, f] = CHECKS[k.key]; const [lab, val] = f(k); const good = k.status === 'ok';
    return `<li><svg class="ck ck--${good ? 'ok' : 'warn'}" aria-hidden="true"><use href="#i-${good ? 'check' : 'alert'}"/></svg>
      <div><div class="checks__t">${t}</div><div class="checks__d"><span>${good ? 'Passes' : 'Needs a look'}</span><span class="w">·</span><span>${lab}</span>${c.num(val, 'checks')}</div></div></li>`;
  }).join('');
  const rp = replayFacts();
  const proof = rp ? `
    <div class="proof"><span class="tag">Static, dated ${esc(rp.generated.split(',')[0])}</span>
      <p class="prose">Tested on ${rp.events} past events (report of ${esc(rp.generated)}): each of the ${rp.of} biggest price moves had an alert-size flow in the prior ${rp.window} hours, median ${rp.lead} hours ahead. Such flows precede ${rp.base}% of all hours, so this shows the alerts are not blind, not that they predict direction.</p></div>` : '';

  const body = `
<main id="main">
<section class="band" aria-labelledby="h1">
  <div class="band__in">
    <p class="dateline"><span>${dow(CAP)} ${dUTC(CAP)}, ${tUTC(CAP)}</span><span>NAM on Osmosis</span></p>
    <div class="band__grid">
      <h1 class="display" id="h1"><span>NAM, in</span><span>plain sight.</span></h1>
      <div class="band__side">
        <p class="lede">One NAM, the coin of the Namada network, costs <span class="nb">${c.num(usdPrice(price), 'price', 'px')},</span> ${c.num(`<svg aria-hidden="true"><use href="#i-${chg < 0 ? 'down' : 'up'}"/></svg>${sgn(chg)}`, 'price', 'chg-pill')} since this time yesterday.</p>
        <p class="sub">Who holds it, who might sell it, and what a trade really costs. Every number shows its source and age: tap one.</p>
        ${c.chip('price', 'Osmosis quote')}
        <div class="band__act"><a class="btn btn--inverse" href="trade.html">See what a trade costs <svg class="ico" aria-hidden="true"><use href="#i-arrow"/></svg></a><a class="btn btn--ghost" href="#trust">How we know</a></div>
      </div>
    </div>
    <dl class="facts">
      <div><dt>holders on Namada</dt><dd>${c.num(N(ov.namada.holders), 'holders')}</dd></div>
      <div><dt>shielded</dt><dd>${c.num(pc(shieldedPct), 'shieldedShare')}</dd></div>
      <div><dt>on Osmosis</dt><dd>${c.num(pc(osm), 'osmShare')}</dd></div>
      <div class="facts__x"><dt>held by the pools</dt><dd>${c.num(usd(ov.dex.liquidityUsd), 'pools')}</dd></div>
      <div class="facts__x"><dt>to unstake</dt><dd>${c.num(N(pr.unbondingDays, 2), 'unbond')}<small>days</small></dd></div>
    </dl>
  </div>
</section>

<div class="wrap home">
${sec('changed', null, `What changed in the last ${winH} hours`, `
    ${changedBody}
    <details class="q q--s"><summary><span class="q__t">What sets off an alert</span><span class="q__peek">${N(snap.rules.length)} sizes</span><svg class="ico q__chev" aria-hidden="true"><use href="#i-chev"/></svg></summary>
      <div class="q__a"><ul class="rules" aria-label="Alert sizes">${rulesList}</ul></div></details>
    ${c.srcLine(['alerts'])}`)}

${sec('where', null, 'Where is all the NAM?', `
    <p class="lede">Only ${c.num(pc(osm), 'osmShare')} of NAM, ${c.num(osmN + ' NAM', 'osmSupply')}, is on Osmosis, the one place it can be sold. The pools there hold ${c.num(usd(ov.dex.liquidityUsd), 'pools')}.</p>
    <div class="supply" role="img" aria-label="Bar showing where all NAM is">
      <p class="supply__note" aria-hidden="true"><i></i>${pc(osm)} can be sold today</p>
      <div class="supply__bar" aria-hidden="true">${segBar}</div>
    </div>
    <ul class="supply__rows">${segRows}</ul>
    ${c.srcLine(['supply', 'osmSupply'])}`)}

${sec('holders', null, 'Who holds NAM', `
    <p class="lede">The ten biggest holders own ${c.num(pc(ov.concentration.namadaTop10Pct), 'conc')} of NAM on Namada.</p>
    ${holdersNote(c, holders, 'hold')}
    <ol class="hlist rows-only">${holderRows}</ol>
    ${holderTbl}
    <p class="note">Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone.</p>
    <a class="more" href="holders.html">All ${c.num(N(snap.holders.total), 'holders')} holders <svg class="ico" aria-hidden="true"><use href="#i-arrow"/></svg></a>
    ${c.srcLine(['hold'])}`)}

${sec('how', null, 'How NAM gets from a wallet to a sale', `
    <p class="lede">${NUMWORD[q.length]} plain questions, each answered with a number from this page.</p>
    <div class="qs">${qHtml}</div>`)}

${sec('quote', null, 'What would you get right now?', `
    ${ticket}
    ${c.srcLine(['curve'])}`)}

${sec('trust', null, 'Why you can trust these numbers', `
    <p class="lede"><b>${ok} of ${chk.length}</b> cross-checks pass right now${warn ? `, and ${warn} need${warn === 1 ? 's' : ''} a look` : ''}.</p>
    <ul class="checks">${checkRows}</ul>
    <div class="trust-pts">
      <div><h3>Every number shows its source and age</h3><p class="note" style="margin-top:0">Tap one to see them. Numbers that have gone old are dimmed and say how old.</p></div>
      <div><h3>Rewind</h3><p class="note" style="margin-top:0">See the site as it was. ${rp && rp.whale ? `Try <a href="?at=${rp.whale.ts}">${rp.whale.date}, ${rp.whale.time}</a>, when ${rp.whale.nam} NAM left staking.` : ''}</p></div>
    </div>
    ${proof}
    ${c.srcLine(['checks'])}`)}
</div>
</main>`;
  return page({ title: 'NAM, in plain sight. · Namada Trade', desc: 'Live NAM price, who holds it, who might sell, how much is shielded and what a trade costs on Osmosis. Every number shows its source and age.', current: 'home', ctx: c, body });
}

/* ----------------------------------------------------------------- holders pieces (Home and Ledger) */
const CLEAN = (l) => l.replace(/^Genesis: /, 'Genesis, ').replace(/_/g, ' ');
const holderName = (h) => (h.label ? CLEAN(h.label) : shortAddr(h.address));
const catOf = (h) => h.category ?? 'none';
function holderRowRows(c, h, maxPct, key) {
  const at = Math.min(h.verifiedAt, h.bondedVerifiedAt);
  const old = statusOf(undefined, at) !== 'fresh';
  const st = statusOf(undefined, at);
  return `<li class="hrow${old ? ' is-old' : ''}" data-cat="${catOf(h)}" style="--w:${(h.pctSupply / maxPct) * 100}">
    <span class="hrow__rank">${h.rank}</span>
    <div class="hrow__who"><b${h.label ? '' : ' class="mono"'}>${esc(holderName(h))}</b>${h.label ? `<span class="addr">${shortAddr(h.address)}</span>` : ''}</div>
    <button type="button" class="hrow__tot${old ? ' num--old' : ''}" popovertarget="p-${key}" data-num data-status="${st}"><span class="hrow__t">${N(h.total)}<small>NAM</small></span><span class="hrow__p">${pc(h.pctSupply, 2)} of supply</span></button>
    <span class="hrow__bar" aria-hidden="true"></span></li>`;
}
// one honest line above a holder list: stillness and staleness, stated once instead of on every row
function holdersNote(c, rows, key) {
  const still = rows.every((h) => h.change7d === 0);
  const at = Math.min(...rows.map((h) => Math.min(h.verifiedAt, h.bondedVerifiedAt)));
  const old = statusOf(undefined, at) !== 'fresh';
  const bits = [];
  if (still) bits.push(`No balance here changed in the last ${WIN_D} days.`);
  if (old) bits.push(`${c.dot('old')} Balances were last checked ${c.num(esc(ageLong(at)), key)}, so they are shown dimmed.`);
  return bits.length ? `<div class="stillness">${bits.map((b) => `<p>${b}</p>`).join('')}</div>` : '';
}
function holdersTable(c, rows, maxPct, key, { compact = false } = {}) {
  const still = rows.every((h) => h.change7d === 0); // all zero: the sentence above the list says so once, the column would repeat it ten times
  const th7 = still ? '' : `<th class="r">${WIN_D} days</th>`;
  const head = compact
    ? `<th class="c-rank">#</th><th>Holder</th><th class="r">Total NAM</th><th class="r">Share of supply</th>${th7}<th>Checked</th>`
    : `<th class="c-rank">#</th><th>Holder</th><th class="r c-md">Spendable</th><th class="r c-md">Staked</th><th class="r">Total NAM</th><th class="r">Share of supply</th>${th7}<th>Checked</th>`;
  const body = rows.map((h) => {
    const at = Math.min(h.verifiedAt, h.bondedVerifiedAt); const old = statusOf(undefined, at) !== 'fresh';
    return `<tr class="${old ? 'is-old' : ''}" data-cat="${catOf(h)}"><td class="c-rank">${h.rank}</td>
      <td class="t-who"><b>${esc(holderName(h))}</b>${h.label ? `<span class="addr">${shortAddr(h.address)}</span>` : ''}</td>
      ${compact ? '' : `<td class="r c-md">${c.num(N(h.balance), key)}</td><td class="r c-md">${c.num(N(h.bonded), key)}</td>`}
      <td class="r">${c.num(N(h.total), key)}</td>
      <td class="r">${pc(h.pctSupply, 2)}<span class="t-bar" style="--w:${(h.pctSupply / maxPct) * 100}"></span></td>
      ${still ? '' : `<td class="r">${sgn(h.change7d, 2)}</td>`}
      <td><span class="age">${old ? c.dot('old') : ''}${esc(ago(at))}</span></td></tr>`;
  }).join('');
  return `<div class="tbl-wrap tbl-only"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ============================================================================= TRADE */
const SIZES = snap.curve.curve.map((r) => r.amountNam);
const DEFAULT_SIZE = 5000;

// 1-2-5 ticks
function niceTicks(min, max, n = 4) {
  const raw = (max - min) / n; const p = 10 ** Math.floor(Math.log10(raw)); const f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  const t0 = Math.ceil(min / step) * step; const ticks = [];
  for (let v = t0; v <= max + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return { ticks, step };
}

function chartSvg({ w, h, range }) {
  const t1 = CAP, t0 = CAP - range * DAY;
  const exec = snap.executedHistory30d.filter((p) => p.ts >= t0);
  const quote = [...snap.priceHistory7d, { ts: ov.price.usd.prov.at, value: price }].filter((p) => p.ts >= t0);
  const vals = [...exec, ...quote].map((p) => p.value);
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.1; lo -= pad; hi += pad * 1.6;
  const { ticks, step } = niceTicks(lo, hi, w < 400 ? 4 : 5);
  const dec = Math.max(4, Math.ceil(-Math.log10(step)));
  const m = { t: 18, r: 2, b: 22, l: 2 };
  const X = (t) => m.l + ((t - t0) / (t1 - t0)) * (w - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (h - m.t - m.b);
  const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.ts).toFixed(1)} ${Y(p.value).toFixed(1)}`).join('');
  const grid = ticks.map((v) => `<line class="ch-grid" x1="${m.l}" x2="${w - m.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="ch-tick" x="${m.l}" y="${(Y(v) - 5).toFixed(1)}">$${v.toFixed(dec)}</text>`).join('');
  // x ticks: whole days counted back from the snapshot
  const stepD = range <= 7 ? 2 : 7; const xt = [];
  for (let d = 0; d * stepD <= range; d++) { const t = t1 - d * stepD * DAY; if (t >= t0) xt.push(t); }
  const xlab = xt.map((t, i) => { const x = X(t); const a = i === 0 ? 'end' : x < 24 ? 'start' : 'middle'; return `<text class="ch-tick" x="${(i === 0 ? w - m.r : x).toFixed(1)}" y="${h - 5}" text-anchor="${a}">${dShort(t)}</text>`; }).join('');
  // markers: three biggest recorded price moves inside the window (docs/events.json)
  let markers = '';
  try {
    const ev = JSON.parse(read('../../../events.json')).events.filter((e) => e.type === 'price_move' && e.t1 >= t0 && e.t1 <= t1).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 3);
    markers = ev.map((e) => { const x = X(e.t1); const lab = (e.pct < 0 ? MINUS : '+') + N(Math.abs(e.pct), 1) + '%'; const tx = Math.min(Math.max(x, 22), w - 22);
      return `<line class="ch-ev" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${m.t - 4}" y2="${h - m.b}"/><text class="ch-evt" x="${tx.toFixed(1)}" y="${m.t - 7}" text-anchor="middle">${lab}</text>`; }).join('');
  } catch {}
  const dots = exec.map((p) => `<circle class="ch-dot" cx="${X(p.ts).toFixed(1)}" cy="${Y(p.value).toFixed(1)}" r="${range <= 7 ? 2.4 : 1.8}"/>`).join('');
  const lastQ = quote[quote.length - 1];
  const pillW = 72, px = w - m.r - pillW, py = Y(lastQ.value) - 26;
  const pill = `<g><rect class="ch-pill" x="${px}" y="${py.toFixed(1)}" width="${pillW}" height="18" rx="9"/><text class="ch-pillt" x="${px + pillW / 2}" y="${(py + 12.5).toFixed(1)}" text-anchor="middle">${usdPrice(lastQ.value)}</text></g>`;
  const first = exec[0], ex = exec.map((p) => p.value);
  const label = `Price of NAM over ${range} days. Executed trades from ${usdPrice(Math.min(...ex))} to ${usdPrice(Math.max(...ex))}; latest quote ${usdPrice(lastQ.value)}.`;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">
    ${markers}${grid}<line class="ch-axis" x1="${m.l}" x2="${w - m.r}" y1="${h - m.b}" y2="${h - m.b}"/>${xlab}
    <g class="ch-lines"><path class="ch-quote" d="${line(quote)}"/><path class="ch-exec" d="${line(exec)}"/>${dots}</g>${pill}</svg>`;
}

function trade() {
  const c = makeCtx();
  c.prov('price', { label: 'NAM price', source: ov.price.usd.prov.source, at: ov.price.usd.prov.at, status: ov.price.usd.prov.status, note: 'The change is measured against the price 24 hours earlier.' });
  c.prov('curve', { label: 'Size table', source: cv.prov.source, at: cv.prov.at, status: cv.prov.status, note: 'Quotes at six order sizes, measured at once.' });
  c.prov('pools', { label: 'Pool liquidity on Osmosis', source: snap.pools.prov.source, at: snap.pools.prov.at, status: snap.pools.prov.status });
  c.prov('swap', { label: 'Last trade price', source: ov.price.swap1h.prov.source, at: ov.price.swap1h.prov.at, status: ov.price.swap1h.prov.status, note: 'Median of the real swaps in the last hour that had any.' });
  c.derive('buyCost', 'You pay, buying', ['curve'], 'Average price times order size. The snapshot holds no direct quote for a purchase.');
  c.prov('moves', { label: 'Biggest recorded price moves', source: 'Event set', at: JSON.parse(read('../../../events.json')).generatedAt, status: 'live', note: 'Markers on the chart.' });
  const rows = snap.curve.curve; const maxImp = Math.max(...rows.flatMap((r) => [r.sellImpactPct, r.buyImpactPct]));
  const q5 = snap.quote5000;

  const radios = `
    <input class="vh" type="radio" name="side" id="side-sell" checked><input class="vh" type="radio" name="side" id="side-buy">
    ${SIZES.map((s) => `<input class="vh" type="radio" name="size" id="sz-${s}"${s === DEFAULT_SIZE ? ' checked' : ''}>`).join('')}
    <input class="vh" type="radio" name="range" id="rng-${LONG_D}" checked><input class="vh" type="radio" name="range" id="rng-${SHORT_D}">`;

  // "You get" blocks: one per side and size
  const gets = [];
  for (const r of rows) {
    const spot = cv.spotUsd;
    gets.push(`<div class="get get--sell get--${r.amountNam}" data-side="sell" data-size="${r.amountNam}">
      <p class="get__l">You get</p>
      <p class="get__n"><span class="get__v">${c.num(N(r.sellOutUsdc, 2), 'curve', 'get__v-n')}</span><span class="get__u">USDC</span></p>
      <div class="get__move">
        <div><span class="k">Price move</span><span class="v">${c.num(MINUS + N(r.sellImpactPct, 2) + '%', 'curve')}</span></div>
        <div><span class="k">Your average price</span><span class="v">${c.num(usdPrice(r.sellEffectiveUsd), 'curve')}</span></div>
        <div><span class="k">Quoted price</span><span class="v">${c.num(usdPrice(spot), 'price')}</span></div>
      </div>
      ${r.sellImpactPct >= CLIP_PCTS[CLIP_PCTS.length - 1] ? '<p class="get__tip">That is a lot for pools this small. The same NAM sold in smaller orders moves the price less.</p>' : ''}
    </div>`);
    const payTotal = r.buyEffectiveUsd * r.amountNam;
    gets.push(`<div class="get get--buy get--${r.amountNam}" data-side="buy" data-size="${r.amountNam}">
      <p class="get__l">You pay</p>
      <p class="get__n"><span class="get__v">${c.num(N(payTotal, 2), 'buyCost', 'get__v-n')}</span><span class="get__u">USDC</span></p>
      <div class="get__move">
        <div><span class="k">Price move</span><span class="v">${c.num('+' + N(r.buyImpactPct, 2) + '%', 'curve')}</span></div>
        <div><span class="k">Your average price</span><span class="v">${c.num(usdPrice(r.buyEffectiveUsd), 'curve')}</span></div>
        <div><span class="k">Quoted price</span><span class="v">${c.num(usdPrice(spot), 'price')}</span></div>
      </div>
      ${r.buyImpactPct >= CLIP_PCTS[CLIP_PCTS.length - 1] ? `<p class="get__tip">Keep the price move near ${CLIP_PCTS[0]}% with orders of ${c.num(N(cv['maxSafeClip' + CLIP_PCTS[0] + 'PctNam']), 'curve')} NAM or less, or near ${CLIP_PCTS[CLIP_PCTS.length - 1]}% with ${c.num(N(cv['maxSafeClip' + CLIP_PCTS[CLIP_PCTS.length - 1] + 'PctNam']), 'curve')} NAM or less.</p>` : ''}
    </div>`);
  }
  const fields = rows.map((r) => `<span class="field__v sz sz-${r.amountNam}">${N(r.amountNam)}</span>`).join('');
  const fieldSub = rows.map((r) => `<span class="field__s sz sz-${r.amountNam}">≈ ${usd(r.usdSize)}</span>`).join('');
  const presets = rows.map((r) => `<label for="sz-${r.amountNam}" class="pre pre-${r.amountNam}">${N(r.amountNam)}</label>`).join('');

  const chg = ov.price.change24h;
  const noQ = !q5.quote;
  const poolsSorted = [...snap.pools.pools].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const ref = snap.pools.pools.find((p) => p.id === '3005');
  const shown = poolsSorted.slice(0, 8), rest = poolsSorted.slice(8);
  const restSum = cv.totalLiquidityUsd - shown.reduce((s, p) => s + p.liquidityUsd, 0);
  const pairName = (p) => {
    let sym = p.counterSymbol;
    if (/^factory\//.test(sym)) sym = sym.split('/').pop();
    return `NAM / ${sym}`;
  };
  const poolRowsMobile = shown.map((p) => `<li class="prow"><span class="prow__n">${esc(pairName(p))}${p.id ? `<span class="id">#${p.id}</span>` : ''}</span>
    <span class="prow__l">${c.num(usd(p.liquidityUsd), 'pools', 'num--pad')}</span>
    <span class="prow__m"><span class="kind${p.id === ref.id ? ' kind--ref' : ''}">${p.id === ref.id ? 'Sets the quoted price' : esc(p.type[0].toUpperCase() + p.type.slice(1))}</span><span>${p.id === ref.id ? esc(p.type[0].toUpperCase() + p.type.slice(1)) + ' · ' : ''}fee ${pc(p.spreadFactor * 100, 2)}</span></span></li>`).join('');
  const poolTable = `<div class="tbl-wrap tbl-only"><table><thead><tr><th>Pool</th><th>Kind</th><th class="r">Fee</th><th class="r">NAM inside</th><th class="r">Liquidity</th></tr></thead><tbody>${shown.map((p) => `<tr${p.id === ref.id ? ' class="is-sel"' : ''}><td class="t-who"><b>${esc(pairName(p))}</b>${p.id ? `<span class="addr">#${p.id}</span>` : '<span class="addr">no number</span>'}</td><td>${esc(p.type[0].toUpperCase() + p.type.slice(1))}${p.id === ref.id ? ' · sets the quoted price' : ''}</td><td class="r">${pc(p.spreadFactor * 100, 2)}</td><td class="r">${c.num(N(p.namReserve), 'pools')}</td><td class="r">${c.num(usd(p.liquidityUsd), 'pools')}</td></tr>`).join('')}</tbody></table></div>`;

  const ladMobile = rows.map((r) => `<li><label class="lrow lad-${r.amountNam}" for="sz-${r.amountNam}">
      <span class="lrow__a">${N(r.amountNam)}<small>NAM</small></span>
      <span class="lrow__g">${c.num(N(r.sellOutUsdc, 2), 'curve', 'num--pad')}<small>USDC</small></span>
      <span class="lrow__m"><span>worth ${usd(r.usdSize)}</span>
        <span class="side-sell-v"><span class="sell-m">sell ${MINUS}${N(r.sellImpactPct, 2)}%</span> <span class="buy-m">buy +${N(r.buyImpactPct, 2)}%</span></span></span>
      <span class="lrow__bar only-sell" style="--w:${(r.sellImpactPct / maxImp) * 100}"></span><span class="lrow__bar only-buy" style="--w:${(r.buyImpactPct / maxImp) * 100}"></span></label></li>`).join('');
  const ladTable = `<div class="tbl-wrap tbl-only"><table><thead><tr><th>Order size</th><th class="r">Worth</th><th class="r">You get, selling</th><th class="r">Price move, selling</th><th class="r">Price move, buying</th></tr></thead><tbody>${rows.map((r) => `<tr class="lt lt-${r.amountNam}">
      <td class="m"><label for="sz-${r.amountNam}" style="cursor:pointer">${N(r.amountNam)} <small style="color:var(--ink-3)">NAM</small></label></td>
      <td class="r">${usd(r.usdSize)}</td><td class="r">${c.num(N(r.sellOutUsdc, 2) + ' <small>USDC</small>', 'curve')}</td>
      <td class="r"><span class="sell-m">${MINUS}${N(r.sellImpactPct, 2)}%</span><span class="stress only-sell"><i style="--w:${(r.sellImpactPct / maxImp) * 100}"></i></span></td>
      <td class="r"><span class="buy-m">+${N(r.buyImpactPct, 2)}%</span><span class="stress only-buy"><i style="--w:${(r.buyImpactPct / maxImp) * 100}"></i></span></td></tr>`).join('')}</tbody></table></div>`;

  const exec = snap.executedHistory30d, ex = exec.map((p) => p.value);
  const startQ = snap.priceHistory7d[0].ts;
  const chartTitle = `NAM has traded between ${usdPrice(Math.min(...ex))} and ${usdPrice(Math.max(...ex))} in the last ${LONG_D} days`;
  const sz = (cls) => cls;
  const dyn = SIZES.map((s) => `
main:has(#sz-${s}:checked) .sz:not(.sz-${s}) { display: none; }
main:has(#sz-${s}:checked) .pre-${s} { background: var(--ink); color: var(--bg); border-color: var(--ink); }
main:has(#sz-${s}:checked) .lad-${s} { background: var(--surface-2); }
main:has(#sz-${s}:checked) .lt-${s} { background: var(--surface-2); }
main:has(#side-sell:checked):has(#sz-${s}:checked) .get--sell.get--${s}, main:has(#side-buy:checked):has(#sz-${s}:checked) .get--buy.get--${s} { display: block; }`).join('') + `
main:has(#side-sell:checked) label[for=side-sell], main:has(#side-buy:checked) label[for=side-buy], main:has(#rng-${LONG_D}:checked) label[for=rng-${LONG_D}], main:has(#rng-${SHORT_D}:checked) label[for=rng-${SHORT_D}] { background: var(--ink); color: var(--bg); }
main:has(#side-sell:checked) .only-buy, main:has(#side-buy:checked) .only-sell { display: none; }
main:has(#side-sell:checked) .buy-m, main:has(#side-buy:checked) .sell-m { color: var(--ink-3); }
main:has(#side-sell:checked) .sell-m, main:has(#side-buy:checked) .buy-m { color: var(--ink); }
main:has(#rng-${LONG_D}:checked) .rng-${LONG_D}, main:has(#rng-${SHORT_D}:checked) .rng-${SHORT_D} { display: block; }
main:has(#rng-${SHORT_D}:checked) .keep-30 { display: none; }
main:has(#side-buy:checked) .h1-sell { display: none; } main:has(#side-sell:checked) .h1-buy { display: none; }
main:has(#side-buy:checked) .put-sell { display: none; } main:has(#side-sell:checked) .put-buy { display: none; }
main:has(input[type=radio]:focus-visible) label { --x: 0; }

.chart .rng-${LONG_D}, .chart .rng-${SHORT_D} { display: none; }
.chart .rng-${LONG_D} .ch-sm, .chart .rng-${SHORT_D} .ch-sm { display: block; } .chart .rng-${LONG_D} .ch-lg, .chart .rng-${SHORT_D} .ch-lg { display: none; }
@media (min-width: 640px) { .chart .rng-${LONG_D} .ch-sm, .chart .rng-${SHORT_D} .ch-sm { display: none; } .chart .rng-${LONG_D} .ch-lg, .chart .rng-${SHORT_D} .ch-lg { display: block; } }
.get--sell, .get--buy { display: none; }
`;
  const ids = ['side-sell', 'side-buy', `rng-${LONG_D}`, `rng-${SHORT_D}`, ...SIZES.map((s) => 'sz-' + s)];
  const extra = dyn + ids.map((id) => `main:has(#${id}:focus-visible) label[for=${id}] { outline: 2px solid var(--focus); outline-offset: 2px; }`).join('\n');

  const svgs = [LONG_D, SHORT_D].map((r) => `<div class="rng-${r}"><div class="ch-sm">${chartSvg({ w: 343, h: 210, range: +r })}</div><div class="ch-lg">${chartSvg({ w: 636, h: 300, range: +r })}</div></div>`).join('');
  const exMin = Math.min(...ex), exMax = Math.max(...ex);

  const body = `
<main id="main" class="trade">
${radios}
<div class="wrap">
  <header class="ph">
    <p class="ph__eyebrow mono">Price check · ${dUTC(CAP)}, ${tUTC(CAP)}</p>
    <h1><span class="h1-sell">What would I get if I sold NAM now?</span><span class="h1-buy">What would it cost to buy NAM now?</span></h1>
    <p class="ph__sub">An Osmosis quote, not an order. This site never trades for you.</p>
  </header>

  <div class="tk-grid">
      <section class="tk" aria-label="Your quote">
        <div class="tk__panel">
          <div class="seg" role="group" aria-label="Side"><label for="side-sell">Sell NAM</label><label for="side-buy">Buy NAM</label></div>
          <div>
            <div class="field-l"><span id="amt-l">Amount</span><span class="age">${noQ ? '<span class="st st--none" aria-hidden="true"></span>live quote not answering' : ''}</span></div>
            <div class="field" role="group" aria-labelledby="amt-l">${fields}<span class="field__u">NAM</span>${fieldSub}</div>
            <div class="presets" role="group" aria-label="Measured sizes">${presets}</div>
          </div>
          <div aria-live="polite">${gets.join('')}</div>
          ${noQ ? '<p class="ticket-note">The Osmosis quote service is not answering. These figures come from the size table, measured at the same moment, so you can pick one of six sizes.</p>' : ''}
          ${c.srcLine(['curve'])}
        </div>
      </section>
      <div class="alert thin" role="note"><svg class="ico" aria-hidden="true"><use href="#i-alert"/></svg>
        <div><p><b>This is a thin market.</b> The ${N(snap.pools.pools.length)} NAM pools on Osmosis hold ${c.num(usd(cv.totalLiquidityUsd), 'pools')} in all, and the biggest holds ${c.num(usd(cv.refPoolLiquidityUsd), 'pools')}.</p>
        <p>Selling ${N(BY(50000).amountNam)} NAM, worth ${usd(BY(50000).usdSize)}, would move the price ${c.num(N(BY(50000).sellImpactPct, 2) + '%', 'curve')}.</p></div></div>

    <section class="chart" aria-labelledby="h-chart">
      <div class="chart__h">
        <div><h2 id="h-chart" class="h3" style="font-size:var(--fs-22)">${chartTitle}</h2>
          <p class="chart__sub">Price of one NAM in USDC. Solid: what trades paid. Dashed: the quoted price.</p></div>
        <div class="seg" role="group" aria-label="Range"><label for="rng-${SHORT_D}">${SHORT_D} days</label><label for="rng-${LONG_D}">${LONG_D} days</label></div>
      </div>
      <div class="chart__svg chart-wrap">${svgs}</div>
      <div class="key"><span><svg viewBox="0 0 24 4"><line x1="0" x2="24" y1="2" y2="2" stroke="var(--ink)" stroke-width="2"/></svg>Executed trades, hourly median</span><span><svg viewBox="0 0 24 4"><line x1="0" x2="24" y1="2" y2="2" stroke="var(--ink-3)" stroke-width="2" stroke-dasharray="4 4"/></svg>Quoted price, recorded since ${dUTC(startQ)}</span><span class="keep-30"><svg viewBox="0 0 24 14" style="height:14px"><line x1="12" x2="12" y1="0" y2="14" stroke="var(--line-strong)" stroke-width="1.5" stroke-dasharray="2 3"/></svg>Biggest price moves</span></div>
      <p class="src"><span>Source</span> ${c.num('Executed trades, hourly median', 'swap')} <span>and</span> ${c.num('Osmosis quote', 'price')} · as of ${tUTC(ov.price.usd.prov.at)} · ${esc(ageStr(ov.price.usd.prov.at))}</p>
      <p class="note" style="margin-top:var(--s-2)">Hours with no trade have no point, so the solid line has gaps. The quote history is short; before ${dShort(startQ)} the chart shows executed trades only.</p>
      <div class="vh"><table><caption>Executed price, ${LONG_D} days</caption><tr><th>First</th><td>${usdPrice(exec[0].value)}</td><th>Lowest</th><td>${usdPrice(exMin)}</td><th>Highest</th><td>${usdPrice(exMax)}</td><th>Last</th><td>${usdPrice(exec[exec.length - 1].value)}</td></tr></table></div>
    </section>
  </div>

${sec('ladder', 'How size moves the price', 'The bigger the order, the worse the price', `
    <p class="lede">Selling ${N(BY(100000).amountNam)} NAM moves the price ${c.num(N(BY(100000).sellImpactPct, 2) + '%', 'curve')}. Selling ${N(BY(1000).amountNam)} NAM moves it ${c.num(N(BY(1000).sellImpactPct, 2) + '%', 'curve')}.</p>
    <ol class="lad__rows rows-only">${ladMobile}</ol>
    ${ladTable}
    <p class="note">Pick a size to put it in your quote.</p>
    ${c.srcLine(['curve'])}`, 'ladder')}

${sec('pools', 'Where NAM trades', `${N(snap.pools.pools.length)} pools, ${c.num(usd(cv.totalLiquidityUsd), 'pools')} in all`, `
    <p class="lede">A pool is a shared pot of NAM and another coin that anyone trades against. One pool sets the quoted price and it holds ${c.num(usd(ref.liquidityUsd), 'pools')}.</p>
    <ol class="pool__rows rows-only">${poolRowsMobile}</ol>
    ${poolTable}
    <p class="rest-note">${N(rest.length)} smaller pools hold ${c.num(usd(restSum), 'pools')} between them.</p>
    ${c.srcLine(['pools'])}`, 'pools')}
</div>
</main>`;
  return page({ title: 'What would I get if I sold NAM now? · Namada Trade', desc: 'An Osmosis quote for NAM at six order sizes, with the price move, the pools behind it and the price history. This site never trades for you.', current: 'trade', ctx: c, body, extraCss: extra });
}

/* ============================================================================= HOLDERS (Ledger) */
function holdersPage() {
  const c = makeCtx();
  const idx = srcAt('Namada indexer (indexer.namada.net)');
  const oh = srcAt('Keplr Osmosis REST (holders)');
  c.prov('price', { label: 'NAM price', source: ov.price.usd.prov.source, at: ov.price.usd.prov.at, status: ov.price.usd.prov.status, note: 'The change is measured against the price 24 hours earlier.' });
  c.prov('holders', { label: 'Holders on Namada', source: idx.name, at: idx.at, status: idx.ok ? 'live' : 'missing' });
  c.prov('conc', { label: 'Top ten share, Namada', source: 'Namada indexer', at: idx.at, status: 'live' });
  c.prov('concOsm', { label: 'Top ten share, Osmosis', source: oh.name, at: oh.at, status: 'live' });
  const hAt = Math.min(...holders.map((h) => Math.min(h.verifiedAt, h.bondedVerifiedAt)));
  c.prov('hold', { label: 'Holder balances', source: 'Namada indexer, stake check by Namada nodes', technical: 'Namada indexer (indexer.namada.net) + Namada RPC (stake verification)', at: hAt, status: undefined, note: 'Each row shows its own check time; this is the oldest.' });
  const maxPct = Math.max(...holders.map((h) => h.pctSupply));
  const cats = [['all', 'All', holders.length], ['foundation', 'Foundation', 0], ['genesis', 'Genesis', 0], ['backer', 'Backers', 0], ['none', 'Unlabelled', 0]];
  for (const h of holders) { const k = catOf(h); const e = cats.find((x) => x[0] === k); if (e) e[2]++; }
  const allStill = holders.every((h) => h.change7d === 0);
  const rowsM = holders.map((h) => holderRowRows(c, h, maxPct, 'hold')).join('');
  const tbl = holdersTable(c, holders, maxPct, 'hold');
  const radios = `
    <input class="vh f f-default" type="radio" name="chain" id="chain-namada" checked><input class="vh f" type="radio" name="chain" id="chain-osmosis">
    ${cats.map(([k]) => `<input class="vh f${k === 'all' ? ' f-default' : ''}" type="radio" name="who" id="who-${k}"${k === 'all' ? ' checked' : ''}>`).join('')}`;
  const ids = ['chain-namada', 'chain-osmosis', ...cats.map(([k]) => 'who-' + k)];
  const whoOpts = cats.map(([k, w, n]) => `<label for="who-${k}">${w}<small>${n}</small></label>`).join('');
  const dyn = cats.filter((x) => x[0] !== 'all').map(([k]) => `main:has(#who-${k}:checked) [data-cat]:not([data-cat="${k}"]) { display: none; }`).join('\n') + '\n' +
    ids.map((id) => `main:has(#${id}:checked) label[for=${id}] { background: var(--ink); color: var(--bg); border-color: var(--ink); } main:has(#${id}:checked) label[for=${id}] small { color: var(--bg); }`).join('\n') + `
main:has(#chain-osmosis:checked) .holders-wrap { display: none; }
main:has(#chain-osmosis:checked) .nodata { display: block; }
main:has(#chain-osmosis:checked) .tools__n { visibility: hidden; }
` + ids.map((id) => `main:has(#${id}:focus-visible) label[for=${id}] { outline: 2px solid var(--focus); outline-offset: 2px; }`).join('\n') + `
main { counter-reset: nf; }
input.f:not(.f-default):checked { counter-increment: nf; }
main:has(input.f:not(.f-default):checked) .fbtn .fbadge { display: inline-block; }
.fbadge::after { content: counter(nf); }
`;
  const filtersHtml = `
    <div id="filters" popover class="filters" aria-label="Filters">
      <div class="sheet__handle" aria-hidden="true"></div>
      <div class="sheet__h"><h3>Filter holders</h3><button type="button" class="icon-btn" popovertarget="filters" popovertargetaction="hide" aria-label="Close"><svg class="ico"><use href="#i-close"/></svg></button></div>
      <fieldset><legend>Chain</legend><div class="opt"><label for="chain-namada">Namada</label><label for="chain-osmosis">Osmosis</label></div></fieldset>
      <fieldset><legend>Who</legend><div class="opt">${whoOpts}</div></fieldset>
      <div class="filters__act"><span class="mono" style="font-size:var(--fs-12);color:var(--ink-3)">Showing ${N(holders.length)} of ${N(snap.holders.total)}</span><button type="button" class="btn btn--primary" popovertarget="filters" popovertargetaction="hide">Show holders</button></div>
    </div>`;
  const body = `
<main id="main" class="ledger">
${radios}
<div class="wrap">
  <header class="ph">
    <p class="ph__eyebrow mono">Ledger · ${dUTC(CAP)}, ${tUTC(CAP)}</p>
    <h1>Who holds NAM?</h1>
    <nav class="tabs" aria-label="Ledger"><a href="#" data-unbuilt>Moves</a><a href="holders.html" aria-current="page">Holders</a></nav>
  </header>
  <p class="ledger-sum">${c.num(N(snap.holders.total), 'holders')} holders on Namada. The ten biggest own ${c.num(pc(ov.concentration.namadaTop10Pct), 'conc')} of NAM.</p>
  ${holdersNote(c, holders, 'hold')}

  <div class="tools">
    <button type="button" class="fbtn" popovertarget="filters"><svg class="ico" aria-hidden="true"><use href="#i-filter"/></svg>Filters<span class="fbadge" aria-hidden="true"></span></button>
    <span class="tools__n">Showing ${N(holders.length)} of ${N(snap.holders.total)}</span>
  </div>
  ${filtersHtml}

  <div class="holders-wrap">
    <ol class="hlist rows-only">${rowsM}</ol>
    ${tbl}
    <div class="pager"><span class="mono">Rows ${N((snap.holders.page - 1) * snap.holders.limit + 1)} to ${N((snap.holders.page - 1) * snap.holders.limit + holders.length)} of ${N(snap.holders.total)}</span><a class="btn btn--outline" href="#" data-unbuilt>Load more</a></div>
    <p class="note">Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone, so it does not appear here.</p>
  </div>
  <div class="nodata" role="status"><h3><span class="st st--none" aria-hidden="true"></span>No Osmosis list in this snapshot</h3>
    <p>The Osmosis holder list was not captured, so there is nothing to show here. We do have one figure: the ten biggest holders on Osmosis own ${c.num(pc(ov.concentration.osmosisTop10Pct), 'concOsm')} of the NAM there.</p></div>
  ${c.srcLine(['hold'])}
</div>
</main>`;
  return page({ title: 'Who holds NAM? · Namada Trade', desc: 'The biggest NAM holders on Namada with balance, staked share, change and when each was last checked.', current: 'ledger', ctx: c, body, extraCss: dyn });
}

/* ----------------------------------------------------------------- write */
fs.writeFileSync(path.join(here, 'home.html'), home());
fs.writeFileSync(path.join(here, 'trade.html'), trade());
fs.writeFileSync(path.join(here, 'holders.html'), holdersPage());
console.log('wrote home.html, trade.html, holders.html');
