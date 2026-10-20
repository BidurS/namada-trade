import { isInternal } from '../../../shared/alerts';

/** A move's record on a public explorer: the explorer hash when the server sent one (shared/flow-rules.ts explorerHashOf). */
export const explorerTxOf = (f: { chain: string; txHash: string; explorerHash?: string }) => explorerTx(f.chain, f.explorerHash || f.txHash);
export const explorerTx = (chain: string, hash: string) => (chain === 'osmosis' ? `https://www.mintscan.io/osmosis/tx/${hash}` : `https://namada.valopers.com/transactions/${hash.toUpperCase()}`);
export const explorerAddr = (addr: string) => (addr.startsWith('osmo1') ? `https://www.mintscan.io/osmosis/address/${addr}` : `https://namada.valopers.com/account/${addr}`);

// =====================================================================================
// Design-system number rules (docs/design/system.md 5.3). The old views' helpers (and their
// Unicode glyph map) were removed with the views in Phase 4.
// =====================================================================================

/** The true minus sign (U+2212). Every negative delta uses it, never the hyphen. */
export const MINUS = '−';

const ok = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);
const nf = (n: number, min: number, max = min): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max });
/** Rounds away float noise (−0, 1.005 → 1.01) before printing. */
const round = (n: number, d: number): number => {
  const f = 10 ** d;
  const r = Math.round((n + Math.sign(n) * Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
};

/** Sign prefix for a delta: "+", MINUS or "" for zero. */
export const signOf = (n: number): string => (n > 0 ? '+' : n < 0 ? MINUS : '');

/**
 * Dollars by size: under $1 six decimals ($0.001025), $1 to $999.99 two decimals ($24.50),
 * $1,000 and over none ($1,819). Never prints "$0" for a value that is not zero.
 */
export const fmtUsdRule = (n: number | null | undefined): string => {
  if (!ok(n)) return '—';
  const a = Math.abs(n);
  const s = n < 0 ? MINUS : '';
  if (a === 0) return '$0.00';
  if (a >= 1000 || round(a, 2) >= 1000) return `${s}$${nf(round(a, 0), 0)}`;
  if (a >= 1 || round(a, 6) >= 1) return `${s}$${nf(round(a, 2), 2)}`;
  if (round(a, 6) === 0) return `${s}$${a.toPrecision(2)}`; // below a millionth: still not "$0"
  return `${s}$${nf(round(a, 6), 6)}`;
};

/** Signed dollars (a delta): "+$1.20", "−$0.000412". */
export const fmtUsdSigned = (n: number | null | undefined): string => (!ok(n) ? '—' : `${n > 0 ? '+' : ''}${fmtUsdRule(n)}`);

/**
 * A sub-dollar price split for display: the leading "$0.00" is dimmed (ink-2, weight 400) so
 * $0.001025 does not read as $1025. `lead` is empty for $1 and over.
 */
export const splitPrice = (n: number | null | undefined): { lead: string; sig: string } => {
  const s = fmtUsdRule(n);
  const m = /^([−]?\$0\.0*)(\d+)$/.exec(s);
  return m ? { lead: m[1], sig: m[2] } : { lead: '', sig: s };
};

/** Price for a chart tick or pill: no $ sign, six decimals under 1 ("0.001012"). */
export const fmtPriceBare = (n: number | null | undefined): string => {
  if (!ok(n)) return '—';
  return fmtUsdRule(n).replace('$', '');
};

/**
 * NAM amounts: integers from 1,000 up (17,124), two decimals under 10 (4.25), at most one
 * decimal between 10 and 999 (318, 13.8).
 */
export const fmtNamRule = (n: number | null | undefined): string => {
  if (!ok(n)) return '—';
  const a = Math.abs(n);
  const s = n < 0 ? MINUS : '';
  if (round(a, 2) === 0) return '0';
  if (round(a, 1) >= 1000) return s + nf(round(a, 0), 0);
  if (a >= 10) return s + nf(round(a, 1), 0, 1);
  return s + nf(round(a, 2), 2);
};

/** Signed NAM (a delta): "+17,124", "−10,968", "0". */
export const fmtNamSigned = (n: number | null | undefined): string => {
  if (!ok(n)) return '—';
  const body = fmtNamRule(Math.abs(n));
  return body === '0' ? body : `${signOf(n)}${body}`;
};

/** USDC and other dollar coins: always two decimals ("5.05", "102.54"). */
export const fmtCoin = (n: number | null | undefined, digits = 2): string => (!ok(n) ? '—' : nf(round(n, digits), digits));

/**
 * Percent with a fixed number of decimals. Price moves and shares of supply use two
 * (1.49%, 4.80%); hero shares use one (4.4%). Unsigned.
 */
export const fmtPctRule = (n: number | null | undefined, digits = 2): string => (!ok(n) ? '—' : `${nf(round(n, digits), digits)}%`);

/** Signed percent, true minus, two decimals by default: "+0.87%", "−1.49%", "0.00%". */
export const fmtPctSigned = (n: number | null | undefined, digits = 2): string => {
  if (!ok(n)) return '—';
  const r = round(n, digits);
  return `${signOf(r)}${nf(Math.abs(r), digits)}%`;
};

/** Plain integer count with grouping: "2,209". */
export const fmtCount = (n: number | null | undefined): string => (!ok(n) ? '—' : nf(Math.round(n), 0));

const trim1 = (x: number): string => {
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
};

/** U+00A0, the no-break space: between a number and its unit ("1.9 h", "24 h", "7 days"), so a line never ends on the number. */
export const NBSP = '\u00a0';

/**
 * Human age (system.md 5.3): "now" under 5 s, "9 s", "32 min", "3.2 h", "2.3 days", "16 days".
 * One decimal for hours and for days under 10; ".0" is dropped. Negative spans (clock skew,
 * a value stamped in the future) read as "now". The number and its unit are joined by NBSP.
 */
export const fmtAge = (ms: number | null | undefined): string => {
  if (!ok(ms)) return '—';
  const s = Math.max(0, ms) / 1000;
  if (s < 5) return 'now';
  if (s < 60) return `${Math.floor(s)}${NBSP}s`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}${NBSP}min`;
  const h = m / 60;
  if (h < 48) return `${trim1(Math.round(h * 10) / 10)}${NBSP}h`;
  const d = h / 24;
  if (d < 10) return `${trim1(Math.round(d * 10) / 10)}${NBSP}days`;
  return `${Math.round(d)}${NBSP}days`;
};

/** Age of a timestamp against `now` ("3.2 h"); "—" when the time is unknown. */
export const ageOf = (at: number | null | undefined, now: number): string => (ok(at) ? fmtAge(now - at) : '—');

/** Running-text age: "just now", "32 min ago", "16 days ago". */
export const fmtAgo = (at: number | null | undefined, now: number): string => {
  if (!ok(at)) return 'never';
  const a = fmtAge(now - at);
  return a === 'now' ? 'just now' : `${a} ago`;
};

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** "17 Oct 2026, 11:24 UTC" (sheets, "As of"); the clock and "UTC" are joined by a no-break space, so they never part at a line end. */
export const fmtUtcLong = (ts: number | null | undefined): string => {
  if (!ok(ts)) return '—';
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}${NBSP}UTC`;
};

/** "11:24 UTC" (scope sheet rows). */
export const fmtUtcClock = (ts: number | null | undefined): string => {
  if (!ok(ts)) return '—';
  const d = new Date(ts);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}${NBSP}UTC`;
};

/** "17 Oct" (chart axes and stats, UTC). */
export const fmtDayMonth = (ts: number | null | undefined): string => {
  if (!ok(ts)) return '—';
  const d = new Date(ts);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
};

/** "17 Oct, 10:00 UTC" (chart readout). */
export const fmtDayClock = (ts: number | null | undefined): string => (!ok(ts) ? '—' : `${fmtDayMonth(ts)}, ${fmtUtcClock(ts)}`);

/** Eyebrow dateline: "Sat 17 Oct 2026 · 11:24 UTC" (the eyebrow class sets caps). */
export const fmtDateline = (ts: number | null | undefined): string => {
  if (!ok(ts)) return '—';
  const d = new Date(ts);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}${NBSP}UTC`;
};

/** Short address for rows: "tnam1qqscx…027zh" (first 10, last 5). */
export const fmtAddr = (a: string | null | undefined): string => (!a ? '—' : a.length <= 18 ? a : `${a.slice(0, 10)}…${a.slice(-5)}`);

/**
 * Does this label need its short address beside it? Yes for every label but a protocol account's name
 * (the staking, bridge and shielded accounts are one address each). A genesis label such as "Public sale
 * allocation (genesis)" is shared by thousands of addresses, so the name alone cannot tell a seller from
 * the largest holder (the mock-ups print the short address under every label).
 */
export const labelNeedsAddr = (address: string | null | undefined, label: string | null | undefined): boolean => !!label && !!address && !isInternal(address);

/**
 * Rounds shares so they add up to exactly `total` at `digits` decimals (largest remainder):
 * a legend of 29.8 / 7.8 / 4.4 / 56.3 / 1.7 sums to 100.0, never 99.9 or 100.1.
 */
export const roundToTotal = (values: number[], digits = 1, total = 100): number[] => {
  const f = 10 ** digits;
  const scaled = values.map((v) => (Number.isFinite(v) ? v * f : 0));
  const floors = scaled.map((v) => Math.floor(v + 1e-9));
  let left = Math.round(total * f) - floors.reduce((a, b) => a + b, 0);
  const order = scaled.map((v, i) => [v - floors[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0 && order.length; k = (k + 1) % order.length, left--) floors[order[k][1]] += 1;
  return floors.map((v) => v / f);
};

/** Whole dollars for depths and totals where cents carry no information ("$831", "$1,819"); under $1 falls back to fmtUsdRule. */
export const fmtUsdWhole = (n: number | null | undefined): string => {
  if (!ok(n)) return '—';
  if (Math.abs(n) < 1) return fmtUsdRule(n);
  return `${n < 0 ? MINUS : ''}$${nf(Math.round(Math.abs(n)), 0)}`;
};
