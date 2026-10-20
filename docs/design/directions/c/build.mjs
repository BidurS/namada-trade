#!/usr/bin/env node
/* ==========================================================================
   NamadaTrade, Direction C: Paper and receipts. Page builder.

   node build.mjs   (from this folder)

   Reads ../../data/snapshot.json (the live API, frozen) and ../../../replay-report.md
   and writes home.html, trade.html, holders.html (+ home.dark.html, the dark variant).
   Nothing numeric is typed by hand: every figure comes from the snapshot or is a
   derive() of snapshot fields, and carries a provenance object (source, at, status).
   Ages are computed against snapshot.capturedAt, so the pages are a frozen frame.

   The only literals are design parameters, listed in CONFIG below, and each one is
   labelled where it is shown (for example "moves of 1,000 NAM or more").
   ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(join(HERE, '../../data/snapshot.json'), 'utf8'));
const CSS = readFileSync(join(HERE, 'components.css'), 'utf8');
const JS = readFileSync(join(HERE, 'client.js'), 'utf8');

const CAP = snap.capturedAt;
const OV = snap.overview, PR = snap.pressure, BS = snap.blindspot, CV = snap.curve;

/* ---- design parameters (not data) ---------------------------------------- */
const CONFIG = {
  staleMs: 5 * 60 * 1000,     // docs/decisions.md D6: a number older than 5 minutes is "old"
  tapeMinNam: 1000,           // the tape lists moves of at least this many NAM
  tapeRows: 8,
  homeAlertProbeNam: 10000,   // "at today's price 10,000 NAM is ..." (equals the big-trade rule threshold)
  holdersLimit: 10,
  holderSizeSteps: [50e6, 20e6], // size filter on Holders: "50M or more", "20M or more"
  changeDays: 7,              // holders[].change7d is a seven-day change
  quoteCadence: '1-minute',   // docs/decisions.md D6: quotes are stored every minute
};
const WIN_H = Math.round((snap.alerts.until - snap.alerts.since) / 3600e3); // the alert window, in hours

/* ---- formatting ------------------------------------------------------------ */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nf = (n, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const MINUS = '−';
const sgn = (v, d = 2, unit = '%') => (v > 0 ? '+' : v < 0 ? MINUS : '') + nf(Math.abs(v), d) + unit;
const price6 = (v) => '$' + v.toFixed(6);
const usd = (v, whole) => {
  const a = Math.abs(v);
  if (whole || a >= 1000) return '$' + nf(v, 0);
  if (a >= 1) return '$' + nf(v, 2);
  if (a >= 0.1) return '$' + nf(v, 2);
  return '$' + Number(v.toPrecision(4)).toFixed(Math.min(8, Math.max(2, 3 - Math.floor(Math.log10(a)))));
};
const pct = (v, d) => nf(v, d ?? (v >= 10 ? 1 : v >= 1 ? 1 : 2)) + '%';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const d2 = (n) => String(n).padStart(2, '0');
const hm = (ts) => { const d = new Date(ts); return `${d2(d.getUTCHours())}:${d2(d.getUTCMinutes())}`; };
const hms = (ts) => { const d = new Date(ts); return `${hm(ts)}:${d2(d.getUTCSeconds())}`; };
const dm = (ts) => { const d = new Date(ts); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const dmy = (ts) => `${dm(ts)} ${new Date(ts).getUTCFullYear()}`;
const ageMs = (at) => Math.max(0, CAP - at);
function ageShort(ms) {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 48) return `${nf(h, 1)} h`;
  return `${nf(h / 24, 1)} d`;
}
const ageOf = (at) => ageShort(ageMs(at));
const ago = (at) => `${ageOf(at)} ago`;
const agoP = (at) => (ageMs(at) < 5000 ? 'just now' : ago(at)); // prose, where "0 s ago" would read oddly
const short = (a) => a.slice(0, 10) + '…' + a.slice(-4);
const tidy = (label) => {
  if (!label) return null;
  const t = label.replace(/^Genesis: /, 'Genesis · ').replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const plainSource = (s) => ({
  'Osmosis SQS': 'Osmosis quotes',
  'Osmosis SQS pools': 'Osmosis pools',
  'executed NAM/USDC swaps (hourly median)': 'Osmosis trades, hourly median',
  'Namada RPC abci_query': 'Namada nodes',
  'Keplr Osmosis bank/supply': 'Osmosis supply record',
  'Namada RPC (MASP balance)': 'Namada nodes',
  'D1 flow index': 'flow index',
  'last indexed Osmosis flow': 'flow index',
}[s] || s);

/* ---- provenance ------------------------------------------------------------ */
const P = (source, at, status, note) => ({ source, at, status, note });
const statusOf = (prov) => {
  if (!prov) return 'none';
  if (prov.status === 'conflict') return 'conflict';
  if (prov.status === 'missing') return 'none';
  if (prov.status === 'stale') return 'old';
  return ageMs(prov.at) > CONFIG.staleMs ? 'old' : 'fresh';
};
const STATUS_WORD = { fresh: 'fresh', old: 'old', conflict: 'sources disagree', none: 'no data' };
const rank = { fresh: 0, old: 1, none: 2, conflict: 3 };
const worst = (...ss) => ss.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'fresh');
const oldest = (...provs) => provs.reduce((a, b) => (b.at < a.at ? b : a));
function provText(prov, s, extra) {
  if (!prov) return `${STATUS_WORD[s]}${extra ? ' · ' + extra : ''}`;
  const raw = prov.source !== plainSource(prov.source) ? ` (${prov.source})` : '';
  return `${plainSource(prov.source)}${raw} · ${STATUS_WORD[s]} · ${hms(prov.at)} UTC · ${ageOf(prov.at)} old${extra ? ' · ' + extra : ''}${prov.note ? ' · ' + prov.note : ''}`;
}
/** A number with ambient provenance: underline style = freshness, tap = receipt. */
function N(text, prov, o = {}) {
  const s = o.s || statusOf(prov);
  const age = o.age && prov ? `<span class="age">${ageOf(prov.at)}</span>` : '';
  if (o.nofocus) return `<span class="n${o.cls ? ' ' + o.cls : ''}" data-s="${s}">${text}</span>`;
  return `<span class="n${o.cls ? ' ' + o.cls : ''}" data-s="${s}" tabindex="0" data-prov="${esc(provText(prov, s, o.note))}">${text}</span>${age}`;
}
const U = (u) => `<span class="u">${u}</span>`;
/** Panel footer: the stub. */
function stub(provs, o = {}) {
  const list = provs.filter(Boolean);
  const s = worst(...list.map(statusOf));
  const glyph = { fresh: 'i-tick', old: 'i-clock', conflict: 'i-warn', none: 'i-dash' }[s];
  const parts = list.map((p) => {
    const note = p.note ? ` · ${esc(p.note)}` : '';
    return `${esc(plainSource(p.source))} · ${hm(p.at)} · ${ageOf(p.at)} old${note}`;
  });
  return `<p class="stub" data-s="${s}"><svg class="g" aria-hidden="true"><use href="#${glyph}"/></svg><span class="stub-k">Source</span><span class="stub-t">${parts.join(' <i>/</i> ')}${o.extra ? ' · ' + o.extra : ''}<span class="stub-s">${STATUS_WORD[s]}</span></span></p>`;
}

/* ---- icons ----------------------------------------------------------------- */
const SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="g-buy" viewBox="0 0 10 10"><path d="M5 9V2M2 5l3-3 3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></symbol>
<symbol id="g-sell" viewBox="0 0 10 10"><path d="M5 1v7M2 5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></symbol>
<symbol id="g-bridge" viewBox="0 0 10 10"><path d="M1 5h6M4.5 2.5L7 5 4.5 7.5M9 1.5v7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></symbol>
<symbol id="g-shield" viewBox="0 0 10 10"><path d="M6 1.5H1.5v7H6M4 5h5M7 3l2 2-2 2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></symbol>
<symbol id="g-shield-in" viewBox="0 0 10 10"><path d="M4 1.5h4.5v7H4M1 5h5.5M4.5 3L6.5 5 4.5 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></symbol>
<symbol id="g-stake" viewBox="0 0 10 10"><path d="M2 4.5h6v4H2zM3.5 4.5V3a1.5 1.5 0 013 0v1.5" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>
<symbol id="g-unstake" viewBox="0 0 10 10"><path d="M2 1.5h6M2 8.5h6M2.5 1.5L5 5 2.5 8.5M7.5 1.5L5 5l2.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4"/></symbol>
<symbol id="g-unlock" viewBox="0 0 10 10"><path d="M2 4.5h6v4H2zM6.5 4.5V3A1.5 1.5 0 003.5 3" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>
<symbol id="i-home" viewBox="0 0 20 20"><path d="M3 9.5L10 3l7 6.5M5 8v9h10V8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/></symbol>
<symbol id="i-trade" viewBox="0 0 20 20"><path d="M3 7h13M12 3l4 4-4 4M17 13H4M8 9l-4 4 4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/></symbol>
<symbol id="i-movers" viewBox="0 0 20 20"><path d="M3 5h14M3 10h10M3 15h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt"/></symbol>
<symbol id="i-feed" viewBox="0 0 20 20"><path d="M3 5h2M7 5h10M3 10h2M7 10h10M3 15h2M7 15h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></symbol>
<symbol id="i-more" viewBox="0 0 20 20"><path d="M3 8.5h3v3H3zM8.5 8.5h3v3h-3zM14 8.5h3v3h-3z" fill="none" stroke="currentColor" stroke-width="1.5"/></symbol>
<symbol id="i-search" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12.5 12.5L17 17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></symbol>
<symbol id="i-arrow" viewBox="0 0 16 16"><path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/></symbol>
<symbol id="i-x" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></symbol>
<symbol id="i-tick" viewBox="0 0 12 12"><path d="M1.5 6.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square"/></symbol>
<symbol id="i-clock" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.25" stroke-dasharray="1.6 1.6"/><path d="M6 3.5V6l2 1" fill="none" stroke="currentColor" stroke-width="1.25"/></symbol>
<symbol id="i-warn" viewBox="0 0 12 12"><path d="M6 1.5L11 10.5H1z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="miter"/><path d="M6 5v2.5M6 9v.01" stroke="currentColor" stroke-width="1.25"/></symbol>
<symbol id="i-dash" viewBox="0 0 12 12"><path d="M2 6h8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 1.5"/></symbol>
</defs></svg>`;
const ic = (id, cls = 'ico') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

/* ---- tags: glyph + word + colour, always together --------------------------- */
const TAGS = {
  buy: ['Buy', 'g-buy', 'Buy: bought NAM on Osmosis'],
  sell: ['Sell', 'g-sell', 'Sell: sold NAM on Osmosis'],
  bridged: ['Bridged in', 'g-bridge', 'Bridged in (IBC transfer): NAM crossed from Namada to Osmosis'],
  shieldin: ['Shielded in', 'g-shield-in', 'Shielded in (shield): NAM moved from a public address into the shielded set'],
  shieldout: ['Shielded out', 'g-shield', 'Shielded out (unshield): NAM left the shielded set for a public address'],
  staked: ['Staked', 'g-stake', 'Staked (bond): locked with a validator, cannot be sold'],
  unstaking: ['Unstaking', 'g-unstake', 'Unstaking (unbond): starts the wait before NAM is spendable'],
  unlocked: ['Unlocked', 'g-unlock', 'Unlocked (withdraw): finished unstaking, can be bridged and sold'],
};
const tag = (k) => `<span class="tag" data-k="${k}" title="${esc(TAGS[k][2])}"><svg class="g" aria-hidden="true"><use href="#${TAGS[k][1]}"/></svg>${TAGS[k][0]}</span>`;
const chip = (t, title) => `<span class="kind"${title ? ` title="${esc(title)}"` : ''}>${t}</span>`;

/* ---- derived values -------------------------------------------------------- */
const priceNow = OV.price.usd.value, priceProv = OV.price.usd.prov;
const change24 = OV.price.change24h;
const S = OV.supply, TOT = S.total;
const parts = [
  { k: 'staked', label: 'Staked with validators', note: 'cannot be sold', v: S.bonded },
  { k: 'pgf', label: 'Public funding', note: 'held for the network', v: S.pgf },
  { k: 'shielded', label: 'Shielded', note: 'owners are hidden', v: S.shielded },
  { k: 'osmosis', label: 'On Osmosis', note: 'the one place it can be sold', v: S.ibcEscrow },
  { k: 'rest', label: 'Everything else spendable', note: 'public wallets', v: S.transparentLiquid },
];
const partSum = parts.reduce((a, b) => a + b.v, 0);
if (Math.abs(partSum - TOT) > 2) throw new Error(`supply parts (${partSum}) do not add up to total (${TOT})`);
const osmoPct = (S.ibcEscrow / TOT) * 100;
const shieldedPct = BS.sharePct;
const checks = OV.checks;
const checksOk = checks.filter((c) => c.status === 'ok').length;
const checkWarn = checks.find((c) => c.key === 'ibc_conservation');
const ibcDrift = checkWarn ? checkWarn.detail.driftNam : 0;
const supplyProv = S.prov;
const supplyOsmoProv = ibcDrift ? { ...S.osmosisProv, status: 'conflict', note: `escrow and Osmosis supply differ by ${nf(ibcDrift)} NAM` } : S.osmosisProv;
const holdersList = snap.holders.holders.slice(0, CONFIG.holdersLimit);
const holderProv = (h) => P('Namada indexer and nodes (balance, stake)', Math.min(h.verifiedAt, h.bondedVerifiedAt), null);
const holdersFreshest = holdersList.reduce((a, h) => Math.max(a, h.verifiedAt), 0);
const holdersTotalProv = P('Namada indexer (holder count)', holdersFreshest, null);
const flowProv = PR.coverage;
const curve = CV.curve;
const quoteProv = CV.prov;
const sell = (p) => ({ out: p.sellOutUsdc, imp: p.sellImpactPct, avg: p.sellEffectiveUsd });
const buy = (p) => ({ out: p.buyInUsdc, imp: p.buyImpactPct, avg: p.buyEffectiveUsd });
const pt = (n) => curve.find((p) => p.amountNam === n);
const pt5000 = pt(5000), pt10000 = pt(10000);
const poolsAll = snap.pools.pools;
const poolsProv = snap.pools.prov;

/* ---- replay report (static, dated) ------------------------------------------ */
const rr = readFileSync(join(HERE, '../../../replay-report.md'), 'utf8');
const rrGen = rr.match(/Generated (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) UTC/);
const rrEvents = rr.match(/\((\d+) events, (\d+) price points\)/);
const rrFlag = rr.match(/Price moves flagged ahead of time: (\d+) \/ (\d+)/);
const rrLead = rr.match(/Median lead ([\d.]+) h/);
const rrBase = rr.match(/Base rate:\*\* (\d+)%/);
const rrWindow = rr.match(/in the (\d+)h before/);
const rrWhale = rr.match(/withdraw ([\d,]+) →[^|]*\|[^|]*\|\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
const REPLAY = {
  genAt: Date.UTC(+rrGen[1], +rrGen[2] - 1, +rrGen[3], +rrGen[4], +rrGen[5]),
  events: +rrEvents[1], flagged: +rrFlag[1], of: +rrFlag[2], lead: +rrLead[1], base: +rrBase[1], window: +rrWindow[1],
  whaleNam: +rrWhale[1].replace(/,/g, ''),
  whaleAt: Date.UTC(+rrWhale[2], +rrWhale[3] - 1, +rrWhale[4], +rrWhale[5], +rrWhale[6]),
};

/* ---- plain copy tables -------------------------------------------------------- */
const RULE_PLAIN = {
  ibc_inventory: 'NAM bridged to Osmosis',
  unlock: 'NAM unstaked',
  big_swap: 'Large trade',
  unshield: 'NAM left the shielded set',
  bond: 'Large amount staked',
};
const CHECK_PLAIN = {
  ibc_conservation: (c) => ['NAM held for Osmosis matches NAM issued there', `Namada holds ${nf(c.detail.namadaIbcEscrow)} NAM, Osmosis counts ${nf(c.detail.osmosisSupply)}: ${nf(c.detail.driftNam)} NAM apart`],
  rpc_consensus: (c) => ['Two independent Namada nodes agree', `${c.detail.statuses.length} nodes at block ${nf(c.detail.statuses[0].height)}, ${nf(c.detail.heightDiff)} blocks apart`],
  supply_integrity: (c) => ['Locked and escrowed NAM never exceed what exists', `${c.detail.pctLocked} of NAM is locked or allocated`],
  indexer_lag: (c) => ['The Namada explorer keeps up with the chain', `${nf(c.detail.lagBlocks)} blocks behind`],
  supply_cross_source: (c) => ['Total supply is the same in two sources', `${nf(c.detail.diffNam)} NAM apart`],
  price_vs_execution: (c) => ['The quoted price is close to what trades paid', `${c.detail.deviationPct}% apart`],
  bonded_coverage: (c) => ['Per-address stakes add up to the chain’s total stake', `${c.detail.coveragePct} of staked NAM traced to addresses`],
};
const KIND_PLAIN = { genesis: 'Genesis', foundation: 'Foundation', backer: 'Backer' };
const kindOf = (h) => KIND_PLAIN[h.category] || 'Unlabelled';
const coinName = (sym) => {
  if (/^ibc\//.test(sym)) return `unnamed coin ${sym.slice(4, 10)}…`;
  if (/factory\//.test(sym)) return sym.split('/').pop();
  if (sym === 'UNKNOWN') return 'unknown coin';
  return sym;
};

/* ==========================================================================
   Shared chrome
   ========================================================================== */
const MARK = `<svg class="mark" viewBox="0 0 28 28" aria-hidden="true"><defs><clipPath id="mk-c"><rect x="4.5" y="3.5" width="19" height="21"/></clipPath></defs><g clip-path="url(#mk-c)"><path class="mk-hl" d="M1 5H11L27 23H17z"/><path d="M4 2.75L24 25.25" fill="none" stroke="currentColor" stroke-width="3"/></g><path d="M12 5H6V23H12M16 5H22V23H16" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="miter"/></svg>`;

const NAV = [
  { id: 'home', label: 'Home', href: 'home.html', icon: 'i-home' },
  { id: 'trade', label: 'Trade', href: 'trade.html', icon: 'i-trade' },
  { id: 'movers', label: 'Movers', href: '#movers', icon: 'i-movers' },
  { id: 'feed', label: 'Feed', href: 'holders.html', icon: 'i-feed' },
];
const MORE = [
  ['Shielded', 'How much NAM can’t be seen', '#shielded'],
  ['Alerts', 'What should wake me up', '#alerts'],
  ['Holders', 'Who holds NAM, a view of Feed', 'holders.html'],
  ['Rewind', 'See every number as it was on a past date', '#rewind'],
  ['Where every number comes from', `${checksOk} of ${checks.length} cross-checks pass`, 'home.html#trust'],
  ['Glossary', 'Staked, bridged, shielded: plain words first', '#glossary'],
  ['Settings', 'Alert rules, where alerts go, your data', '#settings'],
];

function header(active, theme) {
  const tabs = NAV.map((n) => `<a class="tn" href="${n.href}"${n.id === active ? ' aria-current="page"' : ''}>${n.label}</a>`).join('');
  const moreItems = MORE.map(([t, d, h]) => `<a class="mi" href="${h}"><span class="mi-t">${t}</span><span class="mi-d">${d}</span></a>`).join('');
  const chg = sgn(change24);
  return `<header class="hdr">
<div class="wrap hdr-in">
  <a class="brand" href="home.html" aria-label="namada.trade, home">${MARK}<span class="brand-t">namada<i>.trade</i></span></a>
  <nav class="topnav" aria-label="Primary">${tabs}<details class="more-d"><summary class="tn">More ${ic('i-arrow', 'caret')}</summary><div class="more-pop">${moreItems}</div></details></nav>
  <div class="hdr-r">
    <a class="px" data-s="${statusOf(priceProv)}" href="trade.html" data-prov="${esc(provText(priceProv, statusOf(priceProv)))}"><span class="px-l">NAM</span><span class="px-n">${price6(priceNow)}</span><span class="px-d">${chg}</span></a>
    <a class="chk" href="home.html#trust" title="Cross-checks that pass right now"><svg class="g" aria-hidden="true"><use href="#i-tick"/></svg>${checksOk} of ${checks.length} checks</a>
    <a class="ibtn" href="#search" aria-label="Search">${ic('i-search')}</a>
  </div>
</div>
</header>`;
}

function tabbar(active) {
  const tabs = NAV.map((n) => `<a class="tb" href="${n.href}"${n.id === active ? ' aria-current="page"' : ''}>${ic(n.icon)}<span>${n.label}</span></a>`).join('');
  const items = MORE.map(([t, d, h]) => `<a class="mi" href="${h}"><span class="mi-t">${t}</span><span class="mi-d">${d}</span></a>`).join('');
  return `<nav class="tabbar" aria-label="Primary">${tabs}<a class="tb" href="#more" aria-haspopup="dialog">${ic('i-more')}<span>More</span></a></nav>
<div id="more" class="sheet" role="dialog" aria-label="More">
  <a class="sheet-scrim" href="#" aria-label="Close"></a>
  <div class="sheet-body"><div class="sheet-h"><p class="sheet-t">More</p><a class="ibtn" href="#" aria-label="Close">${ic('i-x')}</a></div>${items}
  <p class="sheet-f">All times UTC. Snapshot taken ${dmy(CAP)}, ${hm(CAP)}.</p></div>
</div>`;
}

function footer() {
  return `<footer class="foot" id="footer"><div class="wrap">
  <div class="foot-key">
    <p class="foot-h">How to read the underlines</p>
    <ul class="key">
      <li>${N('1,819', P('x', CAP, 'live'), { cls: 'nokey', nofocus: true })}<span>solid: fresh</span></li>
      <li>${N('1,819', P('x', CAP - 3600e3, 'stale'), { cls: 'nokey', nofocus: true })}<span>dotted: old, with its age</span></li>
      <li>${N('1,819', P('x', CAP, 'conflict'), { cls: 'nokey', nofocus: true })}<span>wavy: sources disagree</span></li>
      <li>${N('—', null, { cls: 'nokey', nofocus: true })}<span>dashed: no data, reason shown</span></li>
    </ul>
    <p class="foot-s">Tap or focus any number to see its source and time.</p>
  </div>
  <div class="foot-copy">
    <p>Every number shows its source and age. Data: Osmosis router, Namada nodes, indexer.namada.net; records current as of ${ageOf(flowProv.at)} ago. Not investment advice. Not affiliated with Namada or the Anoma Foundation.</p>
    <p class="foot-l"><a href="home.html#trust">How we know</a><a href="#settings">Settings</a><a href="#api">API</a><a href="#source">Source code</a></p>
    <p class="foot-t">This page is a frozen frame: snapshot taken ${dmy(CAP)}, ${hm(CAP)} UTC. All times UTC.</p>
  </div>
</div></footer>`;
}

function page({ title, desc, active, body, theme = '', hash = '' }) {
  return `<!doctype html>
<html lang="en"${theme ? ` data-theme="${theme}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="color-scheme" content="light dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="tokens.css">
<style>
${CSS}
</style>
</head>
<body>
${SPRITE}
<a class="skip" href="#main">Skip to content</a>
${header(active, theme)}
<main id="main" data-page="${active}">
${body}
</main>
${footer()}
${tabbar(active)}
<script>
${JS}
</script>
</body>
</html>
`;
}

/* ==========================================================================
   Shared sections
   ========================================================================== */

/** The tape: latest real moves, as a slip of numbered receipts. */
function buildFlows() {
  const MIN = CONFIG.tapeMinNam;
  const rows = [];
  for (const m of PR.movers) {
    if (m.netNam24h && Math.abs(m.netNam24h) >= MIN) {
      rows.push({ k: m.netNam24h > 0 ? 'buy' : 'sell', amt: m.netNam24h, signed: true, ts: m.lastTs, who: short(m.address), detail: `net of ${WIN_H} h · ${m.buys} buys, ${m.sells} sells` });
    }
  }
  for (const u of BS.unshields) {
    if (u.amount >= MIN) rows.push({ k: 'shieldout', amt: u.amount, ts: u.ts, who: `to ${short(u.to)}` });
  }
  for (const o of PR.onDeck) {
    if (o.bridgedIn >= MIN) rows.push({ k: 'bridged', amt: o.bridgedIn, ts: o.firstArrival, who: `to ${short(o.address)}` });
  }
  for (const u of PR.unlocks) {
    if (u.amountNam >= MIN) {
      const k = u.kind === 'bond' ? 'staked' : u.kind === 'unbond' ? 'unstaking' : 'unlocked';
      const out = u.outcome && u.outcome.kind === 'rebonded' ? 'restaked, not a sale' : '';
      rows.push({ k, amt: u.amountNam, ts: u.ts, who: tidy(u.label) || short(u.address), detail: out });
    }
  }
  rows.sort((a, b) => b.ts - a.ts);
  return rows.slice(0, CONFIG.tapeRows);
}

function tape() {
  const rows = buildFlows();
  const li = rows.map((r, i) => {
    const amt = r.signed ? sgn(r.amt, 2, '') : nf(r.amt, 2);
    return `<li class="rc${i >= 6 ? ' rc-lg' : ''}" style="--i:${i}">
  <span class="rc-no">${d2(i + 1)}</span>
  <span class="rc-tag">${tag(r.k)}</span>
  <span class="rc-amt">${N(amt, flowProv)}${U('NAM')}</span>
  <span class="rc-age">${ageOf(r.ts)} ago</span>
  <span class="rc-who"><span class="a-i">${ageOf(r.ts)} ago · </span><span class="addr">${esc(r.who)}</span>${r.detail ? `<span class="rc-d"> · ${esc(r.detail)}</span>` : ''}</span>
</li>`;
  }).join('\n');
  return `<section class="slip tape" aria-labelledby="tape-h">
  <div class="slip-h"><h2 id="tape-h" class="slip-t">Latest receipts</h2><p class="slip-s">Moves of ${nf(CONFIG.tapeMinNam)} NAM or more, newest first</p></div>
  <ol class="rcpts">
${li}
  </ol>
  ${stub([flowProv])}
  <a class="slip-more" href="holders.html">All receipts in Feed ${ic('i-arrow', 'arr')}</a>
</section>`;
}

function whatChanged() {
  const hits = snap.alerts.hits;
  const rules = snap.rules;
  const probe = priceNow * CONFIG.homeAlertProbeNam;
  const dex = OV.dex, nm = OV.namada;
  const alertsProv = P('Alert rules over the flow index', snap.alerts.until, flowProv.status, flowProv.note);
  const empty = `<div class="empty">
    <p class="empty-t">${ic('i-tick', 'g')} Nothing crossed an alert size in the last ${WIN_H} hours.</p>
    <p class="empty-s">The window runs from ${dm(snap.alerts.since)}, ${hm(snap.alerts.since)} to ${dm(snap.alerts.until)}, ${hm(snap.alerts.until)} UTC. No alert has fired in the record we hold, so there is no earlier one to rewind to. An alert would list here, newest first:</p>
    <dl class="leaders rules">
${rules.map((r) => `      <div class="lr"><dt>${RULE_PLAIN[r.id]}</dt><dd><span class="dots"></span>${N(nf(r.thresholdNam), P('Alert rules', snap.alerts.until, 'live'))}${U('NAM')}</dd></div>`).join('\n')}
    </dl>
  </div>`;
  const list = hits.length ? `<ul class="hits">${hits.slice(0, 3).map((h) => `<li>${esc(h.title)}</li>`).join('')}</ul>` : empty;
  return `<section class="sec" id="changed" aria-labelledby="changed-h">
  <h2 id="changed-h">What changed in ${WIN_H} hours</h2>
  <p class="lead">Alert sizes are small on purpose: at today’s price ${nf(CONFIG.homeAlertProbeNam)} NAM is ${N(usd(probe), priceProv)}.</p>
  ${list}
  <h3 class="h3">The day’s tally</h3>
  <dl class="leaders tally">
    <div class="lr"><dt>${tag('buy')}<span class="cnt">${N(nf(dex.buys24h), dex.coverage)} buys on Osmosis</span></dt><dd><span class="dots"></span>${N(nf(dex.buyNam24h, 2), dex.coverage)}${U('NAM')}</dd></div>
    <div class="lr"><dt>${tag('sell')}<span class="cnt">${N(nf(dex.sells24h), dex.coverage)} sells on Osmosis</span></dt><dd><span class="dots"></span>${N(nf(dex.sellNam24h, 2), dex.coverage)}${U('NAM')}</dd></div>
    <div class="lr"><dt>${tag('staked')}</dt><dd><span class="dots"></span>${N(nf(nm.bonded24h), nm.coverage)}${U('NAM')}</dd></div>
    <div class="lr"><dt>${tag('unlocked')}</dt><dd><span class="dots"></span>${N(nf(nm.withdrawn24h), nm.coverage)}${U('NAM')}</dd></div>
    <div class="lr"><dt>${tag('shieldin')}</dt><dd><span class="dots"></span>${N(nf(nm.shielded24h), nm.coverage)}${U('NAM')}</dd></div>
    <div class="lr"><dt>${tag('shieldout')}</dt><dd><span class="dots"></span>${N(nf(nm.unshielded24h, 2), nm.coverage)}${U('NAM')}</dd></div>
  </dl>
  ${stub([dex.coverage, nm.coverage])}
  <p class="more-l"><a href="#alerts">The ${rules.length} alert rules ${ic('i-arrow', 'arr')}</a></p>
</section>`;
}

function whereIsNam() {
  const seg = parts.map((p, i) => {
    const w = (p.v / TOT) * 100;
    return `<span class="seg-s" data-k="${p.k}" style="--w:${w.toFixed(4)}%;--i:${i}"></span>`;
  }).join('');
  const rowsHtml = parts.map((p) => {
    const share = (p.v / TOT) * 100;
    const prov = p.k === 'osmosis' ? supplyOsmoProv : supplyProv;
    return `<li class="lg"><span class="sw" data-k="${p.k}"></span><b class="lg-l">${p.label}</b><span class="lg-p">${N(pct(share), prov)}</span><span class="lg-sub">${N(nf(p.v), prov)}${U('NAM')}<span class="lg-n"> · ${p.note}</span></span></li>`;
  }).join('\n');
  return `<section class="sec" id="where" aria-labelledby="where-h">
  <h2 id="where-h">Where is all the NAM?</h2>
  <p class="lead">Only ${N(pct(osmoPct), supplyOsmoProv)} of NAM, ${N(nf(S.ibcEscrow), supplyOsmoProv)} NAM, is on Osmosis, the one place it can be sold. The pools there hold ${N(usd(OV.dex.liquidityUsd, true), OV.dex.prov)}.</p>
  <div class="sbar" role="img" aria-label="${parts.map((p) => `${p.label} ${pct((p.v / TOT) * 100)}`).join(', ')}">${seg}</div>
  <ul class="legend">
${rowsHtml}
    <li class="lg lg-tot"><span class="sw sw-none"></span><b class="lg-l">All NAM</b><span class="lg-p">${N('100%', supplyProv)}</span><span class="lg-sub">${N(nf(TOT), supplyProv, { cls: 'tot' })}${U('NAM')}<span class="lg-n"> · minted so far</span></span></li>
  </ul>
  <p class="note" data-tone="warn">${ic('i-warn', 'g')}<span>Namada holds ${N(nf(checkWarn.detail.namadaIbcEscrow), supplyProv)} NAM in escrow for Osmosis, while Osmosis counts ${N(nf(checkWarn.detail.osmosisSupply), supplyOsmoProv)}. They are ${N(nf(ibcDrift), supplyOsmoProv)} NAM apart, so the Osmosis figure carries a wavy underline.</span></p>
  ${stub([supplyProv, S.osmosisProv])}
</section>`;
}

/** Holders as a role=table made of divs: columns from 640 px, two-line rows below. */
function holderRow(h, i) {
  const name = tidy(h.label);
  const prov = holderProv(h);
  const stakedConflict = h.bondedEstimated != null && Math.abs(h.bonded - h.bondedEstimated) > 1;
  const stakedProv = P('Namada nodes (stake check)', h.bondedVerifiedAt, stakedConflict ? 'conflict' : 'live', stakedConflict ? `chain check ${nf(h.bonded)}, estimate ${nf(h.bondedEstimated)}: ${nf(Math.abs(h.bonded - h.bondedEstimated))} NAM apart` : null);
  const spend = P('Namada indexer (balance)', h.verifiedAt, null);
  const d7 = h.change7d === 0 ? '<span class="flat">no change</span>' : N(sgn(h.change7d, 0, ' NAM'), prov);
  const linked = h.linked && h.linked.length ? `<span class="lk" title="${esc(h.linked.join(', '))}">+${h.linked.length} linked on Osmosis</span>` : '';
  const top = snap.holders.holders[0].pctSupply;
  return `<div class="hr" role="row" data-cat="${h.category || 'none'}" data-total="${h.total}" style="--i:${i};--sf:${(h.pctSupply / top).toFixed(4)}">
  <span class="c-rank" role="cell">${d2(h.rank)}</span>
  <span class="c-who" role="cell"><b class="nm">${name ? esc(name) : 'Unlabelled address'}</b><span class="addr" title="${esc(h.address)}">${short(h.address)}</span>${linked}</span>
  <span class="c-total" role="cell">${N(nf(h.total), prov)}${U('NAM')}</span>
  <span class="c-pct" role="cell">${N(pct(h.pctSupply, 2), prov)}<i class="bar"></i></span>
  <span class="c-meta">
    <span class="c-kind" role="cell">${chip(kindOf(h))}</span>
    <span class="c-spend" role="cell">${N(nf(h.balance), spend)}${U('NAM')}</span>
    <span class="c-stake" role="cell">${h.bonded > 0 ? N(nf(h.bonded), stakedProv) + U('NAM') : '<span class="nil">none</span>'}</span>
    <span class="c-d7" role="cell">${d7}</span>
    <span class="c-chk" role="cell">checked ${ageOf(Math.min(h.verifiedAt, h.bondedVerifiedAt))} ago</span>
  </span>
</div>`;
}

function holdersList_(o = {}) {
  const rows = holdersList.map((h, i) => holderRow(h, i)).join('\n');
  return `<div class="dl holders${o.cls ? ' ' + o.cls : ''}" role="table" aria-label="Biggest NAM holders on Namada">
  <div class="dl-head" role="row"><span role="columnheader" class="c-rank">Rank</span><span role="columnheader" class="c-who">Holder</span><span role="columnheader" class="c-total">Total</span><span role="columnheader" class="c-pct">Share</span><span role="columnheader" class="c-kind">What</span><span role="columnheader" class="c-spend">Spendable</span><span role="columnheader" class="c-stake">Staked</span><span role="columnheader" class="c-d7">${CONFIG.changeDays} days</span><span role="columnheader" class="c-chk">Checked</span></div>
${rows}
</div>`;
}

function whoHolds() {
  const top10 = OV.concentration.namadaTop10Pct;
  return `<section class="sec" id="holders" aria-labelledby="holders-h">
  <h2 id="holders-h">Who holds NAM</h2>
  <p class="lead">The 10 biggest holders own ${N(pct(top10), holdersTotalProv)} of NAM on Namada. Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone.</p>
  ${holdersList_({ cls: 'dl--home' })}
  ${stub([P('Namada indexer and nodes (balance, stake)', Math.min(...holdersList.map((h) => h.verifiedAt)), null)], { extra: `stake checks as recent as ${ageOf(Math.max(...holdersList.map((h) => h.bondedVerifiedAt)))} ago` })}
  <p class="more-l"><a href="holders.html">All ${N(nf(snap.holders.total), holdersTotalProv)} holders ${ic('i-arrow', 'arr')}</a></p>
</section>`;
}

/* ---- explainer: drag an order size, see the price move against pool depth --- */
const XMIN = curve[0].amountNam, XMAX = curve[curve.length - 1].amountNam;
const xPos = (n) => (Math.log(n) - Math.log(XMIN)) / (Math.log(XMAX) - Math.log(XMIN));
const kfmt = (n) => (n >= 1000 ? `${n / 1000}k` : String(n));

function curvePlot() {
  const yMax = 5 * Math.ceil(Math.max(...curve.map((p) => Math.max(p.buyImpactPct, p.sellImpactPct))) / 5);
  const yTicks = []; for (let t = 0; t <= yMax; t += 10) yTicks.push(t);
  const X = (n) => xPos(n) * 100, Y = (v) => 100 - (v / yMax) * 100;
  const line = (f) => curve.map((p) => `${X(p.amountNam).toFixed(2)},${Y(f(p)).toFixed(2)}`).join(' ');
  const grid = yTicks.map((t) => `<line x1="0" x2="100" y1="${Y(t)}" y2="${Y(t)}" class="gl"/>`).join('');
  const dots = curve.map((p) => `<i class="pd pd-sell" style="left:${X(p.amountNam).toFixed(2)}%;top:${Y(p.sellImpactPct).toFixed(2)}%" title="${nf(p.amountNam)} NAM: ${pct(p.sellImpactPct, 2)} when selling"></i><i class="pd pd-buy" style="left:${X(p.amountNam).toFixed(2)}%;top:${Y(p.buyImpactPct).toFixed(2)}%" title="${nf(p.amountNam)} NAM: ${pct(p.buyImpactPct, 2)} when buying"></i>`).join('');
  const yl = yTicks.map((t) => `<span style="top:${Y(t)}%">${t}%</span>`).join('');
  const xl = curve.map((p, i) => `<span class="${i === 0 ? 'first' : i === curve.length - 1 ? 'last' : ''}" style="left:${X(p.amountNam).toFixed(2)}%">${kfmt(p.amountNam)}</span>`).join('');
  return `<div class="plot plot--curve" data-ymax="${yMax}">
    <div class="plot-y" aria-hidden="true">${yl}</div>
    <div class="plot-area">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${grid}<polyline class="ln ln-buy" points="${line((p) => p.buyImpactPct)}"/><polyline class="ln ln-sell" points="${line((p) => p.sellImpactPct)}"/></svg>
      ${dots}
      <i class="cursor" data-cursor><b class="cur-dot" data-cursor-dot></b></i>
    </div>
    <div class="plot-x" aria-hidden="true">${xl}</div>
  </div>`;
}

const sliderValue = (n) => Math.round(xPos(n) * 1000);
const curveDataTag = () => `<script type="application/json" id="curve-data">${JSON.stringify({ points: curve.map((p) => ({ n: p.amountNam, worth: p.usdSize, so: p.sellOutUsdc, si: p.sellImpactPct, sa: p.sellEffectiveUsd, bo: p.buyInUsdc, bi: p.buyImpactPct, ba: p.buyEffectiveUsd })), spot: CV.spotUsd, at: quoteProv.at })}</script>`;

function explainer() {
  const p = pt10000, s = sell(p);
  return `<div class="drag" data-explainer>
  <h3 class="h3">Drag an order size</h3>
  <p class="drag-s">Sell NAM on Osmosis and watch the price move against the pools. Everything on this chart is a quote from the pools at ${hm(quoteProv.at)}.</p>
  ${curvePlot()}
  <label class="rl" for="size-r"><span>Order size</span><output class="rl-o" data-o="size">${nf(p.amountNam)} NAM</output></label>
  <div class="rwrap"><input id="size-r" class="range" type="range" min="0" max="1000" step="1" value="${sliderValue(p.amountNam)}" data-range aria-describedby="drag-note">
    <div class="rticks" aria-hidden="true">${curve.map((q) => `<i style="left:${(xPos(q.amountNam) * 100).toFixed(2)}%"></i>`).join('')}</div></div>
  <dl class="readout">
    <div><dt>Worth</dt><dd data-o="worth">${N(usd(p.usdSize), quoteProv)}</dd></div>
    <div><dt>You get</dt><dd data-o="get">${N(nf(s.out, 2), quoteProv)}${U('USDC')}</dd></div>
    <div class="em"><dt>Price moves</dt><dd data-o="move">${N(sgn(-s.imp), quoteProv)}</dd></div>
  </dl>
  <p class="how" id="drag-note" data-o="how"><span class="est" data-est hidden>Estimate</span><span data-o="how-t">This is a real quote: the pools were asked about ${nf(p.amountNam)} NAM.</span></p>
  <p class="fine">The dots are the ${curve.length} sizes the pools were asked about (${nf(XMIN)} to ${nf(XMAX)} NAM). Between two dots the page draws a straight line between the two real quotes, so treat it as an estimate. Outside the dots it shows nothing. The scale is logarithmic, so equal steps are equal multiples. <span class="key-l"><i class="ln-k ln-k-sell"></i>selling <i class="ln-k ln-k-buy"></i>buying</span></p>
  ${stub([quoteProv])}
</div>`;
}

function reach() {
  return `<section class="sec" id="reach" aria-labelledby="reach-h">
  <h2 id="reach-h">How NAM gets from a wallet to a sale</h2>
  <ol class="path">
    <li><span class="pn">1</span><div class="pb"><h3>Staked</h3><p>Most NAM is staked with validators. Staked NAM can’t be sold.</p></div><p class="pv">${N(nf(S.bonded), supplyProv)}${U('NAM')}</p></li>
    <li><span class="pn">2</span><div class="pb"><h3>Unlocked</h3><p>Asking to unstake starts a wait of about ${N(nf(PR.unbondingDays, 2), P('Chain parameter', PR.asOf, 'live'))} days.</p></div><p class="pv">${N(nf(PR.unbondingDays, 2), P('Chain parameter', PR.asOf, 'live'))}${U('days')}</p></li>
    <li><span class="pn">3</span><div class="pb"><h3>Bridged</h3><p>To be sold, NAM crosses to Osmosis. Crossings usually come before sales.</p></div><p class="pv">${N(nf(PR.ibcIn7d, 0), flowProv)}${U(`NAM in ${PR.windowDays} days`)}</p></li>
    <li><span class="pn">4</span><div class="pb"><h3>Sold</h3><p>On Osmosis, NAM trades in small pools. An order of ${nf(pt10000.amountNam)} NAM moves the price ${N(pct(pt10000.sellImpactPct, 2), quoteProv)}.</p></div><p class="pv">${N(usd(OV.dex.liquidityUsd, true), OV.dex.prov)}${U('in all pools')}</p></li>
  </ol>
  <p class="side"><b>Shielded NAM</b> sits in a pool whose total is public and whose owners are not: ${N(pct(shieldedPct), BS.shielded.prov)} of all NAM.</p>
  ${explainer()}
</section>`;
}

function miniTicket() {
  const p = pt5000, s = sell(p);
  const q = snap.quote5000;
  const noQuote = !q.quote;
  return `<section class="sec" id="quote" aria-labelledby="quote-h">
  <h2 id="quote-h">What would you get right now?</h2>
  <div class="slip ticket-mini">
    <div class="slip-h"><p class="slip-t">Quote, as a snapshot</p><p class="slip-s">Static: taken ${dmy(CAP)}, ${hm(CAP)} UTC</p></div>
    <dl class="leaders">
      <div class="lr"><dt>Amount</dt><dd><span class="dots"></span><span class="v">${nf(p.amountNam)}</span>${U('NAM')}</dd></div>
      <div class="lr"><dt>You get</dt><dd><span class="dots"></span>${noQuote ? `${N('—', null)}${U('no live quote')}` : N(nf(s.out, 2), quoteProv) + U('USDC')}</dd></div>
      <div class="lr"><dt>Price move</dt><dd><span class="dots"></span>${noQuote ? N('—', null) + U('no live quote') : N(sgn(-s.imp), quoteProv)}</dd></div>
    </dl>
    ${noQuote ? `<p class="note" data-tone="warn">${ic('i-warn', 'g')}<span><b>No live quote.</b> The Osmosis quote service is not answering. Last quoted price: ${N(price6(priceNow), priceProv)}, ${agoP(priceProv.at)}.</span></p>
    <p class="fallback">The size ladder, asked at ${hm(quoteProv.at)}, has this size: sell ${nf(p.amountNam)} NAM, get ${N(nf(s.out, 2), quoteProv)} USDC, price moves ${N(sgn(-s.imp), quoteProv)}.</p>` : ''}
    ${stub([quoteProv])}
    <a class="btn btn-primary" href="trade.html">Full quote ${ic('i-arrow', 'arr')}</a>
  </div>
</section>`;
}

function trust() {
  const rows = checks.map((c, i) => {
    const [t, d] = CHECK_PLAIN[c.key](c);
    const ok = c.status === 'ok';
    return `<li class="ck" data-ok="${ok}" style="--i:${i}"><svg class="g" aria-hidden="true"><use href="#${ok ? 'i-tick' : 'i-warn'}"/></svg><span class="ck-t">${esc(t)}</span><span class="ck-d">${esc(d)}</span><span class="ck-s">${ok ? 'passes' : 'needs a look'}</span></li>`;
  }).join('\n');
  const need = checks.length - checksOk;
  return `<section class="sec" id="trust" aria-labelledby="trust-h">
  <h2 id="trust-h">Why you can trust these numbers</h2>
  <ol class="why">
    <li><h3>Every number shows its source and age.</h3><p>Tap one to see them. The underline says how fresh it is: solid, dotted, wavy or dashed. The key is in the footer.</p></li>
    <li><h3>${N(String(checksOk), P('Cross-checks', checks[0].checkedAt, 'live'))} of ${N(String(checks.length), P('Cross-checks', checks[0].checkedAt, 'live'))} cross-checks pass right now${need ? `, ${need} need a look` : ''}.</h3>
      <ul class="checks">
${rows}
      </ul>
      ${stub([P('Cross-checks', checks[0].checkedAt, 'live')])}
    </li>
    <li><h3>Rewind: see the site as it was.</h3><p>Try ${dm(REPLAY.whaleAt)} ${new Date(REPLAY.whaleAt).getUTCFullYear()}, ${hm(REPLAY.whaleAt)} UTC, the first alert before ${Math.round(REPLAY.whaleNam / 1e6)} million NAM were withdrawn from staking.</p><p class="lnk"><a href="movers.html?at=${REPLAY.whaleAt}">Rewind to that time ${ic('i-arrow', 'arr')}</a></p></li>
    <li class="static"><h3>Tested on ${REPLAY.events} past events.</h3><p>Report of ${dmy(REPLAY.genAt)}, ${hm(REPLAY.genAt)} UTC: ${REPLAY.flagged === REPLAY.of ? `each of the ${REPLAY.of}` : `${REPLAY.flagged} of the ${REPLAY.of}`} biggest price moves had an alert-size flow in the prior ${REPLAY.window} hours, a median of ${nf(REPLAY.lead, 0)} hours ahead. But such flows precede ${REPLAY.base}% of all hours, so this shows the alerts are not blind, not that they predict direction.</p>
      <p class="stub" data-s="old"><svg class="g" aria-hidden="true"><use href="#i-clock"/></svg><span class="stub-k">Static</span><span class="stub-t">Dated record, not live · generated ${dmy(REPLAY.genAt)}, ${hm(REPLAY.genAt)} UTC</span></p></li>
  </ol>
</section>`;
}

/* ==========================================================================
   Pages
   ========================================================================== */
function homePage(theme) {
  const chg = sgn(change24);
  const body = `
<section class="hero wrap" aria-labelledby="h1">
  <div class="hero-main">
    <p class="eyebrow">Namada Trade · NAM on Osmosis</p>
    <h1 id="h1">NAM,<br><span class="hl">with receipts.</span></h1>
    <p class="sub">The price of NAM, the coin of the Namada network, who holds it, who might sell it and how much is shielded. Every figure is stamped with its source and how old it is.</p>
    <div class="price-blk">
      <p class="lbl">NAM price, in US dollars</p>
      <p class="price">${N(price6(priceNow), priceProv, { cls: 'big' })}</p>
      <p class="pmeta"><b class="chg">${chg}</b><span> since this time yesterday</span><span class="stamp"><svg class="g" aria-hidden="true"><use href="#i-tick"/></svg>Osmosis quotes · ${ageOf(priceProv.at)} old</span></p>
    </div>
    <div class="actions"><a class="btn btn-primary" href="trade.html">See what a trade costs ${ic('i-arrow', 'arr')}</a><a class="btn" href="#trust">How we know</a></div>
    <dl class="facts">
      <div><dt>holders on Namada</dt><dd>${N(nf(OV.namada.holders), holdersTotalProv)}</dd></div>
      <div><dt>shielded</dt><dd>${N(pct(shieldedPct), BS.shielded.prov)}</dd></div>
      <div><dt>on Osmosis</dt><dd>${N(pct(osmoPct), supplyOsmoProv)}</dd></div>
    </dl>
  </div>
  <div class="hero-tape">${tape()}</div>
</section>
<div class="wrap body-grid">
  <div class="narr">
    ${whatChanged()}
    ${whereIsNam()}
    ${whoHolds()}
    ${reach()}
    ${miniTicket()}
  </div>
  <aside class="rail" aria-label="Right now">
    <div class="rail-in">
      <h2 class="rail-t">Right now</h2>
      <dl class="rn">
        <div><dt>NAM price</dt><dd>${N(price6(priceNow), priceProv)}</dd></div>
        <div><dt>Depth of all ${nf(OV.dex.pools)} pools</dt><dd>${N(usd(OV.dex.liquidityUsd, true), OV.dex.prov)}</dd></div>
        <div><dt>NAM on Osmosis</dt><dd>${N(nf(S.ibcEscrow), supplyOsmoProv)}${U('NAM')}</dd></div>
        <div><dt>Unstaking takes</dt><dd>${N(nf(PR.unbondingDays, 2), P('Chain parameter', PR.asOf, 'live'))}${U('days')}</dd></div>
      </dl>
      ${stub([priceProv, OV.dex.prov])}
    </div>
  </aside>
</div>
<div class="wrap">${trust()}</div>
${curveDataTag()}`;
  return page({ title: 'namada.trade — NAM, with receipts.', desc: 'The price of NAM, who holds it, who might sell it and how much is shielded. Every figure shows its source and age.', active: 'home', body, theme });
}

/* ---- Trade ----------------------------------------------------------------- */
function priceChart() {
  const ex = snap.executedHistory30d, qh = snap.priceHistory7d;
  const t0 = ex[0].ts, t1 = CAP;
  const quotePts = [...qh, { ts: priceProv.at, value: priceNow }];
  const allV = [...ex.map((p) => p.value), ...quotePts.map((p) => p.value)];
  const lo = Math.min(...allV), hi = Math.max(...allV);
  const step = 2e-4;
  const yMin = Math.floor(lo / step) * step, yMax = Math.ceil(hi / step) * step;
  const Xp = (t) => ((t - t0) / (t1 - t0)) * 100, Yp = (v) => 100 - ((v - yMin) / (yMax - yMin)) * 100;
  const ticks = []; for (let v = yMin; v <= yMax + 1e-12; v += step) ticks.push(+v.toFixed(6));
  const grid = ticks.map((v) => `<line x1="0" x2="100" y1="${Yp(v).toFixed(2)}" y2="${Yp(v).toFixed(2)}" class="gl"/>`).join('');
  const yl = ticks.map((v) => `<span style="top:${Yp(v).toFixed(2)}%">${v.toFixed(4)}</span>`).join('');
  // Mondays in range
  const xt = []; const dd = new Date(t0); dd.setUTCHours(0, 0, 0, 0);
  for (let t = dd.getTime(); t <= t1; t += 86400000) { if (new Date(t).getUTCDay() === 1 && t > t0) xt.push(t); }
  const xl = xt.map((t) => `<span style="left:${Xp(t).toFixed(2)}%">${dm(t)}</span>`).join('');
  const exLine = ex.map((p) => `${Xp(p.ts).toFixed(2)},${Yp(p.value).toFixed(2)}`).join(' ');
  const qLine = quotePts.map((p) => `${Xp(p.ts).toFixed(2)},${Yp(p.value).toFixed(2)}`).join(' ');
  const dots = ex.map((p) => `<i class="pd pd-ex" style="left:${Xp(p.ts).toFixed(2)}%;top:${Yp(p.value).toFixed(2)}%" title="${dm(p.ts)} ${hm(p.ts)}: ${price6(p.value)}"></i>`).join('')
    + quotePts.slice(0, -1).map((p) => `<i class="pd pd-q" style="left:${Xp(p.ts).toFixed(2)}%;top:${Yp(p.value).toFixed(2)}%" title="${dm(p.ts)} ${hm(p.ts)}: ${price6(p.value)} quoted"></i>`).join('');
  const first = ex[0], last = ex[ex.length - 1];
  const change = (last.value / first.value - 1) * 100;
  const hours = Math.round((last.ts - first.ts) / 3600e3);
  const exProv = OV.price.swap1h.prov;
  const minP = ex.reduce((a, b) => (b.value < a.value ? b : a)), maxP = ex.reduce((a, b) => (b.value > a.value ? b : a));
  const title = `Trades paid ${pct(Math.abs(change), 0)} ${change >= 0 ? 'more' : 'less'} per NAM than ${nf((last.ts - first.ts) / 86400e3, 0)} days ago`;
  return `<figure class="chart">
  <figcaption><h3 class="ch-t">${title}</h3><p class="ch-s">US dollars per NAM. Only ${N(nf(ex.length), exProv)} of the last ${nf(hours)} hours had a trade, so each dot is one hour that did.</p></figcaption>
  <div class="plot plot--time" role="img" aria-label="Price of NAM over the last ${nf((last.ts - first.ts) / 86400e3, 0)} days. First ${price6(first.value)}, low ${price6(minP.value)}, high ${price6(maxP.value)}, last ${price6(last.value)}.">
    <div class="plot-y" aria-hidden="true">${yl}</div>
    <div class="plot-area">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${grid}<polyline class="ln ln-ex" points="${exLine}"/><polyline class="ln ln-q" points="${qLine}"/></svg>
      ${dots}
      <span class="pill" style="top:${Yp(priceNow).toFixed(2)}%">${price6(priceNow)}</span>
    </div>
    <div class="plot-x" aria-hidden="true">${xl}</div>
  </div>
  <dl class="cstats">
    <div><dt>Low, ${dm(minP.ts)}</dt><dd>${N(price6(minP.value), exProv)}</dd></div>
    <div><dt>High, ${dm(maxP.ts)}</dt><dd>${N(price6(maxP.value), exProv)}</dd></div>
    <div><dt>Last, ${ageOf(last.ts)} ago</dt><dd>${N(price6(last.value), exProv)}</dd></div>
    <div><dt>Quoted now</dt><dd>${N(price6(priceNow), priceProv)}</dd></div>
  </dl>
  <p class="keyrow"><span><i class="k k-ex"></i>Paid in trades, hourly median</span><span><i class="k k-q"></i>Quoted price</span></p>
  <dl class="sr-only"><dt>First</dt><dd>${price6(first.value)}</dd><dt>Lowest</dt><dd>${price6(minP.value)}</dd><dt>Highest</dt><dd>${price6(maxP.value)}</dd><dt>Last</dt><dd>${price6(last.value)}</dd></dl>
  <p class="stub" data-s="${worst(statusOf(priceProv), statusOf(exProv))}"><svg class="g" aria-hidden="true"><use href="#${worst(statusOf(priceProv), statusOf(exProv)) === 'fresh' ? 'i-tick' : 'i-clock'}"/></svg><span class="stub-k">Source</span><span class="stub-t">Osmosis quotes, ${CONFIG.quoteCadence} · Osmosis trades, hourly median · as of ${hm(priceProv.at)} UTC <i>/</i> last traded hour ${hm(exProv.at)}, ${ageOf(exProv.at)} old<span class="stub-s">${STATUS_WORD[worst(statusOf(priceProv), statusOf(exProv))]}</span></span></p>
  <p class="short"><svg class="g" aria-hidden="true"><use href="#i-clock"/></svg>Short history: quoted prices recorded since ${dm(qh[0].ts)} ${new Date(qh[0].ts).getUTCFullYear()}, ${qh.length} points so far. Trades go back ${nf((last.ts - first.ts) / 86400e3, 0)} days.</p>
</figure>`;
}

function ladder() {
  const rows = curve.map((p, i) => `<div class="dl-row lad" role="row" tabindex="0" data-amt="${p.amountNam}" style="--i:${i}">
  <span class="l-size" role="cell">${nf(p.amountNam)}${U('NAM')}</span>
  <span class="l-worth" role="cell">${N(usd(p.usdSize), quoteProv)}</span>
  <span class="l-get s-sell" role="cell"><em>You get</em>${N(nf(p.sellOutUsdc, 2), quoteProv)}${U('USDC')}</span>
  <span class="l-mv s-sell" role="cell"><em>Price move</em>${N(sgn(-p.sellImpactPct), quoteProv)}</span>
  <span class="l-get s-buy" role="cell"><em>You pay</em>${N(nf(p.buyInUsdc, 2), quoteProv)}${U('USDC')}</span>
  <span class="l-mv s-buy" role="cell"><em>Price move</em>${N(sgn(p.buyImpactPct), quoteProv)}</span>
</div>`).join('\n');
  return `<section class="sec" id="ladder" aria-labelledby="ladder-h">
  <h2 id="ladder-h">How size moves the price</h2>
  <p class="lead">Tap a size to quote it. Each row is a real question put to the pools at ${hm(quoteProv.at)}.</p>
  <div class="dl ladder" role="table" aria-label="Size ladder" data-ladder>
    <div class="dl-head" role="row"><span role="columnheader">Order size</span><span role="columnheader">Worth</span><span role="columnheader" class="s-sell">Selling: you get</span><span role="columnheader" class="s-sell">Selling: price move</span><span role="columnheader" class="s-buy">Buying: you pay</span><span role="columnheader" class="s-buy">Buying: price move</span></div>
${rows}
  </div>
  <p class="fine">The quote service also reports the largest order that keeps the price move within 1%: ${N(nf(CV.maxSafeClip1PctNam), quoteProv)} NAM, and within 3%: ${N(nf(CV.maxSafeClip3PctNam), quoteProv)} NAM. These follow the buying column, where moves are larger.</p>
  ${stub([quoteProv])}
</section>`;
}

function poolsSection() {
  const top = poolsAll.slice(0, 6), rest = poolsAll.slice(6);
  const row = (p, i) => `<div class="dl-row pl" role="row" style="--i:${i}">
  <span class="p-pair" role="cell"><b>NAM / ${esc(coinName(p.counterSymbol))}</b></span>
  <span class="p-type" role="cell">${esc(p.type)}${p.id ? ` <span class="pid">#${esc(p.id)}</span>` : ''}</span>
  <span class="p-liq" role="cell">${N(usd(p.liquidityUsd, true), poolsProv)}</span>
  <span class="p-nam" role="cell">${N(nf(p.namReserve), poolsProv)}${U('NAM')}</span>
  <span class="p-fee" role="cell">${N(nf(p.spreadFactor * 100, 2) + '%', poolsProv)}${U('fee')}</span>
</div>`;
  const restLiq = rest.reduce((a, p) => a + p.liquidityUsd, 0);
  return `<section class="sec" id="pools" aria-labelledby="pools-h">
  <h2 id="pools-h">Where NAM trades</h2>
  <p class="lead">${nf(poolsAll.length)} pools hold NAM. A pool is a shared pot of NAM and another coin that anyone trades against.</p>
  <div class="dl pools" role="table" aria-label="Pools">
    <div class="dl-head" role="row"><span role="columnheader">Pool</span><span role="columnheader">Kind</span><span role="columnheader">Holds</span><span role="columnheader">NAM inside</span><span role="columnheader">Fee</span></div>
${top.map(row).join('\n')}
    <details class="more-pools"><summary><span>${nf(rest.length)} more pools, ${N(usd(restLiq, true), poolsProv)} together</span>${ic('i-arrow', 'arr')}</summary>
${rest.map((p, i) => row(p, i)).join('\n')}
    </details>
  </div>
  ${stub([poolsProv])}
</section>`;
}

function tradePage() {
  const p0 = pt5000, s0 = sell(p0);
  const depth = OV.dex.liquidityUsd;
  const ref = CV.refPoolLiquidityUsd;
  const p25 = pt(25000);
  const body = `
<div class="wrap trade-grid">
  <div class="tk-col">
    <header class="pg-h">
      <h1 class="h1-in" id="h1" data-h1><span data-h1-t>What would I get if I sold NAM now?</span></h1>
      <p class="sub">An Osmosis quote, not an order. This site never trades for you.</p>
    </header>
    <section class="ticket" aria-label="Your quote" data-ticket data-side="sell">
      <div class="seg" role="group" aria-label="Side">
        <button type="button" class="seg-b" data-side-b="sell" aria-pressed="true">Sell NAM</button>
        <button type="button" class="seg-b" data-side-b="buy" aria-pressed="false">Buy NAM</button>
      </div>
      <div class="field">
        <label for="amt">Amount, in NAM</label>
        <div class="field-in"><input id="amt" class="inp" inputmode="numeric" autocomplete="off" value="${nf(p0.amountNam)}" data-amt><span class="field-u">NAM</span></div>
        <p class="field-h">Worth about <span data-o="worth">${N(usd(p0.usdSize), quoteProv)}</span> at the quoted price</p>
      </div>
      <div class="chips" role="group" aria-label="Quoted sizes">${curve.map((p) => `<button type="button" class="chip${p.amountNam === p0.amountNam ? ' on' : ''}" data-preset="${p.amountNam}" aria-pressed="${p.amountNam === p0.amountNam}">${nf(p.amountNam)}</button>`).join('')}</div>
      <div class="rwrap"><input class="range" type="range" min="0" max="1000" step="1" value="${sliderValue(p0.amountNam)}" data-range aria-label="Order size in NAM">
        <div class="rticks" aria-hidden="true">${curve.map((q) => `<i style="left:${(xPos(q.amountNam) * 100).toFixed(2)}%"></i>`).join('')}</div></div>

      <div class="get" aria-live="polite">
        <p class="get-l" data-o="get-l">You get</p>
        <p class="get-n" data-o="get-n">${N(nf(s0.out, 2), quoteProv, { cls: 'hero-n' })}${U('USDC')}</p>
        <dl class="get-m">
          <div class="em"><dt>Price move</dt><dd data-o="move">${N(sgn(-s0.imp), quoteProv)}</dd></div>
          <div><dt>Your average price</dt><dd data-o="avg">${N(price6(s0.avg), quoteProv)}</dd></div>
          <div><dt>Quoted price</dt><dd>${N(price6(CV.spotUsd), quoteProv)}</dd></div>
        </dl>
        <p class="how" data-o="how"><span class="est" data-est hidden>Estimate</span><span data-o="how-t">A real quote: the pools were asked about ${nf(p0.amountNam)} NAM.</span></p>
        <p class="oor" data-oor hidden>Quotes run from ${nf(XMIN)} to ${nf(XMAX)} NAM. Outside that range this page shows no number rather than guess one.</p>
        ${stub([quoteProv])}
      </div>

      <p class="note" data-tone="warn" id="thin">${ic('i-warn', 'g')}<span><b>Thin market.</b> All ${nf(OV.dex.pools)} pools together hold ${N(usd(depth, true), OV.dex.prov)}, and the biggest holds ${N(usd(ref, true), quoteProv)}. Selling ${nf(p25.amountNam)} NAM, worth ${N(usd(p25.usdSize), quoteProv)}, moves the price ${N(pct(p25.sellImpactPct, 2), quoteProv)}.</span></p>
      <p class="note" data-tone="info">${ic('i-dash', 'g')}<span><b>No exact live quote.</b> The Osmosis quote service refused our request for a one-off quote, so these numbers come from the size ladder below, asked at ${hm(quoteProv.at)} UTC.</span></p>
    </section>
  </div>
  <div class="ch-col">
    ${priceChart()}
  </div>
</div>
<div class="wrap lower">
  ${ladder()}
  ${poolsSection()}
</div>
${curveDataTag()}`;
  return page({ title: 'Trade — What would I get if I sold NAM now? · namada.trade', desc: 'A quote from Osmosis, not an order: what selling or buying NAM would cost at each size, with the source and age of every number.', active: 'trade', body });
}

/* ---- Holders (Feed, Holders tab) ---------------------------------------------- */
function holdersPage() {
  const cats = {};
  for (const h of holdersList) { const k = h.category || 'none'; cats[k] = (cats[k] || 0) + 1; }
  const catChips = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<button type="button" class="chip" data-f="${k}" aria-pressed="false">${k === 'none' ? 'Unlabelled' : KIND_PLAIN[k]} <span class="cn">${n}</span></button>`).join('');
  const sizeChips = CONFIG.holderSizeSteps.map((v) => `<button type="button" class="chip" data-sz="${v}" aria-pressed="false">${nf(v / 1e6)}M or more <span class="cn">${holdersList.filter((h) => h.total >= v).length}</span></button>`).join('');
  const top10 = OV.concentration.namadaTop10Pct;
  const body = `
<div class="wrap">
  <header class="pg-h pg-h--feed">
    <nav class="tabs" aria-label="Feed views"><a class="tab" href="#tx">Transactions</a><a class="tab" href="holders.html" aria-current="page">Holders</a></nav>
    <h1 class="h1-in" id="h1">Who holds NAM?</h1>
    <p class="sub">The 10 biggest holders own ${N(pct(top10), holdersTotalProv)} of NAM on Namada. Protocol accounts are excluded. Shielded NAM cannot be attributed to anyone.</p>
  </header>

  <section class="hsum" aria-label="Summary">
    <div class="hsum-b"><span class="hs-fill" style="--w:${top10.toFixed(2)}%"></span></div>
    <dl class="hsum-d">
      <div><dt>top 10 own</dt><dd>${N(pct(top10), holdersTotalProv)}</dd></div>
      <div><dt>holders, Namada</dt><dd>${N(nf(snap.holders.total), holdersTotalProv)}</dd></div>
      <div><dt>holders, Osmosis</dt><dd>${N(nf(OV.dex.holders), OV.dex.prov)}</dd></div>
    </dl>
  </section>

  <section class="filters" aria-label="Filters" data-filters>
    <div class="seg seg--sm" role="group" aria-label="Chain">
      <button type="button" class="seg-b" data-chain="namada" aria-pressed="true">Namada</button>
      <button type="button" class="seg-b" data-chain="osmosis" aria-pressed="false">Osmosis</button>
    </div>
    <div class="fchips">
      <div class="chips chips--scroll" role="group" aria-label="What">
        <button type="button" class="chip on" data-f="all" aria-pressed="true">All kinds <span class="cn">${holdersList.length}</span></button>${catChips}
      </div>
      <div class="chips chips--scroll" role="group" aria-label="Size">
        <button type="button" class="chip on" data-sz="0" aria-pressed="true">Any size</button>${sizeChips}
      </div>
    </div>
    <p class="fcount" aria-live="polite"><span data-shown>${holdersList.length}</span> of ${holdersList.length} loaded shown. ${N(nf(snap.holders.total), holdersTotalProv)} holders in all.</p>
  </section>

  <section class="hpanel" data-panel="namada" aria-label="Holders on Namada">
    ${holdersList_({ cls: 'dl--full' })}
    <div class="empty empty--filter" data-empty hidden>
      <p class="empty-t">${ic('i-dash', 'g')} No loaded holder matches this filter.</p>
      <p class="empty-s">Only the ${holdersList.length} biggest holders are loaded. Try All kinds and Any size, or load the next page.</p>
    </div>
    ${stub([P('Namada indexer and nodes (balance, stake)', Math.min(...holdersList.map((h) => h.verifiedAt)), null)], { extra: `stake checks as recent as ${ageOf(Math.max(...holdersList.map((h) => h.bondedVerifiedAt)))} ago` })}
    <div class="loadmore"><button type="button" class="btn" disabled>Load the next ${nf(CONFIG.holdersLimit)}</button><p class="fine">Showing 1 to ${holdersList.length} of ${nf(snap.holders.total)}. This snapshot holds the first page only.</p></div>
  </section>

  <section class="hpanel" data-panel="osmosis" hidden aria-label="Holders on Osmosis">
    <div class="empty empty--nodata">
      <p class="empty-t">${ic('i-dash', 'g')} No Osmosis holder list in this snapshot.</p>
      <p class="empty-s">What we do have: ${N(nf(OV.dex.holders), OV.dex.prov)} addresses hold NAM on Osmosis, and the 10 biggest own ${N(pct(OV.concentration.osmosisTop10Pct), OV.dex.prov)} of it. The rows would list here, with the same columns. Osmosis addresses are not named, so most rows would be unlabelled.</p>
      ${stub([OV.dex.prov])}
    </div>
  </section>
</div>`;
  return page({ title: 'Holders — Who holds NAM? · namada.trade', desc: 'The biggest NAM holders on Namada, with share of supply, seven-day change and when each balance was last checked.', active: 'feed', body });
}

/* ---- write ------------------------------------------------------------------- */
const out = { 'home.html': homePage(''), 'home.dark.html': homePage('dark'), 'trade.html': tradePage(), 'holders.html': holdersPage() };
for (const [f, html] of Object.entries(out)) { writeFileSync(join(HERE, f), html); console.log('wrote', f, `${(html.length / 1024).toFixed(0)} KB`); }
