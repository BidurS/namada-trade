#!/usr/bin/env node
/* ============================================================================
   NamadaTrade FINAL, "The Reading": reference page builder.

   Reads ../data/snapshot.json (the live API at 2026-10-17 11:24 UTC) and, for
   the one block that is static and dated, ../../replay-report.md and
   ../../events.json. Writes home.html, trade.html and holders.html next to
   this file. Nothing numeric is typed by hand: every figure is a snapshot
   field, a field of those two documents, or a derive() of fields; every age is
   computed from the field's own timestamp relative to snapshot.capturedAt.
   The only literals that are not data are UI constants, named in CONFIG.

   This is the visual truth for system.md. The React app re-implements it with
   the same markup contract (docs/design/build-plan.md).

   usage: node build.mjs                      (writes next to this file)
          OUT_DIR=/some/dir THEME=light node build.mjs
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const S = JSON.parse(fs.readFileSync(path.resolve(HERE, '../data/snapshot.json'), 'utf8'));
const REPLAY_MD = fs.readFileSync(path.resolve(HERE, '../../replay-report.md'), 'utf8');
const EVENTS = JSON.parse(fs.readFileSync(path.resolve(HERE, '../../events.json'), 'utf8'));
const OUT = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : HERE;
const THEME = process.env.THEME === 'light' ? 'light' : 'dark';
const NOW = S.capturedAt;
const SITE_CSS = fs.readFileSync(path.join(HERE, 'site.css'), 'utf8');

/* ---------- CONFIG: UI constants (not data) ---------- */
const CONFIG = {
  tagline: 'What moved, who moved it, and what it costs to trade NAM.',   // SITE.tagline
  defaultSize: 5000,                // the brief's default mini-ticket size
  curveSize: 10000,                 // the size named in step 4 ("An order of 10,000 NAM ...")
  defaultRange: '30d',
  ranges: { '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3, '30d': 30 * 24 * 3600e3 },
  holderRowsOnHome: 10,
  tapeMinNam: 1000,                 // the latest-moves list shows moves of at least this many NAM
  tapeRows: 6,
  poolsShown: 9,
  eventLabelMax: 12,                // chart event labels: 12 characters or fewer
  eventsOnChart: 3,                 // the three biggest recorded price moves inside the window
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
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n) => String(n).padStart(2, '0');
const fDate = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };
const fTime = (t) => { const d = new Date(t); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; };
const fUTC = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${fTime(t)} UTC`; };
const fDateline = (t) => { const d = new Date(t); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${fTime(t)} UTC`; };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fShortSize = (n) => (n >= 1000 ? `${trimZ((n / 1000).toFixed(1))}k` : String(n));

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
const ageLong = (at) => { // "16 days" for the last-event line
  const d = (NOW - at) / 86400e3;
  return d >= 2 ? `${Math.round(d)} days` : fAge(at);
};

/* ---------- provenance: ProvChip, ProvDot, SourceLine, all opening one sheet ---------- */
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
const worst = (a, b) => ({ fresh: 0, age: 0, old: 1, none: 2, disagree: 3 }[b] > { fresh: 0, age: 0, old: 1, none: 2, disagree: 3 }[a] ? b : a);

/** p: {source, at, status, note?, derivedFrom?, extra?:[[k,v]], plain?} */
function pstate(p) { return p.status ? (STATUS[p.status] || p.status) : 'age'; }
function sheetFor(p, label) {
  const status = pstate(p);
  const name = p.plain || plain(p.source);
  const key = JSON.stringify([name, p.at, status, p.note || '', p.derivedFrom || '', label || '', p.extra || '']);
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
  return rec;
}
function ptext(p, src = true) {
  const status = pstate(p);
  const name = p.plain || plain(p.source);
  const age = fAge(p.at);
  if (status === 'none') return `${name} · no data`;
  if (status === 'disagree') return `${name} · disagree ${age}`;
  if (status === 'old') return `${name} · old ${age}`;
  return src ? `${name} · ${age}` : age;
}
const paria = (p, label) => `${label || p.plain || plain(p.source)}: ${STATUS_WORD[pstate(p)]}, ${fAge(p.at) === 'now' ? 'just now' : fAge(p.at)}. Show source.`;
/** ProvChip: a pill, for hero figures only */
function chip(p, { label = '', cls = '', text } = {}) {
  const rec = sheetFor(p, label);
  const status = pstate(p);
  return `<button type="button" class="chip ${cls}" data-status="${status}" popovertarget="${rec.id}" aria-label="${esc(paria(p, label))}"><i class="dot" data-status="${status}"></i><span>${esc(text || ptext(p))}</span></button>`;
}
/** ProvDot: dot, source word and age, no pill: for secondary figures */
function pdot(p, { label = '', text } = {}) {
  const rec = sheetFor(p, label);
  const status = pstate(p);
  return `<button type="button" class="pdot" data-status="${status}" popovertarget="${rec.id}" aria-label="${esc(paria(p, label))}"><i class="dot" data-status="${status}"></i><span>${esc(text || ptext(p))}</span></button>`;
}
/** SourceLine: the panel's footer. One button for every figure in the panel (its scope). items: [{label, p}] */
function scopeSheet(items, label) {
  const key = 'scope:' + JSON.stringify([label, items.map((i) => [i.label, i.p.at, i.p.status, i.p.source])]);
  let rec = popovers.get(key);
  if (!rec) {
    const id = `pv${++pvCount}`;
    const rows = items.map((i) => {
      const st = pstate(i.p);
      return `<dt>${esc(i.label)}</dt><dd><span class="dot" data-status="${st}"></span>${esc(i.p.plain || plain(i.p.source))} · ${esc(fTime(i.p.at))} UTC · ${esc(fAge(i.p.at) === 'now' ? 'just now' : fAge(i.p.at))} · ${esc(STATUS_WORD[st])}</dd>`;
    }).join('');
    rec = {
      id,
      html: `<div id="${id}" popover class="sheet ground-ink" aria-label="${esc(label)}">
  <div class="sheet__head"><h2 class="sheet__t">${esc(label)}</h2>
    <button class="icon-btn" popovertarget="${id}" popovertargetaction="hide" aria-label="Close"><svg class="ico"><use href="#i-close"/></svg></button></div>
  <p class="sheet__lead">As of ${esc(fUTC(Math.max(...items.map((i) => i.p.at))))}. Each figure on this panel, with its own source and age.</p>
  <dl class="kv">${rows}</dl>
  <div class="sheet__foot"><a class="btn btn--secondary" href="#">Rewind to this time</a></div>
</div>`,
    };
    popovers.set(key, rec);
  }
  return rec;
}
function srcLine(items, { label = 'Where these numbers come from', lead = 'Source', text } = {}) {
  const rec = scopeSheet(items, label);
  let status = 'fresh';
  for (const i of items) status = worst(status, pstate(i.p));
  const uniq = [...new Set(items.map((i) => i.p.plain || plain(i.p.source)))];
  const names = uniq.length > 2 ? `${uniq.length} sources` : uniq.join(', ');
  const at = items.map((i) => i.p.at);
  const oldest = Math.min(...at), newest = Math.max(...at);
  const age = fAge(oldest) === fAge(newest) ? fAge(newest) : `${fAge(newest)} to ${fAge(oldest)}`;
  const word = status === 'fresh' ? 'fresh' : status === 'old' ? 'old' : STATUS_WORD[status];
  const rest = text || ` \u00b7 ${names} \u00b7 ${age === 'now' ? 'just now' : age} \u00b7 ${word}`;
  return `<p class="src"><button type="button" class="srcb" data-status="${status}" popovertarget="${rec.id}" aria-label="${esc(`${lead}: ${names}, ${word}. Show every source on this panel.`)}"><i class="dot" data-status="${status}"></i><span><u class="srcb__l">${esc(lead)}</u>${esc(rest)}</span></button></p>`;
}
const popoverHtml = () => [...popovers.values()].map((r) => r.html).join('\n');

/** derive(): a derived value takes the oldest `at` and the worst status of its inputs. */
const RANK = { live: 0, stale: 1, missing: 2, conflict: 3 };
function derive(inputs, derivedFrom) {
  const at = Math.min(...inputs.map((i) => i.at));
  const status = inputs.map((i) => i.status).sort((a, b) => RANK[b] - RANK[a])[0];
  return { source: derivedFrom, plain: 'Derived', at, status, derivedFrom };
}

/* ---------- snapshot bindings ---------- */
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
const WINDOW_H = Math.round((S.alerts.until - S.alerts.since) / 3600e3);
const CHANGE_DAYS = 7;   // the holders field is named change7d
const pct = (v) => (v / TOTAL) * 100;
const ladder = (n) => CURVE.curve.find((r) => r.amountNam === n);
const idxAt = O.sources.find((s) => s.name.startsWith('Namada indexer')).at;
const SIZE_TABLE = { source: 'Osmosis SQS', plain: 'Size table', at: CURVE.prov.at, status: CURVE.prov.status, note: 'Six order sizes quoted by the Osmosis router at the same moment. A quote for any other size is not available while the quote service is not answering.' };
const QUOTE_DOWN = !S.quote5000.quote;   // the live quote failed: the ticket says so next to the number
const EXEC_PROV = { source: 'executed NAM/USDC swaps (hourly median)', at: O.price.swap1h.prov.at, status: O.price.swap1h.prov.status };

/* ---------- replay report: the one static, dated block (parsed, never typed) ---------- */
function replayFacts() {
  const md = REPLAY_MD;
  const gen = md.match(/Generated (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) UTC/);
  const events = md.match(/\((\d+) events/);
  const flag = md.match(/flagged ahead of time: (\d+) \/ (\d+)/);
  const lead = md.match(/Median lead ([\d.]+) h/);
  const base = md.match(/Base rate:\*\* (\d+)%/);
  const win = md.match(/in the (\d+)h before/);
  const whale = md.match(/whale_namada:6C19[^|]*\| withdraw ([\d,]+)[^|]*\|[^|]*\| (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (!gen || !events || !flag || !lead || !base || !win || !whale) return null;
  const gts = Date.UTC(+gen[1], +gen[2] - 1, +gen[3], +gen[4], +gen[5]);
  const wts = Date.UTC(+whale[2], +whale[3] - 1, +whale[4], +whale[5], +whale[6]);
  const million = Math.round(Number(whale[1].replace(/,/g, '')) / 1e6);
  return { generated: `${new Date(gts).getUTCDate()} ${MONTHS[new Date(gts).getUTCMonth()]} ${new Date(gts).getUTCFullYear()}`, events: events[1], flagged: flag[1], of: flag[2], lead: lead[1], base: base[1], window: win[1], million, wts, wlabel: fUTC(wts) };
}

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
<symbol id="i-chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
<symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></symbol>
<symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.4"/></symbol>
<symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 4 2.8 19.5h18.4zM12 10v4.5M12 16.8v.4"/></symbol>
<symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></symbol>
<symbol id="g-buy" viewBox="0 0 12 12"><path d="M3 9l6-6M4 3h5v5"/></symbol>
<symbol id="g-sell" viewBox="0 0 12 12"><path d="M3 3l6 6M9 4v5H4"/></symbol>
<symbol id="g-shield" viewBox="0 0 12 12"><path d="M6 1.2 2.2 2.7v3c0 2.4 1.6 4 3.8 4.9 2.2-.9 3.8-2.5 3.8-4.9v-3z"/></symbol>
<symbol id="g-lock" viewBox="0 0 12 12"><rect x="2.5" y="5.5" width="7" height="5" rx=".5"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/></symbol>
<symbol id="g-bridge" viewBox="0 0 12 12"><path d="M1.5 8.5a4.5 4.5 0 0 1 9 0M3 8.5v2M9 8.5v2M1 10.5h10"/></symbol>
<symbol id="g-ring" viewBox="0 0 12 12"><circle cx="6" cy="6" r="3.6"/></symbol>
<symbol id="mark" viewBox="0 0 32 32"><path d="M16 3.5a12.5 12.5 0 1 0 12.5 12.5" fill="none" stroke="currentColor" stroke-width="4.5"/><path d="M16 16 25 7" stroke="currentColor" stroke-width="3.2" fill="none"/><circle cx="16" cy="16" r="2.6" fill="currentColor"/></symbol>
</defs></svg>`;
const ico = (id, cls = 'ico') => `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
const gly = (id) => `<svg class="gly" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><use href="#${id}"/></svg>`;
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#000"/><path d="M16 3.5a12.5 12.5 0 1 0 12.5 12.5" fill="none" stroke="#ff0" stroke-width="4.5"/><path d="M16 16 25 7" stroke="#ff0" stroke-width="3.2" fill="none"/><circle cx="16" cy="16" r="2.6" fill="#ff0"/></svg>');

/* ---------- tags ---------- */
const FLOW = {
  buy:       { word: 'Buy',          glyph: 'g-buy',    hue: 'buy',    tip: 'buy' },
  sell:      { word: 'Sell',         glyph: 'g-sell',   hue: 'sell',   tip: 'sell' },
  shieldIn:  { word: 'Shielded in',  glyph: 'g-shield', hue: 'shield', tip: 'shield' },
  shieldOut: { word: 'Shielded out', glyph: 'g-shield', hue: 'shield', tip: 'unshield' },
  staked:    { word: 'Staked',       glyph: 'g-lock',   hue: 'pos',    tip: 'bond' },
  unstaking: { word: 'Unstaking',    glyph: 'g-lock',   hue: 'pos',    tip: 'unbond' },
  unlocked:  { word: 'Unlocked',     glyph: 'g-lock',   hue: 'pos',    tip: 'withdraw' },
  bridged:   { word: 'Bridged in',   glyph: 'g-bridge', hue: 'ibc',    tip: 'ibc in' },
};
const tag = (k) => `<span class="tag tag--flow" style="--hue:var(--${FLOW[k].hue})" title="Expert term: ${FLOW[k].tip}">${gly(FLOW[k].glyph)}${FLOW[k].word}</span>`;
const CATS = { foundation: 'Foundation', genesis: 'Genesis', backer: 'Backer' };
/** A category tag only when it adds information: not when the name already says it. */
const catTag = (c, name) => (c && CATS[c] && !(name || '').toLowerCase().includes(c.toLowerCase()) && !(c === 'foundation' && /foundation/i.test(name || '')) && !(c === 'backer' && /backer/i.test(name || '')) ? `<span class="tag tag--cat">${gly('g-ring')}${CATS[c]}</span>` : '');

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
const CHECKS_AT = Math.max(...CHECKS.map((c) => c.checkedAt));

function header(active) {
  const priceChip = chip(PRICE_PROV, { label: 'NAM price' });
  const pvId = /popovertarget="(pv\d+)"/.exec(priceChip)[1];
  const dotStatus = STATUS[PRICE_PROV.status];
  return `<header class="hdr ground-chrome"><div class="hdr__in">
  <a class="brand" href="home.html" aria-label="Namada Trade, home"><svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true"><use href="#mark"/></svg><span class="brand__word">Namada <b>Trade</b></span></a>
  <nav class="tabs" aria-label="Primary"><ul>${NAV.map(([k, label, href]) => `<li><a href="${href}"${k === active ? ' aria-current="page"' : ''}>${label}</a></li>`).join('')}</ul></nav>
  <span class="hdr__sp"></span>
  <button type="button" class="hprice" popovertarget="${pvId}" aria-label="NAM price ${fPrice(PRICE)}, ${fSigned(CHG24)} since this time yesterday. Show source.">
    <i class="dot" data-status="${dotStatus}"></i><span class="hprice__v" data-num>${fPrice(PRICE)}</span><span class="hprice__d">${fSigned(CHG24, 1)}</span></button>
  <button type="button" class="hbtn hbtn--rewind" aria-label="Rewind to a date">${ico('i-rewind')}<span>Rewind</span></button>
  <button type="button" class="hbtn hbtn--status" data-status="${warnCount ? 'old' : 'fresh'}" popovertarget="sources" aria-label="${okCount} of ${CHECKS.length} cross-checks pass. Where every number comes from.">${ico('i-check')}<span><span class="hbtn__s">${okCount}/${CHECKS.length}</span><span class="hbtn__l">${okCount} of ${CHECKS.length}</span><span class="hbtn__more"> checks</span></span></button>
  <button type="button" class="ibtn" aria-label="Search">${ico('i-search')}</button>
  <button type="button" class="ibtn" aria-label="Account">${ico('i-account')}</button>
</div></header>`;
}

function tabbar(active) {
  return `<nav class="tabbar ground-chrome" aria-label="Primary"><ul>${NAV.map(([k, label, href, icon]) => `<li><a href="${href}"${k === active ? ' aria-current="page"' : ''}>${ico(icon)}<span>${label}</span></a></li>`).join('')}</ul></nav>`;
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
const checkRow = (c) => {
  const [title, fmt] = CHECK_PLAIN[c.key] || [c.title, () => ''];
  const st = c.status === 'ok' ? 'fresh' : 'old';
  const word = c.status === 'ok' ? 'Passes' : 'Needs a look';
  return `<li class="chk" data-key="${esc(c.key)}" data-status="${st}"><span class="chk__t"><i class="dot" data-status="${st}"></i>${esc(title)}</span>
    <span class="chk__w">${word}</span><span class="chk__d">${esc(fmt(c.detail))}</span></li>`;
};
const checksProv = { source: 'cross-check', plain: 'Cross-checks', at: CHECKS_AT, status: 'live' };

function sourcesSheet() {
  const ok = O.sources.filter((s) => s.ok).length;
  const needs = CHECKS.filter((c) => c.status !== 'ok');
  const passes = CHECKS.filter((c) => c.status === 'ok');
  return `<div id="sources" popover class="sheet sheet--lg ground-ink" aria-label="Where every number comes from">
  <div class="sheet__head"><h2 class="sheet__t">Where every number comes from</h2>
    <button class="icon-btn" popovertarget="sources" popovertargetaction="hide" aria-label="Close">${ico('i-close')}</button></div>
  <p class="sheet__lead"><b>${okCount} of ${CHECKS.length}</b> cross-checks pass${warnCount ? `, ${warnCount} need a look` : ''}. This page is a snapshot taken ${esc(fUTC(NOW))}; every age is measured from that moment.</p>
  <ul class="chks">${needs.map(checkRow).join('')}${passes.map(checkRow).join('')}</ul>
  <details class="how"><summary>How it is computed</summary>
    <p class="cap">${ok} of ${O.sources.length} data sources answered at the snapshot. Last answer, oldest first:</p>
    <ul class="srcs">${[...O.sources].sort((a, b) => a.at - b.at).map((s) => `<li><span class="mono">${esc(s.name)}</span><span class="mono">${s.ok ? 'ok' : 'down'} · ${esc(fAge(s.at))}</span></li>`).join('')}</ul>
  </details>
</div>`;
}

const FOOTER_LINKS = ['How we know', 'Settings', 'API', 'Source code'];
function footer() {
  return `<footer class="band ground-ink foot">
  <div class="wrap foot__grid">
    <div class="foot__id">
      <a class="foot__brand" href="home.html"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#mark"/></svg><span>Namada <b>Trade</b></span></a>
      <p class="foot__snap">Snapshot of ${esc(fUTC(NOW))}. Ages are measured from that moment.</p>
    </div>
    <div class="foot__legal"><p>Every number shows its source and age. Data: Osmosis router, Namada nodes, indexer.namada.net; flow records current as of ${esc(fAge(DEX.coverage.at))}.</p>
      <p>NamadaTrade reports public on-chain and exchange data. It is not investment advice and is not affiliated with Namada or the Anoma Foundation.</p></div>
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
<!-- Mockup only: production self-hosts Space Grotesk (variable 400-700) and JetBrains Mono (400, 500) from fontsource. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${CONFIG.fonts}">
<link rel="stylesheet" href="../tokens.css">
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
const niceLabel = (l) => l.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const L5 = ladder(CONFIG.defaultSize);
const L10 = ladder(CONFIG.curveSize);
const curveProv = SIZE_TABLE;

/* ---------- OrderSizeCurve: log scale, the six real quotes as dots, a snapping slider ---------- */
const POINTS = CURVE.curve.map((r) => ({ n: r.amountNam, worth: r.usdSize, so: r.sellOutUsdc, si: r.sellImpactPct, bi: r.buyImpactPct, bo: r.buyInUsdc }));
function niceStep(range, target) {
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}
function curveSvg(kind) {
  const phone = kind === 'p';
  const W = phone ? 328 : 520, H = phone ? 188 : 248, fs = phone ? 11 : 12;
  const m = { l: 34, r: 12, t: 12, b: 26 };
  const maxV = Math.max(...POINTS.map((p) => Math.max(p.si, p.bi)));
  const step = niceStep(maxV * 1.1, 4);
  const yMax = Math.ceil((maxV * 1.04) / step) * step;
  const lo = POINTS[0].n, hi = POINTS[POINTS.length - 1].n;
  const X = (n) => m.l + ((Math.log(n) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - v / yMax) * (H - m.t - m.b);
  let grid = '';
  for (let v = 0; v <= yMax + 1e-9; v += step) grid += `<line class="cv-grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="cv-tick" x="${m.l - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" style="font-size:${fs}px">${fInt(v)}%</text>`;
  const xt = POINTS.map((p, i) => `<text class="cv-tick" x="${X(p.n).toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === POINTS.length - 1 ? 'end' : 'middle'}" style="font-size:${fs}px">${fShortSize(p.n)}</text>`).join('');
  const line = (k) => POINTS.map((p, i) => `${i ? 'L' : 'M'}${X(p.n).toFixed(1)} ${Y(p[k]).toFixed(1)}`).join('');
  const dots = (k, cls) => POINTS.map((p) => `<circle class="${cls}" cx="${X(p.n).toFixed(1)}" cy="${Y(p[k]).toFixed(1)}" r="${phone ? 3.5 : 4}"/>`).join('');
  const cur = POINTS.find((p) => p.n === CONFIG.curveSize);
  return `<svg class="cv cv--${kind}" viewBox="0 0 ${W} ${H}" role="img" data-w="${W}" data-h="${H}" data-l="${m.l}" data-r="${m.r}" data-t="${m.t}" data-b="${m.b}" data-ymax="${yMax}" aria-label="Price move by order size, log scale from ${fInt(lo)} to ${fInt(hi)} NAM. Selling solid, buying dashed. ${POINTS.length} real quotes.">
    ${grid}<line class="cv-axis" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>${xt}
    <path class="cv-buy" d="${line('bi')}"/>${dots('bi', 'cv-db')}
    <g class="cv-wipe"><path class="cv-sell" d="${line('si')}"/></g>${dots('si', 'cv-ds')}
    <line class="cv-cur" x1="${X(cur.n).toFixed(1)}" x2="${X(cur.n).toFixed(1)}" y1="${m.t}" y2="${H - m.b}"/>
    <circle class="cv-curd" cx="${X(cur.n).toFixed(1)}" cy="${Y(cur.si).toFixed(1)}" r="6"/>
  </svg>`;
}
function curveBlock(id, { lead }) {
  const lo = POINTS[0].n, hi = POINTS[POINTS.length - 1].n;
  const pos = Math.round(((Math.log(CONFIG.curveSize) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 1000);
  const c = L10;
  return `<div class="curve-box"><figure class="curve" data-curve aria-labelledby="${id}-t">
    <figcaption id="${id}-t" class="sr-only">Drag an order size</figcaption>
    <div class="curve__plot">${curveSvg('p').replace('class="cv cv--p"', 'class="cv cv--p curve--phone"')}${curveSvg('d').replace('class="cv cv--d"', 'class="cv cv--d curve--wide"')}</div>
    <p class="curve__key"><span><i class="key__ln"></i>selling</span><span><i class="key__ln key__ln--dash"></i>buying</span><span>Price move by order size</span></p>
    <div class="curve__ctl"><label class="curve__lbl" for="${id}-r">Order size</label><output class="curve__size" for="${id}-r" data-o="size">${fInt(c.amountNam)} NAM</output>
      <input id="${id}-r" class="curve__rng" type="range" min="0" max="1000" step="1" value="${pos}" aria-label="Order size in NAM, log scale" data-range></div>
    <dl class="curve__read">
      <div><dt>Worth</dt><dd data-num data-o="worth">${fUsd(c.usdSize)}</dd></div>
      <div><dt>You get</dt><dd data-num data-o="get">${fUsdc(c.sellOutUsdc)}<span class="u"> USDC</span></dd></div>
      <div><dt>Price moves</dt><dd data-num data-o="move">${fSigned(-c.sellImpactPct)}</dd></div>
    </dl>
    <p class="curve__how"><span class="curve__est tag tag--cat" data-est hidden>Estimate</span><span data-o="how">A real quote: the pools were asked about ${fInt(c.amountNam)} NAM.</span></p>
    <p class="curve__note">The dots are the ${POINTS.length} sizes the pools were asked about (${fInt(lo)} to ${fInt(hi)} NAM). Between two dots the page draws a straight line between the two real quotes, so treat it as an estimate. The scale is logarithmic: equal steps are equal multiples.</p>
    <script type="application/json" data-pts>${JSON.stringify(POINTS)}</script>
  </figure></div>`;
}
const CURVE_JS = `(function(){
var NF=function(n,d){return n.toLocaleString('en-US',{minimumFractionDigits:d||0,maximumFractionDigits:d||0})};
function usd(v){var a=Math.abs(v);if(a>=1000)return '$'+NF(v,0);if(a>=1)return '$'+NF(v,2);return '$'+v.toFixed(6)}
function sg(v){return (v>0?'+':v<0?'\\u2212':'')+NF(Math.abs(v),2)+'%'}
document.querySelectorAll('[data-curve]').forEach(function(fig){
  var P=JSON.parse(fig.querySelector('[data-pts]').textContent),lo=P[0].n,hi=P[P.length-1].n,rng=fig.querySelector('[data-range]');
  var lg=function(n){return (Math.log(n)-Math.log(lo))/(Math.log(hi)-Math.log(lo))};
  function from(s){var a=Math.exp(Math.log(lo)+(s/1000)*(Math.log(hi)-Math.log(lo)));for(var i=0;i<P.length;i++){if(Math.abs(s-lg(P[i].n)*1000)<12)return P[i].n}return Math.round(a/10)*10}
  function q(n){for(var i=0;i<P.length;i++){if(P[i].n===n)return{exact:true,a:P[i],b:P[i],v:P[i]};if(i<P.length-1&&n>P[i].n&&n<P[i+1].n){var t=(n-P[i].n)/(P[i+1].n-P[i].n),a=P[i],b=P[i+1],v={n:n};['worth','so','si','bi','bo'].forEach(function(k){v[k]=a[k]+(b[k]-a[k])*t});return{exact:false,a:a,b:b,v:v}}}return null}
  function paint(n){var r=q(n);if(!r)return;var v=r.v;
    fig.querySelector('[data-o=size]').textContent=NF(n)+' NAM';
    fig.querySelector('[data-o=worth]').textContent=usd(v.worth);
    fig.querySelector('[data-o=get]').innerHTML=NF(v.so,2)+'<span class="u"> USDC</span>';
    fig.querySelector('[data-o=move]').textContent=sg(-v.si);
    fig.querySelector('[data-o=how]').textContent=r.exact?'A real quote: the pools were asked about '+NF(n)+' NAM.':'A straight line between the real '+NF(r.a.n)+' and '+NF(r.b.n)+' NAM quotes. The pools were not asked about '+NF(n)+' NAM.';
    fig.querySelector('[data-est]').hidden=r.exact;
    fig.querySelectorAll('svg.cv').forEach(function(s){var W=+s.dataset.w,H=+s.dataset.h,l=+s.dataset.l,rr=+s.dataset.r,t=+s.dataset.t,b=+s.dataset.b,ym=+s.dataset.ymax;
      var x=l+lg(n)*(W-l-rr),y=t+(1-v.si/ym)*(H-t-b);var c=s.querySelector('.cv-cur'),d=s.querySelector('.cv-curd');c.setAttribute('x1',x);c.setAttribute('x2',x);d.setAttribute('cx',x);d.setAttribute('cy',y)})}
  rng.addEventListener('input',function(){paint(from(+rng.value))});
  fig.curvePaint=paint;
});})();`;

/* ============================================================================
   HOME
   ============================================================================ */
function home() {
  popovers.clear(); pvCount = 0;
  const idxProv = { source: 'Namada indexer (indexer.namada.net)', at: idxAt, status: 'live' };
  const facts = [
    { n: fInt(NAMADA.holders), l: 'holders on Namada', p: idxProv, name: 'Holders on Namada' },
    { n: fPct(BLIND.sharePct), l: 'shielded', p: BLIND.shielded.prov, name: 'Share of NAM that is shielded' },
    { n: fPct(pct(SUP.osmosis)), l: 'on Osmosis', p: SUP.osmosisProv, name: 'Share of NAM on Osmosis' },
  ];
  const hero = `<section class="band ground-accent hero" aria-labelledby="h1">
  <div class="wrap">
    <div class="hero__grid">
      <div class="hero__lead">
        <p class="eyebrow">NAM on Osmosis · ${esc(fDateline(NOW))}</p>
        <h1 id="h1" class="h1">${esc(CONFIG.tagline)}</h1>
        <p class="sub">NAM is the coin of the Namada network. Price, holders, who might sell, how much is shielded. Every number shows its source and age.</p>
      </div>
      <div class="hero__price price">
        <div class="price__top"><p class="price__label">One NAM costs</p>${chip(PRICE_PROV, { label: 'NAM price' })}</div>
        <p class="price__val" data-num>${priceBig(PRICE)}</p>
        <p class="price__meta"><span class="delta" data-num><svg class="gly" viewBox="0 0 12 12" aria-hidden="true"><path d="${CHG24 >= 0 ? 'M6 2.5 10 9H2z' : 'M6 9.5 10 3H2z'}" fill="currentColor"/></svg>${fSigned(CHG24)}</span><span class="price__since">since this time yesterday</span></p>
        ${sparkline()}
      </div>
      <div class="actions">
        <a class="btn btn--primary" href="trade.html">See what a trade costs ${ico('i-arrow', 'ico ico--btn')}</a>
        <button class="btn btn--secondary" type="button" popovertarget="sources">How we know</button>
      </div>
    </div>
    <ul class="facts">${facts.map((f) => `<li class="fact"><span class="fact__n" data-num>${f.n}</span><span class="fact__l">${f.l}</span></li>`).join('')}</ul>
    ${srcLine(facts.map((f) => ({ label: f.name, p: f.p })), { label: 'Where the three figures come from' })}
  </div>
  ${ruler('ruler--bottom')}
</section>`;

  /* what changed: alert hits, else the honest empty state with the last one; then the latest real moves */
  const alertsEmpty = S.alerts.hits.length === 0;
  const bigSwap = RULES.big_swap.thresholdNam;
  const bigSwapUsd = derive([{ at: PRICE_PROV.at, status: PRICE_PROV.status }], 'price x alert size');
  const last = lastAlertEvent();
  const flowProv = { source: 'D1 flow index', at: DEX.coverage.at, status: DEX.coverage.status, note: `${DEX.coverage.note}. Namada flows lag the chain by a few hours; Osmosis flows by minutes.` };
  const nmProv = { source: 'D1 flow index', at: NAMADA.coverage.at, status: NAMADA.coverage.status, note: NAMADA.coverage.note };
  const moves = latestMoves();
  const tp = (r, i) => `<li class="tp"><span class="tp__no">${p2(i + 1)}</span>${tag(r.k)}<span class="tp__n" data-num>${r.signed ? fSigned(r.amt, 0, '') : fInt(r.amt)}<span class="u"> NAM</span></span><span class="tp__c">${esc(fAge(r.ts))} ago · ${esc(r.who)}${r.detail ? ` · ${esc(r.detail)}` : ''}</span></li>`;
  const changed = `<section class="sec" aria-labelledby="h-changed">
    <h2 id="h-changed" class="h2">What changed in the last ${WINDOW_H} hours</h2>
    ${alertsEmpty ? `<div class="empty">
      <svg class="empty__ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 5"/></svg>
      <div><p class="empty__t">Nothing crossed an alert size in ${WINDOW_H} hours.</p>
      <p class="empty__s">Alert sizes are small on purpose: at today’s price ${fInt(bigSwap)} NAM is <span data-num>${fUsd(bigSwap * PRICE)}</span> ${pdot(bigSwapUsd, { label: 'Alert size in dollars', text: 'derived · now' })}</p>
      ${last ? `<p class="empty__last">The last one: ${tag(last.k)} <span><span data-num>${fInt(last.amt)}</span> NAM, ${esc(ageLong(last.ts))} ago.</span></p>
      ${last ? `<p class="more"><a class="link" href="supply.html?at=${last.ts}"><span>Rewind to it</span>${ico('i-rewind', 'ico ico--inline')}</a></p>` : ''}` : ''}</div>
    </div>` : ''}
    <div class="tape${/old|stale/.test(flowProv.status) ? ' is-old' : ''}">
      <div class="tape__h"><h3 class="h3">Latest moves <span class="h3__s">${fInt(CONFIG.tapeMinNam)} NAM or more, newest first</span></h3></div>
      <ol>${moves.map(tp).join('')}</ol>
    </div>
    ${srcLine([{ label: 'Moves on Osmosis (bot trades removed)', p: flowProv }, { label: 'Moves on Namada', p: nmProv }], { label: 'Where the moves come from' })}
    <p class="more"><a class="link" href="holders.html"><span>All activity</span>${ico('i-arrow', 'ico ico--inline')}</a></p>
  </section>`;

  /* where is all the NAM */
  const segs = [
    { k: 'bonded', label: 'Staked', v: SUP.bonded, note: 'locked with validators, cannot be sold', inbar: true },
    { k: 'pgf', label: 'Public funding', v: SUP.pgf, note: 'held for public goods' },
    { k: 'shielded', label: 'Shielded', v: SUP.shielded, note: 'total public, owners not' },
    { k: 'rest', label: 'Everything else spendable', v: SUP.transparentLiquid, note: 'could be bridged and sold', inbar: true },
    { k: 'osmosis', label: 'On Osmosis', v: SUP.osmosis, note: 'the one place it can be sold' },
  ];
  const osmoPct = pct(SUP.osmosis);
  const escrow = SUP.ibcEscrow, osmoSup = SUP.osmosis;
  const drift = Math.abs(escrow - osmoSup);
  const ibcCheck = CHECKS.find((c) => c.key === 'ibc_conservation');
  const osmoDisagree = ibcCheck && ibcCheck.status !== 'ok';
  const osmoProvFig = osmoDisagree ? { ...SUP.osmosisProv, status: 'conflict', note: `Namada holds ${fInt(escrow)} NAM in escrow for Osmosis while Osmosis counts ${fInt(osmoSup)}: ${fInt(drift)} NAM apart.` } : SUP.osmosisProv;
  const where = `<section class="sec" aria-labelledby="h-where">
    <h2 id="h-where" class="h2">Where is all the NAM?</h2>
    <p class="lead">Only <b data-num>${fPct(osmoPct)}</b> of NAM, <b data-num${osmoDisagree ? ' data-status="disagree"' : ''}>${fInt(SUP.osmosis)} NAM</b>, is on Osmosis, the one place it can be sold. The pools there hold <b data-num>${fUsd0(DEX.liquidityUsd)}</b>.</p>
    <div class="supply" role="img" aria-label="Supply bar: ${segs.map((s) => `${s.label} ${fPct(pct(s.v))}`).join(', ')}">
      <div class="supply__flag"><span>${fPct(osmoPct)} on Osmosis</span></div>
      <div class="supply__bar">${segs.map((s, i) => `<i class="sg sg--${s.k}" style="flex:${pct(s.v).toFixed(4)} 1 0%;--i:${i}">${s.inbar ? `<span class="sg__l">${s.k === 'rest' ? 'Spendable' : s.label} ${fPct(pct(s.v))}</span>` : ''}</i>`).join('')}</div>
      <div class="ruler ruler--scale" aria-hidden="true"></div>
      <div class="supply__scale" aria-hidden="true"><span>0</span><span>25</span><span>50</span><span>75</span><span>100%</span></div>
    </div>
    <ul class="legend">${segs.map((s) => `<li class="lg lg--${s.k}"><i class="lg__sw sg sg--${s.k}"></i><span class="lg__n">${s.label}</span><span class="lg__p" data-num>${fPct(pct(s.v))}</span><span class="lg__v"><span data-num${s.k === 'osmosis' && osmoDisagree ? ' data-status="disagree"' : ''}>${fInt(s.v)} NAM</span> · ${s.note}</span></li>`).join('')}</ul>
    ${osmoDisagree ? `<div class="notice" data-tone="warn">${ico('i-warn', 'ico notice__i')}<div><p class="notice__t">Two sources, ${fInt(drift)} NAM apart.</p>
      <p class="notice__s">Namada holds <span data-num>${fInt(escrow)}</span> NAM in escrow for Osmosis. Osmosis counts <span data-num>${fInt(osmoSup)}</span>. The gap is <span data-num>${fPct((drift / osmoSup) * 100, 3)}</span> of what is on Osmosis, and one of the cross-checks that needs a look.</p></div></div>` : ''}
    ${srcLine([{ label: 'Staked, public funding, shielded, all NAM', p: SUP.prov }, { label: 'NAM on Osmosis', p: osmoProvFig }], { label: 'Where the supply split comes from' })}
  </section>`;

  /* who holds NAM */
  const top = HOLDERS.holders.slice(0, CONFIG.holderRowsOnHome);
  const topMax = top[0].total;
  const holdersOld = holdersAreOld();
  const who = `<section class="sec${holdersOld ? ' is-old' : ''}" aria-labelledby="h-who">
    <h2 id="h-who" class="h2">Who holds NAM</h2>
    <p class="lead">The ${top.length} biggest holders own <b data-num>${fPct(O.concentration.namadaTop10Pct)}</b> of NAM on Namada. Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone.</p>
    ${holdersSentence()}
    <div class="dl dl--holders" role="table" aria-label="Ten biggest NAM holders">
      <div class="dl__head" role="row"><span role="columnheader">#</span><span role="columnheader">Holder</span><span role="columnheader" class="r">Total NAM</span><span role="columnheader" class="r">Share</span></div>
      ${top.map((h) => holderRow(h, topMax)).join('')}
    </div>
    ${holdersSrc()}
    <p class="more"><a class="link" href="holders.html"><span>All <span data-num>${fInt(HOLDERS.total)}</span> holders</span>${ico('i-arrow', 'ico ico--inline')}</a></p>
  </section>`;

  /* rail (desktop) */
  const rail = `<aside class="rail" aria-label="Right now"><div class="rail__in">
    <h2 class="rail__h">Right now</h2>
    <dl class="rail__list">
      <div><dt>Pool depth</dt><dd data-num>${fUsd0(DEX.liquidityUsd)}</dd><dd>${pdot(DEX.prov, { label: 'Pool depth' })}</dd></div>
      <div><dt>NAM on Osmosis</dt><dd data-num${osmoDisagree ? ' data-status="disagree"' : ''}>${nam(SUP.osmosis)}</dd><dd>${pdot(osmoProvFig, { label: 'NAM on Osmosis' })}</dd></div>
      <div><dt>Unstaking wait</dt><dd data-num>${trimZ(String(PRESS.unbondingDays))}<span class="u"> days</span></dd><dd>${pdot({ source: 'chain parameter', at: PRESS.asOf, status: 'live' }, { label: 'Unstaking wait' })}</dd></div>
      <div><dt>Cross-checks</dt><dd data-num>${okCount} of ${CHECKS.length}<span class="u"> pass</span></dd><dd>${pdot(checksProv, { label: 'Cross-checks' })}</dd></div>
    </dl></div></aside>`;

  /* path of a NAM, with the order-size curve inside step 4 */
  const steps = [
    { t: 'Staked', copy: 'Staked NAM is locked with validators and can’t be sold.', n: fInt(SUP.bonded), u: 'NAM', note: `${fPct(pct(SUP.bonded))} of all NAM`, p: SUP.prov },
    { t: 'Unlocked', copy: `Asking to unstake starts a wait of about ${trimZ(String(PRESS.unbondingDays))} days.`, n: trimZ(String(PRESS.unbondingDays)), u: 'days', note: 'the unstaking wait', p: { source: 'chain parameter', at: PRESS.asOf, status: 'live' } },
    { t: 'Bridged', copy: 'To be sold, NAM crosses to Osmosis. Crossings usually come before sales.', n: fInt(PRESS.ibcIn7d), u: 'NAM', note: `crossed in the last ${PRESS.windowDays} days`, p: { ...PRESS.coverage, plain: 'Flow index' } },
    { t: 'Sold', copy: `On Osmosis, NAM trades in small pools. An order of ${fInt(L10.amountNam)} NAM moves the price ${fPct(L10.sellImpactPct, 2)}. Drag the size below.`, n: fPct(L10.sellImpactPct, 2), u: 'price move', note: `selling ${fInt(L10.amountNam)} NAM`, p: curveProv },
  ];
  const path_ = `<section class="band ground-accent path" aria-labelledby="h-path">
  <div class="wrap">
    <p class="eyebrow">Four steps</p>
    <h2 id="h-path" class="h2">How NAM gets from a wallet to a sale</h2>
    <ol class="steps">${steps.map((s, i) => `<li class="step${s.wide ? ' step--wide' : ''}" style="--i:${i}">
      <span class="step__ring" aria-hidden="true"><svg viewBox="0 0 28 28"><circle class="r0" cx="14" cy="14" r="11.5" fill="none" stroke="currentColor" stroke-width="2.5"/><circle class="r1" cx="14" cy="14" r="6" fill="currentColor"/></svg></span>
      <div class="step__body">
        <p class="step__k"><span class="step__i">${i + 1}</span>${s.t}</p>
        <p class="step__copy">${esc(s.copy)}</p>
        <p class="step__fig"><span class="step__n" data-num>${s.n}</span><span class="step__u">${s.u}</span></p>
        <p class="step__note">${s.note} ${pdot(s.p)}</p>
      </div></li>`).join('')}</ol>
    <div class="explore"><h3 class="h3 explore__t">Drag an order size</h3>${curveBlock('home-curve', {})}${srcLine([{ label: 'Size table', p: curveProv }], { label: 'Where the size table comes from' })}</div>
    <p class="sidenote"><svg class="gly gly--lg" viewBox="0 0 12 12" aria-hidden="true"><use href="#g-shield"/></svg>Shielded NAM sits in a pool whose total is public and whose owners are not: <b data-num>${fPct(BLIND.sharePct)}</b> of all NAM. ${pdot(BLIND.shielded.prov, { label: 'Shielded NAM' })}</p>
  </div>
</section>`;

  /* mini ticket */
  const ticket = `<section class="sec sec--ticket" aria-labelledby="h-ticket">
    <h2 id="h-ticket" class="h2">What would you get right now?</h2>
    <div class="mini">
      <div class="mini__row"><span class="mini__k">Sell${QUOTE_DOWN ? ' · <span class="field__state"><i class="dot" data-status="old"></i>live quote not answering</span>' : ''}</span><span class="mini__amt" data-num>${fInt(L5.amountNam)}<span class="u"> NAM</span></span></div>
      <div class="mini__get"><span class="mini__k">You get about</span><span class="mini__v" data-num>${fUsdc(L5.sellOutUsdc)}<span class="u"> USDC</span></span>
        <span class="mini__chip">${chip(curveProv, { label: 'From the size table' })}</span></div>
      <div class="mini__row"><span class="mini__k">Price move</span><span class="mini__mv" data-num>${fSigned(-L5.sellImpactPct)}</span></div>
    </div>
    ${QUOTE_DOWN ? `<div class="notice" data-tone="warn">${ico('i-warn', 'ico notice__i')}<div><p class="notice__t">The Osmosis quote service is not answering.</p>
      <p class="notice__s">Last quoted price: <span data-num>${fPrice(PRICE)}</span>, ${esc(ageAgo(PRICE_PROV.at))}. These figures come from the size table, measured at the same moment, not from a live quote for your amount.</p></div></div>` : ''}
    <p class="more"><a class="link" href="trade.html"><span>Full quote</span>${ico('i-arrow', 'ico ico--inline')}</a></p>
  </section>`;

  /* why trust it */
  const rp = replayFacts();
  const needs = CHECKS.filter((c) => c.status !== 'ok');
  const passes = CHECKS.filter((c) => c.status === 'ok');
  const trust = `<section class="sec sec--trust" aria-labelledby="h-trust">
    <h2 id="h-trust" class="h2">Why you can trust these numbers</h2>
    <ol class="why">
      <li><b>Every number shows its source and age.</b> Tap a dot and age, or the source line under a list, to see them.</li>
      <li><b data-num>${okCount} of ${CHECKS.length}</b> cross-checks pass right now${warnCount ? `, <b data-num>${warnCount}</b> need a look` : ''}.</li>
      <li><b>Rewind:</b> see the site as it was.${rp ? ` Try <a href="supply.html?at=${rp.wts}">${esc(rp.wlabel)}</a>, the first alert before ${rp.million} million NAM were withdrawn from staking.` : ''}</li>
    </ol>
    ${rp ? `<div class="proof"><span class="tag tag--cat">Static, dated ${esc(rp.generated)}</span>
      <p>Tested on ${rp.events} past events (report of ${esc(rp.generated)}): each of the ${rp.of} biggest price moves had an alert-size flow in the prior ${rp.window} hours, median ${rp.lead} hours ahead. Such flows precede ${rp.base}% of all hours, so this shows the alerts are not blind, not that they predict direction.</p></div>` : ''}
    <ul class="chks">${needs.map(checkRow).join('')}</ul>
    <details class="passes"><summary><span>The ${passes.length} that pass</span>${ico('i-chev', 'ico')}</summary><ul class="chks">${passes.map(checkRow).join('')}</ul></details>
    ${srcLine([{ label: 'The seven cross-checks', p: checksProv }], { label: 'When the checks ran', lead: 'Cross-checks', text: ` ran ${ageAgo(CHECKS_AT)} \u00b7 fresh` })}
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
    js: `if(document.documentElement.scrollHeight<=innerHeight+2)document.documentElement.classList.add('static');\n${CURVE_JS}`,
  });
}

/* the most recent event that crossed an alert size (bond, unlock or unshield rules); production reads /api/alerts/recent over a wider window */
function lastAlertEvent() {
  const rows = [];
  for (const u of PRESS.unlocks) {
    if (u.kind === 'bond' && u.amountNam >= RULES.bond.thresholdNam) rows.push({ k: 'staked', amt: u.amountNam, ts: u.ts });
    else if ((u.kind === 'unbond' || u.kind === 'withdraw') && u.amountNam >= RULES.unlock.thresholdNam) rows.push({ k: u.kind === 'unbond' ? 'unstaking' : 'unlocked', amt: u.amountNam, ts: u.ts });
  }
  for (const u of BLIND.unshields) if (u.amount >= RULES.unshield.thresholdNam) rows.push({ k: 'shieldOut', amt: u.amount, ts: u.ts });
  rows.sort((a, b) => b.ts - a.ts);
  return rows[0] || null;
}
/* latest real moves of 1,000 NAM or more. Single moves where the snapshot has them; for Osmosis it has only
   per-address net totals, which are labelled as such. Production binds GET /api/flows?minNam=1000&limit=6. */
function latestMoves() {
  const MIN = CONFIG.tapeMinNam, rows = [];
  for (const m of PRESS.movers) if (m.netNam24h && Math.abs(m.netNam24h) >= MIN) rows.push({ k: m.netNam24h > 0 ? 'buy' : 'sell', amt: m.netNam24h, signed: true, ts: m.lastTs, who: shortAddr(m.address), detail: `net of ${WINDOW_H} h: ${m.buys} buys, ${m.sells} sells` });
  for (const u of BLIND.unshields) if (u.amount >= MIN) rows.push({ k: 'shieldOut', amt: u.amount, ts: u.ts, who: `to ${shortAddr(u.to)}` });
  for (const u of PRESS.unlocks) if (u.amountNam >= MIN) rows.push({ k: u.kind === 'bond' ? 'staked' : u.kind === 'unbond' ? 'unstaking' : 'unlocked', amt: u.amountNam, ts: u.ts, who: u.label ? niceLabel(u.label) : shortAddr(u.address) });
  rows.sort((a, b) => b.ts - a.ts);
  return rows.slice(0, CONFIG.tapeRows);
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
  return `<div class="spark">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Executed price, ${fPrice(pts[0].value)} on ${fDate(pts[0].ts)} to ${fPrice(last.value)} on ${fDate(last.ts)}"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>
    <p class="spark__c"><span data-num>${fSigned(ch, 0)}</span> since ${fDate(pts[0].ts)}, executed price ${pdot(EXEC_PROV, { label: 'Executed price' })}</p>
  </div>`;
}

/* ---------- holders: rows, one honest sentence, one source line ---------- */
function holdersAreOld() { return true; }   // the snapshot's holder rows carry no status; their balances were checked 2.3 days ago
const holdersCheckedAt = Math.min(...HOLDERS.holders.map((h) => h.verifiedAt));
const holdersProv = { source: 'Namada indexer (indexer.namada.net)', plain: 'Namada indexer', at: holdersCheckedAt, status: 'stale', note: 'Balances come from the indexer; staked amounts are re-read from the chain address by address.' };
const holdersAllZero = HOLDERS.holders.every((h) => h.change7d === 0);
function holdersSentence() {
  return `<div class="hl__sentence">${holdersAllZero ? `<p>No balance here changed in the last ${CHANGE_DAYS} days.</p>` : ''}
    <p class="old"><i class="dot" data-status="old"></i><span>Balances were last checked ${esc(fAge(holdersCheckedAt))} ago, so they are shown dimmed.</span></p></div>`;
}
const holdersSrc = () => srcLine([{ label: 'Balances', p: holdersProv }, { label: 'Staked amounts', p: { ...holdersProv, at: Math.max(...HOLDERS.holders.map((h) => h.bondedVerifiedAt)), status: 'live' } }], { label: 'Where the holder figures come from' });
function holderRow(h, maxTotal, full = false) {
  const name = h.label ? niceLabel(h.label) : null;
  const est = h.bondedEstimated != null && Math.abs(h.bondedEstimated - h.bonded) > 1;
  const linked = h.linked && h.linked.length ? `+${h.linked.length} linked on Osmosis` : '';
  const estProv = { source: 'Namada indexer (indexer.namada.net)', plain: 'Namada indexer', at: h.bondedVerifiedAt, status: 'conflict', note: `Two readings of this address's staked NAM differ by ${fInt(Math.abs(h.bonded - h.bondedEstimated))} NAM. The chain reading is shown; the other is the flow estimate.`,
    extra: [['Staked, read from the chain', `${fInt(h.bonded)} NAM`], ['Staked, flow estimate', `${fInt(h.bondedEstimated)} NAM`], ['Difference', `${fInt(Math.abs(h.bonded - h.bondedEstimated))} NAM`]] };
  const xs = est ? pdot(estProv, { label: 'Staked NAM, two readings', text: `estimate ${fInt(h.bondedEstimated)}` }) : '';
  const x = est ? `<span class="hrow__estl">${pdot(estProv, { label: 'Staked NAM, two readings', text: `staked figures differ by ${fInt(Math.abs(h.bonded - h.bondedEstimated))} NAM` })}</span>` : '';
  const cats = catTag(h.category, name || '');
  return `<div class="hrow${holdersAllZero ? '' : ' hrow--chg'}" role="row" data-cat="${h.category || 'none'}">
    <span class="hrow__rk" role="cell">${h.rank}</span>
    <span class="hrow__id" role="cell"><span class="hrow__name">${esc(name || shortAddr(h.address))}</span><span class="hrow__addr mono">${name ? esc(shortAddr(h.address)) : 'no label'}${linked ? ` · ${esc(linked)}` : ''}</span>${cats ? `<span class="hrow__tags">${cats}</span>` : ''}</span>
    <span class="hrow__tot" role="cell" data-num>${fInt(h.total)}<span class="u"> NAM</span></span>
    <span class="hrow__pct" role="cell" data-num>${fPct(h.pctSupply, 2)}<span class="u"> of supply</span></span>
    <span class="hrow__spend" role="cell" data-num>${fInt(h.balance)}</span>
    <span class="hrow__stake" role="cell" data-num${est ? ' data-status="disagree"' : ''}>${fInt(h.bonded)}${est ? `<span class="hrow__est">${xs}</span>` : ''}</span>
    ${holdersAllZero ? '' : `<span class="hrow__chg" role="cell" data-num>${h.change7d === 0 ? 'no change' : fSigned(h.change7d, 0, ' NAM')}</span>`}
    <span class="hrow__x" role="cell">${x}</span>
    <i class="hrow__bar" style="--w:${((h.total / maxTotal) * 100).toFixed(2)}%" aria-hidden="true"></i>
  </div>`;
}

/* ============================================================================
   TRADE
   ============================================================================ */
function chartSvg(rangeKey, size) {
  const span = CONFIG.ranges[rangeKey];
  const t0 = NOW - span, t1 = NOW;
  const exec = S.executedHistory30d.filter((p) => p.ts >= t0);
  const spot = { ts: Math.min(PRICE_PROV.at, NOW), value: PRICE };
  const quoted = [...S.priceHistory7d.filter((p) => p.ts >= t0), spot];
  const all = [...exec.map((p) => p.value), ...quoted.map((p) => p.value)];
  let lo = Math.min(...all), hi = Math.max(...all);
  const step = niceStep((hi - lo) * 1.25, size === 'p' ? 4 : 5);
  lo = Math.floor((lo - (hi - lo) * 0.05) / step) * step;
  hi = Math.ceil((hi + (hi - lo) * 0.05) / step) * step;
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const phone = size === 'p';
  const W = phone ? 328 : 600, H = phone ? 208 : 288;
  const fs = phone ? 11 : 13;
  const tickVals = [];
  for (let v = lo; v <= hi + step / 2; v += step) tickVals.push(v);
  const labelChars = Math.max(...tickVals.map((v) => v.toFixed(dec).length));
  const m = { l: Math.ceil(labelChars * fs * 0.62) + 14, r: phone ? 10 : 14, t: phone ? 26 : 30, b: phone ? 26 : 28 };
  const X = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  let yTicks = '';
  for (const v of tickVals) yTicks += `<line class="c-grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="c-tick" x="${m.l - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end" style="font-size:${fs}px">${v.toFixed(dec)}</text>`;
  const xStep = rangeKey === '24h' ? 6 * 3600e3 : rangeKey === '7d' ? 2 * 86400e3 : 7 * 86400e3;
  const xAnchor = rangeKey === '24h' ? Math.floor(NOW / xStep) * xStep : Math.floor(NOW / 86400e3) * 86400e3;
  let xTicks = '';
  const maxTicks = phone ? 5 : 6;
  const stepMul = Math.ceil(((t1 - t0) / xStep + 1) / maxTicks) || 1;
  for (let t = xAnchor; t >= t0; t -= xStep * stepMul) {
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
  const pill = lastE ? `<g class="c-pill"><rect x="${px.toFixed(1)}" y="${py.toFixed(1)}" width="${pw}" height="${ph}" rx="${ph / 2}"/><text x="${(px + pw / 2).toFixed(1)}" y="${(py + ph / 2 + 4).toFixed(1)}" text-anchor="middle" style="font-size:${fs}px">${pillT}</text></g>` : '';
  /* event markers: the biggest recorded price moves inside the window (docs/events.json), dashed verticals, labels of 12 characters or fewer */
  const evs = EVENTS.events.filter((e) => e.type === 'price_move' && e.t1 >= t0 && e.t1 <= t1).sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, CONFIG.eventsOnChart);
  let evt = '';
  for (const e of evs) {
    const x = X(e.t1);
    const lbl = fSigned(e.pct, 1);
    if (lbl.length > CONFIG.eventLabelMax) continue;
    const anchor = x > W - m.r - 40 ? 'end' : 'start';
    evt += `<line class="c-evt" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${m.t - 6}" y2="${H - m.b}"/><text class="c-evtl" x="${(x + (anchor === 'end' ? -4 : 4)).toFixed(1)}" y="${m.t - 10 + 12}" text-anchor="${anchor}" style="font-size:${fs}px">${lbl}</text>`;
  }
  const sparse = exec.length < 3;
  const data = JSON.stringify(exec.map((p) => [Math.round(X(p.ts) * 10) / 10, p.ts, p.value]));
  return `<svg class="chart chart--${size}" viewBox="0 0 ${W} ${H}" role="img" data-pts='${data}' data-w="${W}" data-h="${H}" aria-label="Price chart, ${rangeKey}. Executed price solid, quoted price dashed.">
    ${yTicks}${xTicks}${evt}
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
  if (exec.length < 2) return { head: `Only ${exec.length} ${exec.length === 1 ? 'trade' : 'trades'} in ${CONFIG.ranges[rangeKey] / 3600e3} hours`, sub: 'Too few executed trades to draw a trend. Dots show the hourly median where trades happened.', n: exec.length };
  const a = exec[0], b = exec[exec.length - 1];
  const ch = (b.value / a.value - 1) * 100;
  return { head: `Executed price ${ch >= 0 ? 'up' : 'down'} ${fDec(Math.abs(ch), 0)}% since ${fDate(a.ts)}`, sub: `USDC per NAM, hourly median of executed swaps, ${exec.length} points.`, n: exec.length };
}

function trade() {
  popovers.clear(); pvCount = 0;
  const sizes = CURVE.curve.map((r) => r.amountNam);
  const sell = (r) => ({ get: r.sellOutUsdc, avg: r.sellEffectiveUsd, move: -r.sellImpactPct });
  const buy = (r) => ({ pay: r.buyInUsdc, avg: r.buyEffectiveUsd, move: r.buyImpactPct, out: r.buyInUsdc / r.buyEffectiveUsd });
  const estChip = chip(curveProv, { label: 'From the size table' });
  const deriveChip = chip(derive([{ at: curveProv.at, status: curveProv.status }], 'USDC paid divided by average price'), { label: 'About how many NAM', text: 'derived · now' });
  const topPool = S.pools.pools[0];
  const sizeTableWhy = 'These figures come from the size table, measured at the same moment, not from a live quote for your amount.';

  const resPanels = [];
  for (const r of CURVE.curve) {
    const s = sell(r), b = buy(r);
    resPanels.push(`<div class="res" data-side="sell" data-size="${r.amountNam}"${r.amountNam === CONFIG.defaultSize ? '' : ' hidden'}>
      <p class="get__k">You get${QUOTE_DOWN ? ' <span class="field__state"><i class="dot" data-status="old"></i>from the size table</span>' : ''}</p>
      <p class="get__v" data-num>${fUsdc(s.get)}<span class="get__u">USDC</span></p>
      <p class="get__s">for <span data-num>${fInt(r.amountNam)} NAM</span> at an average <span data-num>${fPrice(s.avg)}</span> each</p>
      <dl class="pair"><div><dt>Quoted price</dt><dd data-num>${fPrice(CURVE.spotUsd)}</dd></div><div><dt>Price move</dt><dd data-num class="pair__big">${fSigned(s.move)}</dd></div></dl>
    </div>`);
    resPanels.push(`<div class="res" data-side="buy" data-size="${r.amountNam}" hidden>
      <p class="get__k">You pay${QUOTE_DOWN ? ' <span class="field__state"><i class="dot" data-status="old"></i>from the size table</span>' : ''}</p>
      <p class="get__v" data-num>${fUsdc(b.pay)}<span class="get__u">USDC</span></p>
      <p class="get__s">for about <span data-num>${fInt(b.out)} NAM</span> at an average <span data-num>${fPrice(b.avg)}</span> each</p>
      <dl class="pair"><div><dt>Quoted price</dt><dd data-num>${fPrice(CURVE.spotUsd)}</dd></div><div><dt>Price move</dt><dd data-num class="pair__big">${fSigned(b.move)}</dd></div></dl>
    </div>`);
  }
  const amtSpans = sizes.map((n) => `<span class="amt" data-size="${n}"${n === CONFIG.defaultSize ? '' : ' hidden'}>${fInt(n)}</span>`).join('');
  const usdSpans = sizes.map((n) => `<span class="amt-usd" data-size="${n}"${n === CONFIG.defaultSize ? '' : ' hidden'}>${fUsd(ladder(n).usdSize)}</span>`).join('');

  const radios = `<input class="sr-only" type="radio" name="side" id="sd-sell" checked><input class="sr-only" type="radio" name="side" id="sd-buy">
    ${sizes.map((n) => `<input class="sr-only" type="radio" name="size" id="sz-${n}"${n === CONFIG.defaultSize ? ' checked' : ''}>`).join('')}
    ${Object.keys(CONFIG.ranges).map((k) => `<input class="sr-only" type="radio" name="range" id="rg-${k}"${k === CONFIG.defaultRange ? ' checked' : ''}>`).join('')}`;

  const ticketPanel = `<div class="ticket">
    <p class="eyebrow">Trade · NAM on Osmosis</p>
    <h1 id="h1" class="h1"><span class="only-sell">What would I get if I sold NAM now?</span><span class="only-buy">What would I pay to buy NAM now?</span></h1>
    <p class="sub">An Osmosis quote, not an order. This site never trades for you.</p>
    <div class="seg seg--2 seg--side" role="radiogroup" aria-label="Side">
      <label class="seg__opt" for="sd-sell"><span>Sell NAM for USDC</span></label>
      <label class="seg__opt" for="sd-buy"><span>Buy NAM with USDC</span></label>
    </div>
    <div class="field">
      <div class="field__top"><span class="field__l">Amount</span>${QUOTE_DOWN ? '<span class="field__state"><i class="dot" data-status="old"></i>live quote not answering</span>' : ''}</div>
      <div class="field__box"><span class="field__v" data-num>${amtSpans}</span><span class="field__u">NAM</span></div>
      <p class="field__worth"><span class="only-sell">Worth about </span><span class="only-buy">Value of about </span><span data-num>${usdSpans}</span></p>
    </div>
    <div class="presets" role="radiogroup" aria-label="Amount presets">${sizes.map((n) => `<label class="pre" for="sz-${n}"><span data-num>${fInt(n)}</span></label>`).join('')}</div>
    ${QUOTE_DOWN ? '<p class="field__note">Listed sizes only: other sizes cannot be quoted until the quote service answers.</p>' : ''}
    <div class="get" aria-live="polite">${resPanels.join('\n')}
      ${QUOTE_DOWN ? `<p class="get__why">${esc(sizeTableWhy)}</p>` : ''}
      <p class="get__prov">${estChip}</p>
      <p class="get__why get__why--sm only-buy">About how many NAM: derived from USDC paid and average price ${deriveChip}</p>
    </div>
  </div>`;

  const thin = `<div class="notice notice--thin" data-tone="warn">${ico('i-warn', 'ico notice__i')}<div>
    <p class="notice__t">Thin market.</p>
    <p class="notice__s">The pools on Osmosis hold <span data-num>${fUsd0(CURVE.totalLiquidityUsd)}</span> in total, across <span data-num>${fInt(CURVE.poolsCount)}</span> pools. <span class="only-sell">A sale of ${fInt(CONFIG.defaultSize)} NAM already moves the price ${fPct(L5.sellImpactPct, 2)}.</span><span class="only-buy">A purchase of ${fInt(CONFIG.defaultSize)} NAM already moves the price ${fPct(L5.buyImpactPct, 2)}.</span></p></div></div>`;

  /* chart block */
  const ranges = Object.keys(CONFIG.ranges);
  const quotedSince = S.priceHistory7d[0].ts;
  const ex = S.executedHistory30d;
  const lowP = ex.reduce((a, b) => (b.value < a.value ? b : a)), highP = ex.reduce((a, b) => (b.value > a.value ? b : a)), lastP = ex[ex.length - 1];
  const hoursWithTrade = ex.length, hoursTotal = Math.round(CONFIG.ranges['30d'] / 3600e3);
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
    <p class="readout" aria-live="polite"><span class="readout__k">Last executed</span> <b data-num class="readout__v">${fPrice(lastP.value)}</b> <span class="readout__t">${esc(fDate(lastP.ts))}, ${esc(fTime(lastP.ts))} UTC</span></p>
    ${ranges.map((k) => `<div class="rg" data-range="${k}"${k === CONFIG.defaultRange ? '' : ' hidden'}>${chartSvg(k, 'p')}${chartSvg(k, 'd')}</div>`).join('')}
    <ul class="key"><li><i class="key__ln"></i>Executed price</li><li><i class="key__ln key__ln--dash"></i>Quoted price, recorded since <span data-num>${esc(fDate(quotedSince))}</span></li><li>Dashed verticals: the three biggest price moves</li></ul>
    <dl class="cstats">
      <div><dt>Low</dt><dd data-num>${fPrice(lowP.value)}<small>${esc(fDate(lowP.ts))}</small></dd></div>
      <div><dt>High</dt><dd data-num>${fPrice(highP.value)}<small>${esc(fDate(highP.ts))}</small></dd></div>
      <div><dt>Last trade price</dt><dd data-num>${fPrice(lastP.value)}<small>${esc(ageAgo(lastP.ts))}</small></dd></div>
      <div><dt>Quoted now</dt><dd data-num>${fPrice(PRICE)}<small>${esc(ageAgo(PRICE_PROV.at))}</small></dd></div>
    </dl>
    <p class="cap">Trades are sparse: only <span data-num>${fInt(hoursWithTrade)}</span> of the last <span data-num>${fInt(hoursTotal)}</span> hours had one, so the line joins hourly medians and the quoted line has only ${S.priceHistory7d.length + 1} points so far.</p>
    ${srcLine([{ label: 'Executed price (solid)', p: { ...EXEC_PROV, status: 'stale', note: 'Hourly median of executed NAM/USDC swaps. The last hour with a trade was 10:00 UTC.' } }, { label: 'Quoted price (dashed)', p: PRICE_PROV }], { label: 'Where the chart comes from' })}
    <p class="sr-only">First executed price ${fPrice(ex[0].value)}, lowest ${fPrice(lowP.value)}, highest ${fPrice(highP.value)}, last ${fPrice(lastP.value)}.</p>
  </section>`;

  /* size block: the curve, then the ladder */
  const lRow = (r) => {
    const s = sell(r), b = buy(r);
    return `<label class="lrow" role="row" for="sz-${r.amountNam}" data-size="${r.amountNam}">
      <span class="lrow__size" role="cell" data-num>${fInt(r.amountNam)}<span class="u"> NAM</span></span>
      <span class="lrow__val" role="cell" data-num><span class="wl">worth </span>${fUsd(r.usdSize)}</span>
      <span class="lrow__sell" role="cell"><span class="lrow__w">Sell</span><span class="lrow__mv" data-num>${fSigned(s.move)}</span><span>get <span class="lrow__get" data-num>${fUsdc(s.get)}</span></span></span>
      <span class="lrow__buy" role="cell"><span class="lrow__w">Buy</span><span class="lrow__mv" data-num>${fSigned(b.move)}</span><span>pay <span class="lrow__pay" data-num>${fUsdc(b.pay)}</span></span></span>
      <span class="lrow__sget" role="cell" data-num>${fUsdc(s.get)}<span class="u"> USDC</span></span>
      <span class="lrow__smv" role="cell" data-num>${fSigned(s.move)}</span>
      <span class="lrow__bpay" role="cell" data-num>${fUsdc(b.pay)}<span class="u"> USDC</span></span>
      <span class="lrow__bmv" role="cell" data-num>${fSigned(b.move)}</span>
    </label>`;
  };
  const ladderSec = `<section class="band g-accent-to-ink ladder" aria-labelledby="h-ladder"><div class="wrap">
    <h2 id="h-ladder" class="h2">How size moves the price</h2>
    <p class="lead">Tap a size to quote it. Every dot is a real quote from the pools.</p>
    ${curveBlock('trade-curve', {})}
    <div class="dl dl--ladder" role="table" aria-label="Price move by order size">
      <div class="dl__head" role="row"><span role="columnheader">Size</span><span role="columnheader" class="r">Value</span>
        <span role="columnheader" class="r">You get</span><span role="columnheader" class="r">Price move</span>
        <span role="columnheader" class="r">You pay</span><span role="columnheader" class="r">Price move</span></div>
      ${CURVE.curve.map(lRow).join('')}
    </div>
    <p class="cap" style="margin-top:var(--s-4)">The largest order that moves the price 1% or less, buying or selling, is <b data-num>${fInt(CURVE.maxSafeClip1PctNam)} NAM</b>; 3% or less, <b data-num>${fInt(CURVE.maxSafeClip3PctNam)} NAM</b>.</p>
    ${srcLine([{ label: 'Size table', p: curveProv }], { label: 'Where the size table comes from' })}
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
    ${srcLine([{ label: 'Pools', p: { ...S.pools.prov, plain: 'Osmosis pools' } }], { label: 'Where the pool list comes from' })}
  </section>`;

  /* generated state rules: side x size, size highlight, range */
  const rules = [];
  const SEL = 'background:var(--c-sel-bg);color:var(--c-sel-ink)';
  for (const n of sizes) {
    rules.push(`.trade:has(#sz-${n}:checked) :is(.res,.amt,.amt-usd):not([data-size="${n}"]){display:none}`);
    rules.push(`.trade:has(#sz-${n}:checked) :is(.amt,.amt-usd)[data-size="${n}"]{display:inline}`);
    rules.push(`.trade:has(#sz-${n}:checked) label.pre[for="sz-${n}"]{${SEL};border-color:var(--c-sel-bg)}`);
    rules.push(`.trade:has(#sz-${n}:checked) .lrow[data-size="${n}"]{${SEL};--c-ink:var(--c-sel-ink);--c-ink-2:var(--c-sel-ink);--c-ink-3:var(--c-sel-ink);--c-line:transparent}`);
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
  for (const id of [...sizes.map((n) => `sz-${n}`), 'sd-sell', 'sd-buy', ...ranges.map((k) => `rg-${k}`)]) {
    rules.push(`.trade:has(#${id}:focus-visible) label[for="${id}"]{outline:2px solid var(--c-focus);outline-offset:2px}`);
  }

  const body = `<div class="trade">
  ${radios}
  <div class="split">
    <div class="split__a ground-accent"><div class="split__stick">${ticketPanel}${thin}</div></div>
    <div class="split__b ground-ink">${chartBlock}${ladderSec}</div>
  </div>
  <div class="band ground-ink pools"><div class="wrap">${poolsSec}</div></div>
</div>
${footer()}`;

  page({
    file: 'trade.html',
    title: 'Trade: what would I get if I sold NAM now?',
    desc: 'An Osmosis quote for NAM, how order size moves the price, and the pools that trade it. Not an order.',
    active: 'trade',
    body,
    css: rules.join('\n'),
    js: `${CURVE_JS}
(function(){var svgs=document.querySelectorAll('svg.chart'),ro=document.querySelector('.readout'),rv=ro&&ro.querySelector('.readout__v'),rt=ro&&ro.querySelector('.readout__t');
var M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];function p2(n){return String(n).padStart(2,'0')}
var base=ro&&{k:ro.querySelector('.readout__k').textContent,v:rv.textContent,t:rt.textContent};
svgs.forEach(function(s){var pts=JSON.parse(s.getAttribute('data-pts')||'[]'),cur=s.querySelector('.c-cursor'),W=+s.getAttribute('data-w');
function at(e){var r=s.getBoundingClientRect(),x=(e.clientX-r.left)/r.width*W,b=null,d=1e9;pts.forEach(function(p){var dd=Math.abs(p[0]-x);if(dd<d){d=dd;b=p}});return b}
function move(e){var b=at(e);if(!b)return;cur.setAttribute('x1',b[0]);cur.setAttribute('x2',b[0]);cur.style.opacity=1;var d=new Date(b[1]);ro.querySelector('.readout__k').textContent='Executed';rv.textContent='$'+b[2].toFixed(6);rt.textContent=d.getUTCDate()+' '+M[d.getUTCMonth()]+', '+p2(d.getUTCHours())+':'+p2(d.getUTCMinutes())+' UTC'}
function leave(){cur.style.opacity=0;if(base){ro.querySelector('.readout__k').textContent=base.k;rv.textContent=base.v;rt.textContent=base.t}}
s.addEventListener('pointermove',move);s.addEventListener('pointerleave',leave);s.addEventListener('pointerdown',move)});})();
/* the ticket's size presets move the curve cursor (production: one shared amount) */
(function(){var fig=document.querySelector('[data-curve]');if(!fig)return;document.querySelectorAll('input[name=size]').forEach(function(r){r.addEventListener('change',function(){var n=+r.id.replace('sz-','');if(fig.curvePaint){fig.curvePaint(n);var P=JSON.parse(fig.querySelector('[data-pts]').textContent),lo=P[0].n,hi=P[P.length-1].n;fig.querySelector('[data-range]').value=Math.round((Math.log(n)-Math.log(lo))/(Math.log(hi)-Math.log(lo))*1000)}})})})();`,
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
  const idxProv = { source: 'Namada indexer (indexer.namada.net)', at: idxAt, status: 'live' };

  const radios = `<input class="sr-only" type="radio" name="chain" id="ch-namada" checked><input class="sr-only" type="radio" name="chain" id="ch-osmosis">
    ${cats.map(([k]) => `<input class="sr-only" type="radio" name="cat" id="ct-${k}"${k === 'all' ? ' checked' : ''}>`).join('')}`;
  const filterGroups = `<fieldset class="fset"><legend class="fset__l">Chain</legend><div class="seg seg--2" role="radiogroup">
      <label class="seg__opt" for="ch-namada"><span>Namada</span></label><label class="seg__opt" for="ch-osmosis"><span>Osmosis</span></label></div></fieldset>
    <fieldset class="fset"><legend class="fset__l">What</legend><div class="chipsel" role="radiogroup">
      ${cats.map(([k, l]) => `<label class="chipsel__o" for="ct-${k}"><span>${l}<span class="chipsel__n" data-num>${counts[k]}</span></span></label>`).join('')}</div></fieldset>`;

  const summary = [
    { n: fInt(NAMADA.holders), l: 'holders on Namada', p: idxProv, name: 'Holders on Namada' },
    { n: fPct(O.concentration.namadaTop10Pct), l: 'owned by the top 10', p: idxProv, name: 'Share held by the top 10 on Namada' },
    { n: fInt(DEX.holders), l: 'holders on Osmosis', p: DEX.prov, name: 'Holders on Osmosis' },
    { n: fPct(O.concentration.osmosisTop10Pct), l: 'owned by the top 10 there', p: DEX.prov, name: 'Share held by the top 10 on Osmosis' },
  ];
  const hero = `<section class="band ground-accent hhero" aria-labelledby="h1"><div class="wrap">
    <p class="eyebrow">Activity · Holders</p>
    <h1 id="h1" class="h1">Who holds NAM?</h1>
    <p class="sub">The biggest holders, with when each balance was last checked. Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone.</p>
    <ul class="facts facts--4">${summary.map((f) => `<li class="fact"><span class="fact__n" data-num>${f.n}</span><span class="fact__l">${f.l}</span></li>`).join('')}</ul>
    ${srcLine(summary.map((f) => ({ label: f.name, p: f.p })), { label: 'Where the four figures come from' })}
  </div>${ruler('ruler--bottom')}</section>`;

  const list = `<div class="band ground-ink hl-band${holdersAreOld() ? ' is-old' : ''}"><div class="wrap">
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
    ${holdersSentence()}
    <p class="hl__count" aria-live="polite"><span data-num class="hl__n">${rows.length}</span> of <span data-num>${fInt(HOLDERS.total)}</span> holders captured in this snapshot, biggest first.</p>
    <div class="dl dl--holders dl--full" role="table" aria-label="Holders of NAM on Namada">
      <div class="dl__head${holdersAllZero ? '' : ' dl__head--chg'}" role="row"><span role="columnheader">#</span><span role="columnheader">Holder</span><span role="columnheader" class="r">Total NAM</span><span role="columnheader" class="r">Share</span><span role="columnheader" class="r">Spendable</span><span role="columnheader" class="r">Staked</span>${holdersAllZero ? '' : '<span role="columnheader" class="r">7 days</span>'}</div>
      ${rows.map((h) => holderRow(h, maxTotal, true)).join('')}
    </div>
    ${holdersSrc()}
    <div class="empty empty--filter" id="empty-filter"><svg class="empty__ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 5"/></svg>
      <div><p class="empty__t">No holder in this snapshot matches.</p><p class="empty__s">Only the top ${rows.length} holders were captured. Clear the filter to see them.</p></div></div>
    <div class="empty empty--osmosis" id="empty-osmosis"><svg class="empty__ring" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 5"/></svg>
      <div><p class="empty__t">The Osmosis list was not captured.</p>
      <p class="empty__s"><span data-num>${fInt(DEX.holders)}</span> addresses hold NAM on Osmosis and the top 10 own <span data-num>${fPct(O.concentration.osmosisTop10Pct)}</span> of it. Choose Namada to see the rows.</p></div></div>
    <div class="more more--load"><button class="btn btn--secondary" type="button" disabled>Load more holders</button><p class="cap">The snapshot holds the first ${rows.length} rows only.</p></div>
  </div>
  </div></div>`;

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
  rules.push('.hl:has(#ch-osmosis:checked) :is(.dl,.hl__count,.more--load,.src,.hl__sentence,#empty-filter){display:none !important}.hl:has(#ch-osmosis:checked) #empty-osmosis{display:grid}');

  page({
    file: 'holders.html',
    title: 'Holders: who holds NAM?',
    desc: 'The biggest NAM holders with share of supply and when each balance was last checked.',
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
