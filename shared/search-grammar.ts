// The search grammar (docs/design/nav-search-plan.md 4.1): one parser for the three search boxes (the palette, the
// Holders field, the Transactions field) and for the Worker's own reading of `?search=` on /api/holders. Pure: no I/O;
// the only clock is `opts.now` (default Date.now()), so a test pins it.
//
// What it reads, in the words the site already uses (the kind words are the tag words of web/src/lib/kinds.ts, kept
// here so shared/ imports nothing from web/):
//   sizes        >100k  >=1m  <5000  100k..1m  >100000 nam  at least 100k  under 5k  100k (k, m, b; NAM only)
//   kinds        sell sold buy bought staked stake unstaking unstake unlocked withdraw bridged bridge shielded shield
//                unshield reward rewards pool bot bots transfer trades crossings (and a few phrases, KIND_PHRASES)
//   chain        namada  osmosis  on namada
//   dates        last 7 days  last 24 h  7d  today  yesterday  since 2026-10-01  before 2026-10-01
//                2026-09-01..2026-10-01  since 1 Oct 2026  (UTC midnights; hours are rolling, to the minute)
//   options      -bots  no bots  both records
//   holders      foundation  genesis  backers  validators  no label  unlabelled
//   identifiers  tnam1qx…(8+)  osmo1…  tnam1qxyz…kj4mq (the short form the site prints)  …kj4m  kj4m (4 to 8 address
//                characters with a digit)  8+ hex (a record, upper-cased)  an explorer link  5+ digits (a block)
//                1 to 4 digits (an Osmosis pool)  "Anoma Foundation" (one text entry)
//   anything else is text: a token that fits nothing is never an error, and addresses and hashes are never fuzzy
//   (one wrong character is another account).
//
// Every understood token gives one chip in plain words (the active-filter strip, section 3.5) carrying the exact
// text it came from and where, so removing the chip removes that text from the field (removeToken). A token that
// was understood but cannot apply (a second size, a holders word on the moves list, a dollar amount) gets a chip
// with a note saying so and sets nothing: no chip ever says a filter is on when it is not.
import type { FlowKind } from './types';

// ---------------------------------------------------------------- the contract

/** A field of Parsed that a chip can set. */
export type ParsedField =
  | 'text' | 'address' | 'tail' | 'hash' | 'height' | 'pool' | 'kind' | 'chain'
  | 'min' | 'max' | 'since' | 'until' | 'bots' | 'crossings' | 'what';

/** The kinds the moves list filters by: a flow kind, or the server's groups 'dex' (trades and pool moves) and 'ibc'. */
export type ParsedKind = FlowKind | 'dex' | 'ibc';
/** The holders list's category filter (`?what=`, the API's `category=`): a raw category, or 'none' (no label). */
export type HolderWhat = 'foundation' | 'genesis' | 'backer' | 'validator' | 'none';

export interface ParsedChip {
  /** What was understood, in plain words, sentence case ("At least 100,000 NAM", "Sells only"). */
  label: string;
  /** The fields this chip set; empty when the token was understood but left out (the note says why). */
  fields: ParsedField[];
  /** The text it was read from, exactly as typed. */
  token: string;
  /** Where that text sits in the input: [start, end) offsets (removeToken cuts it out). */
  span: [number, number];
  /** Why it was read this way or left out, in plain words; absent when there is nothing to add. */
  note?: string;
}

export interface Parsed {
  /** free words left over, in the order typed, matched against addresses, names and hashes; a quoted phrase is one entry */
  text: string[];
  /** a tnam1…/osmo1… start (ADDRESS_PREFIX_MIN or more characters, lower-cased) or a whole address (isWholeAddress);
   *  from the short form "tnam1qx…kj4m" it can be SHORT_FORM_PREFIX_MIN characters, and `tail` is then set too */
  address: string | null;
  /** TAIL_MIN to TAIL_MAX trailing characters of an address, lower-cased ("…kj4m", or "kj4m" when it has a digit) */
  tail: string | null;
  /** HASH_PREFIX_MIN to 64 hex characters, upper-cased; also read from a pasted explorer link */
  hash: string | null;
  /** a block height: 5 or more digits */
  height: number | null;
  /** an Osmosis pool id: 1 to 4 digits */
  pool: number | null;
  kind: ParsedKind | null;
  chain: 'namada' | 'osmosis' | null;
  /** NAM, inclusive: at least `min`, at most `max` */
  min: number | null;
  max: number | null;
  /** unix ms: moves at or after `since`, strictly before `until` (both UTC midnights for dates, minutes for hours) */
  since: number | null;
  until: number | null;
  bots: 'off' | null;
  crossings: 'both' | null;
  what: HolderWhat | null;
  /** what was understood, one chip per token, in the order typed (free words have no chip) */
  chips: ParsedChip[];
}

/** Which list the text filters: fields the list does not apply become left-out chips (the palette passes none). */
export type GrammarList = 'moves' | 'holders';

export interface ParseOptions {
  /** the clock for relative dates (default Date.now()) */
  now?: number;
  list?: GrammarList;
}

/** Characters of an address start, the chain's prefix included ("tnam1qxy"), before it is searched by its start. */
export const ADDRESS_PREFIX_MIN = 8;
/** The start of the short form "tnam1qx…kj4m" may be one shorter: the tail narrows it to one address. */
export const SHORT_FORM_PREFIX_MIN = 7;
export const TAIL_MIN = 4;
export const TAIL_MAX = 8;
/** Hex characters of a record (transaction hash) start; a whole hash is 64. */
export const HASH_PREFIX_MIN = 8;
export const HASH_MAX = 64;
/** The longest input read; the rest is ignored (a search box is not a document). */
export const INPUT_MAX = 300;

/** The fields each list applies (section 4.3): the moves list has no tail, size ceiling, pool or holder category. */
export const LIST_FIELDS: Record<GrammarList, readonly ParsedField[]> = {
  moves: ['text', 'address', 'hash', 'height', 'kind', 'chain', 'min', 'since', 'until', 'bots', 'crossings'],
  holders: ['text', 'address', 'tail', 'chain', 'min', 'max', 'what'],
};

// ---------------------------------------------------------------- words

/** The chip for each kind (the site's tag words). */
export const KIND_CHIP: Record<ParsedKind, string> = {
  buy: 'Buys only',
  sell: 'Sells only',
  bond: 'Staked only',
  unbond: 'Unstaking only',
  withdraw: 'Unlocked only',
  rewards: 'Staking rewards only',
  shield: 'Shielded in only',
  unshield: 'Shielded out only',
  transfer: 'Transfers only',
  other: 'Bot trades only',
  lp_add: 'Added to pool only',
  lp_remove: 'Removed from pool only',
  pgf: 'Public funding only',
  pos_balance: 'Staking account balance only',
  ibc_in: 'Bridge, arriving side only',
  ibc_out: 'Bridge, leaving side only',
  dex: 'Trades and pool moves',
  ibc: 'Bridge crossings only',
};

/** Single words for a kind. 'pool' and 'trades' are the server's 'dex' group, which holds pool moves too. */
const KIND_WORDS: Record<string, ParsedKind> = {
  buy: 'buy', buys: 'buy', bought: 'buy',
  sell: 'sell', sells: 'sell', sold: 'sell',
  stake: 'bond', stakes: 'bond', staked: 'bond', bond: 'bond', bonds: 'bond', bonded: 'bond',
  unstake: 'unbond', unstakes: 'unbond', unstaking: 'unbond', unstaked: 'unbond', unbond: 'unbond', unbonds: 'unbond', unbonding: 'unbond',
  unlock: 'withdraw', unlocks: 'withdraw', unlocked: 'withdraw', withdraw: 'withdraw', withdraws: 'withdraw', withdrawn: 'withdraw', withdrawal: 'withdraw', withdrawals: 'withdraw',
  bridge: 'ibc', bridged: 'ibc', bridges: 'ibc', crossing: 'ibc', crossings: 'ibc',
  shield: 'shield', shields: 'shield', shielded: 'shield', shielding: 'shield',
  unshield: 'unshield', unshields: 'unshield', unshielded: 'unshield', unshielding: 'unshield',
  reward: 'rewards', rewards: 'rewards',
  trade: 'dex', trades: 'dex', swap: 'dex', swaps: 'dex', pool: 'dex', pools: 'dex',
  bot: 'other', bots: 'other',
  transfer: 'transfer', transfers: 'transfer',
};

/** Phrases for a kind, longest first. */
const KIND_PHRASES: { words: string[]; kind: ParsedKind }[] = [
  { words: ['staking', 'account', 'balance'], kind: 'pos_balance' },
  { words: ['added', 'to', 'pool'], kind: 'lp_add' },
  { words: ['removed', 'from', 'pool'], kind: 'lp_remove' },
  { words: ['shielded', 'in'], kind: 'shield' },
  { words: ['shielded', 'out'], kind: 'unshield' },
  { words: ['staking', 'rewards'], kind: 'rewards' },
  { words: ['staking', 'reward'], kind: 'rewards' },
  { words: ['bot', 'trades'], kind: 'other' },
  { words: ['public', 'funding'], kind: 'pgf' },
];

const WHAT_PHRASES: { words: string[]; what: HolderWhat; chip: string }[] = [
  { words: ['early', 'backers'], what: 'backer', chip: 'Early backers only' },
  { words: ['no', 'labels'], what: 'none', chip: 'Without a label only' },
  { words: ['no', 'label'], what: 'none', chip: 'Without a label only' },
  { words: ['unlabelled'], what: 'none', chip: 'Without a label only' },
  { words: ['unlabeled'], what: 'none', chip: 'Without a label only' },
  { words: ['backers'], what: 'backer', chip: 'Early backers only' },
  { words: ['backer'], what: 'backer', chip: 'Early backers only' },
  { words: ['foundation'], what: 'foundation', chip: 'Foundation only' },
  { words: ['genesis'], what: 'genesis', chip: 'Genesis only' },
  { words: ['validators'], what: 'validator', chip: 'Validators only' },
  { words: ['validator'], what: 'validator', chip: 'Validators only' },
];

const BOT_PHRASES = [['-bots'], ['-bot'], ['no', 'bots'], ['no', 'bot'], ['without', 'bots'], ['hide', 'bots']];
const BOTH_PHRASES = [['both', 'records'], ['both', 'sides']];

/** Words that carry nothing on their own once the phrases above are read: dropped without a chip. */
const STOP_WORDS = new Set(['nam', 'moves', 'move', 'of', 'the', 'and', 'in', 'on', 'to', 'from', 'by', 'with', 'a', 'an', 'for', 'all', 'only', 'or']);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_WORDS: Record<string, number> = {};
['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].forEach((m, i) => {
  MONTH_WORDS[m] = i;
  MONTH_WORDS[MONTHS[i]] = i;
});
MONTH_WORDS.sept = 8;

// ---------------------------------------------------------------- formats

const H = 3_600_000;
const D = 86_400_000;
const dayStart = (ms: number) => Math.floor(ms / D) * D;
const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "1 Oct 2026" (UTC) */
export const fmtDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTH_LABEL[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const pad2 = (n: number) => String(n).padStart(2, '0');
/** "19 Oct 2026 14:32 UTC" */
const fmtDayTime = (ms: number): string => {
  const d = new Date(ms);
  return `${fmtDay(ms)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
};
const fmtNam = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });
const quote = (s: string) => `“${s}”`;

/** The bech32 data characters (no 1, b, i, o). */
const B32 = '[02-9ac-hj-np-z]';
const ADDRESS_RE = new RegExp(`^(tnam1|osmo1)(${B32}+)$`);
const SHORT_FORM_RE = new RegExp(`^(tnam1|osmo1)(${B32}+)(?:…|\\.{2,3})(${B32}{${TAIL_MIN},${TAIL_MAX}})$`);
const TAIL_DOTS_RE = new RegExp(`^(?:…|\\.{2,3})(${B32}{${TAIL_MIN},${TAIL_MAX}})$`);
const TAIL_BARE_RE = new RegExp(`^${B32}{${TAIL_MIN},${TAIL_MAX}}$`);
const HEX_RE = new RegExp(`^[0-9a-f]{${HASH_PREFIX_MIN},${HASH_MAX}}$`, 'i');
/** Data characters of a whole address: Namada 40 (45 in all); Osmosis 38 for an account, 58 for a contract. */
const WHOLE_DATA: Record<string, number[]> = { tnam1: [40], osmo1: [38, 58] };
const MAX_DATA: Record<string, number> = { tnam1: 40, osmo1: 58 };

/** Is `a` a whole Namada or Osmosis address (not a start)? */
export function isWholeAddress(a: string): boolean {
  const m = ADDRESS_RE.exec(a);
  return !!m && WHOLE_DATA[m[1]].includes(m[2].length);
}

/** "tnam1qxyzab…kj4mq", the short form the site prints (web/src/lib/format.ts fmtAddr) */
const shortAddr = (a: string) => (a.length <= 18 ? a : `${a.slice(0, 10)}…${a.slice(-5)}`);

/** An amount: 100000, 100,000, 1.5m, 100k, 2b. null when it is not one. */
function readAmount(s: string): number | null {
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?([kmb])?$/i.exec(s);
  if (!m) return null;
  const base = Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
  const mult = !m[3] ? 1 : { k: 1e3, m: 1e6, b: 1e9 }[m[3].toLowerCase() as 'k' | 'm' | 'b'];
  const v = base * mult;
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null;
}
const hasSuffix = (s: string) => /[kmb]$/i.test(s);
const isDollar = (s: string) => /^\$\s*[\d.,]+[kmb]?$/i.test(s) || /^[\d.,]+[kmb]?\s*\$$/i.test(s);
const DOLLAR_UNITS = new Set(['usd', 'usdc', 'dollar', 'dollars', '$']);

/** A whole UTC day from YYYY-MM-DD, or null (an impossible date such as 2026-02-30 is not one). */
function isoDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const t = Date.UTC(y, mo, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo && back.getUTCDate() === d ? t : null;
}
function dmy(day: number, month: number, year: number | null, now: number): number | null {
  if (day < 1 || day > 31) return null;
  const y = year ?? new Date(now).getUTCFullYear();
  const t = Date.UTC(y, month, day);
  if (new Date(t).getUTCDate() !== day) return null;
  // without a year: the most recent such day (typing "since 1 Dec" in October means last December)
  return year == null && t > dayStart(now) ? Date.UTC(y - 1, month, day) : t;
}

// ---------------------------------------------------------------- tokens

interface Tok {
  /** as typed */
  raw: string;
  /** lower-cased, for words */
  w: string;
  start: number;
  end: number;
  quoted: boolean;
}

function tokenize(input: string): Tok[] {
  const out: Tok[] = [];
  const re = /"([^"]*)"|“([^”]*)”|(\S+)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(input)); ) {
    const start = m.index;
    if (m[1] != null || m[2] != null) {
      const t = (m[1] ?? m[2]).replace(/\s+/g, ' ').trim();
      if (t) out.push({ raw: t, w: t.toLowerCase(), start, end: start + m[0].length, quoted: true });
      continue;
    }
    let raw = m[3];
    let s = start, e = start + raw.length;
    // a stray quote or a trailing comma is not part of the token
    while (/^["“”]/.test(raw)) { raw = raw.slice(1); s++; }
    while (/["“”,;]$/.test(raw)) { raw = raw.slice(0, -1); e--; }
    if (raw) out.push({ raw, w: raw.toLowerCase(), start: s, end: e, quoted: false });
  }
  return out;
}

// ---------------------------------------------------------------- matching

type Values = Partial<Pick<Parsed, Exclude<ParsedField, 'text'>>> & { text?: string };

interface Match {
  /** tokens consumed */
  n: number;
  /** what it sets; empty for a word that is dropped (a stop word) */
  set: Values;
  /** the chip; absent for plain text and stop words */
  label?: string;
  note?: string;
}

const words = (toks: Tok[], i: number, phrase: string[]) => phrase.every((p, k) => toks[i + k] && !toks[i + k].quoted && toks[i + k].w === p);

/** A date of one to three tokens at i: { at: UTC midnight, n }. */
function readDate(toks: Tok[], i: number, now: number): { at: number; n: number } | null {
  const t = toks[i];
  if (!t || t.quoted) return null;
  const iso = isoDay(t.w);
  if (iso != null) return { at: iso, n: 1 };
  if (t.w === 'today') return { at: dayStart(now), n: 1 };
  if (t.w === 'yesterday') return { at: dayStart(now) - D, n: 1 };
  const year = (k: number) => (toks[k] && /^\d{4}$/.test(toks[k].w) ? Number(toks[k].w) : null);
  const dayNum = (s: string | undefined) => { const m = s ? /^(\d{1,2})(?:st|nd|rd|th)?,?$/.exec(s) : null; return m ? Number(m[1]) : null; };
  // 1 Oct [2026]
  const d1 = dayNum(t.w);
  const m1 = toks[i + 1] ? MONTH_WORDS[toks[i + 1].w.replace(/[.,]$/, '')] : undefined;
  if (d1 != null && m1 != null) {
    const y = year(i + 2);
    const at = dmy(d1, m1, y, now);
    return at == null ? null : { at, n: y == null ? 2 : 3 };
  }
  // Oct 1 [2026]
  const m0 = MONTH_WORDS[t.w.replace(/[.,]$/, '')];
  const d2 = dayNum(toks[i + 1]?.w);
  if (m0 != null && d2 != null) {
    const y = year(i + 2);
    const at = dmy(d2, m0, y, now);
    return at == null ? null : { at, n: y == null ? 2 : 3 };
  }
  return null;
}

/** "last 7 days" style windows: N and a unit at i ("7 days", "7d", "24 h", "week"). */
function readWindow(toks: Tok[], i: number): { n: number; unit: 'h' | 'd'; count: number; word: string } | null {
  const t = toks[i];
  if (!t || t.quoted) return null;
  const unitOf = (s: string): { unit: 'h' | 'd'; per: number; word: string } | null => {
    if (/^(h|hr|hrs|hour|hours)$/.test(s)) return { unit: 'h', per: 1, word: 'hour' };
    if (/^(d|day|days)$/.test(s)) return { unit: 'd', per: 1, word: 'day' };
    if (/^(w|wk|wks|week|weeks)$/.test(s)) return { unit: 'd', per: 7, word: 'week' };
    if (/^(month|months|mo)$/.test(s)) return { unit: 'd', per: 30, word: 'month' };
    if (/^(year|years|yr|y)$/.test(s)) return { unit: 'd', per: 365, word: 'year' };
    return null;
  };
  const glued = /^(\d{1,4})([a-z]+)$/.exec(t.w);
  if (glued) {
    const u = unitOf(glued[2]);
    return u ? { n: 1, unit: u.unit, count: Number(glued[1]) * u.per, word: plural(Number(glued[1]), u.word) } : null;
  }
  if (/^\d{1,4}$/.test(t.w)) {
    const u = toks[i + 1] && !toks[i + 1].quoted ? unitOf(toks[i + 1].w) : null;
    return u ? { n: 2, unit: u.unit, count: Number(t.w) * u.per, word: plural(Number(t.w), u.word) } : null;
  }
  const u = unitOf(t.w);
  // "last week", "last day": one of the unit
  return u && t.w.length > 1 ? { n: 1, unit: u.unit, count: u.per, word: plural(1, u.word) } : null;
}
const plural = (n: number, w: string) => (n === 1 ? w : `${n} ${w}s`);

function windowMatch(win: { unit: 'h' | 'd'; count: number; word: string }, n: number, now: number): Match | null {
  if (win.count < 1) return null;
  if (win.unit === 'h') {
    if (win.count > 24 * 366) return null;
    const since = Math.floor(now / 60_000) * 60_000 - win.count * H;
    return { n, set: { since }, label: `Last ${win.word} (since ${fmtDayTime(since)})` };
  }
  if (win.count > 3660) return null;
  // the last N days are today and the N − 1 days before it, from UTC midnight
  const since = dayStart(now) - (win.count - 1) * D;
  return { n, set: { since }, label: `Last ${win.word} (since ${fmtDay(since)})` };
}

function matchDates(toks: Tok[], i: number, now: number): Match | null {
  const t = toks[i];
  if (t.quoted) return null;
  // 2026-09-01..2026-10-01: both days in
  const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(t.w);
  if (range) {
    let a = isoDay(range[1]), b = isoDay(range[2]);
    if (a == null || b == null) return null;
    let note: string | undefined;
    if (a > b) { [a, b] = [b, a]; note = `Read as ${fmtDay(a)} to ${fmtDay(b)}.`; }
    return { n: 1, set: { since: a, until: b + D }, label: `${fmtDay(a)} to ${fmtDay(b)}`, note };
  }
  // since / from / after / before / until <date>
  const lead = t.w;
  if (['since', 'from', 'after', 'before', 'until', 'till', 'to'].includes(lead)) {
    const d = readDate(toks, i + 1, now);
    if (d) {
      const n = d.n + 1;
      if (lead === 'since' || lead === 'from') return { n, set: { since: d.at }, label: `Since ${fmtDay(d.at)}` };
      if (lead === 'after') return { n, set: { since: d.at + D }, label: `Since ${fmtDay(d.at + D)}`, note: `After ${fmtDay(d.at)}: from the next day.` };
      if (lead === 'before') return { n, set: { until: d.at }, label: `Before ${fmtDay(d.at)}` };
      return { n, set: { until: d.at + D }, label: `Up to ${fmtDay(d.at)}`, note: `${fmtDay(d.at)} included.` };
    }
  }
  // last / past <window>
  if (lead === 'last' || lead === 'past') {
    const w = readWindow(toks, i + 1);
    if (w) return windowMatch(w, w.n + 1, now);
  }
  if (lead === 'today') return { n: 1, set: { since: dayStart(now) }, label: `Today (since ${fmtDay(dayStart(now))})` };
  if (lead === 'yesterday') return { n: 1, set: { since: dayStart(now) - D, until: dayStart(now) }, label: `Yesterday (${fmtDay(dayStart(now) - D)})` };
  // 7d, 24h, 2w, 7 days on their own
  if (/^\d{1,4}(h|d|w)$/.test(lead) || /^\d{1,4}$/.test(lead)) {
    const w = readWindow(toks, i);
    if (w) return windowMatch(w, w.n, now);
  }
  // a date on its own: that whole day
  const d = readDate(toks, i, now);
  if (d && (d.n > 1 || isoDay(t.w) != null)) return { n: d.n, set: { since: d.at, until: d.at + D }, label: `On ${fmtDay(d.at)}` };
  return null;
}

const COMPARATORS: Record<string, 'min' | 'max'> = { '>': 'min', '>=': 'min', '≥': 'min', '=>': 'min', '<': 'max', '<=': 'max', '≤': 'max', '=<': 'max' };
const WORD_COMPARATORS: { words: string[]; side: 'min' | 'max' }[] = [
  { words: ['at', 'least'], side: 'min' }, { words: ['more', 'than'], side: 'min' }, { words: ['over'], side: 'min' }, { words: ['above'], side: 'min' }, { words: ['min'], side: 'min' },
  { words: ['at', 'most'], side: 'max' }, { words: ['less', 'than'], side: 'max' }, { words: ['under'], side: 'max' }, { words: ['below'], side: 'max' }, { words: ['max'], side: 'max' },
];

const dollarMatch = (tok: string, n: number): Match => ({
  n, set: { text: tok }, label: `${quote(tok)} searched as text`, note: 'Sizes are in NAM: a dollar amount is not understood.',
});

/** An amount after a comparator: the number token at k (with "nam" or a dollar unit after it). */
function amountAt(toks: Tok[], k: number): { v: number | null; dollar: boolean; n: number } | null {
  const t = toks[k];
  if (!t || t.quoted) return null;
  let s = t.w;
  if (isDollar(s)) return { v: null, dollar: true, n: 1 };
  const glued = /^(.*\d[kmb]?)nam$/i.exec(s);
  if (glued) s = glued[1];
  const v = readAmount(s);
  if (v == null) return null;
  const next = toks[k + 1]?.w;
  if (!glued && next && DOLLAR_UNITS.has(next)) return { v: null, dollar: true, n: 2 };
  return { v, dollar: false, n: !glued && next === 'nam' ? 2 : 1 };
}

function sizeMatch(side: 'min' | 'max', v: number, n: number): Match {
  if (side === 'min' && v <= 0) return { n, set: {}, label: 'Any size', note: 'A size above 0 NAM is needed for a lower limit.' };
  return { n, set: side === 'min' ? { min: v } : { max: v }, label: `${side === 'min' ? 'At least' : 'At most'} ${fmtNam(v)} NAM` };
}

function matchSizes(toks: Tok[], i: number): Match | null {
  const t = toks[i];
  if (t.quoted) return null;
  const tokText = (n: number) => toks.slice(i, i + n).map((x) => x.raw).join(' ');
  // >100k, >=1m, <5000 (glued), or > 100k (apart)
  const cmp = /^(>=|<=|=>|=<|≥|≤|>|<)(.*)$/.exec(t.w);
  if (cmp) {
    const side = COMPARATORS[cmp[1]];
    if (cmp[2]) {
      if (isDollar(cmp[2])) return dollarMatch(tokText(1), 1);
      const glued = /^(.*\d[kmb]?)nam$/i.exec(cmp[2]);
      const v = readAmount(glued ? glued[1] : cmp[2]);
      if (v == null) return null;
      const next = toks[i + 1]?.w;
      if (!glued && next && DOLLAR_UNITS.has(next)) return dollarMatch(tokText(2), 2);
      return sizeMatch(side, v, !glued && next === 'nam' ? 2 : 1);
    }
    const a = amountAt(toks, i + 1);
    if (!a) return null;
    if (a.dollar) return dollarMatch(tokText(1 + a.n), 1 + a.n);
    return sizeMatch(side, a.v!, 1 + a.n);
  }
  // at least 100k, under 5k, over 1m
  for (const wc of WORD_COMPARATORS) {
    if (!words(toks, i, wc.words)) continue;
    const a = amountAt(toks, i + wc.words.length);
    if (!a) continue;
    const n = wc.words.length + a.n;
    if (a.dollar) return dollarMatch(tokText(n), n);
    return sizeMatch(wc.side, a.v!, n);
  }
  // 100k..1m: both ends in
  const range = /^([\d.,]+[kmb]?)\.\.([\d.,]+[kmb]?)$/i.exec(t.w);
  if (range) {
    let a = readAmount(range[1]), b = readAmount(range[2]);
    if (a == null || b == null) return null;
    const n = toks[i + 1]?.w === 'nam' ? 2 : 1;
    let note: string | undefined;
    if (a > b) { [a, b] = [b, a]; note = `Read as ${fmtNam(a)} to ${fmtNam(b)} NAM.`; }
    return { n, set: { ...(a > 0 ? { min: a } : {}), max: b }, label: `${fmtNam(a)} to ${fmtNam(b)} NAM`, note };
  }
  // $100, 100 usd
  if (isDollar(t.w)) return dollarMatch(t.raw, 1);
  // 100k, 1.5m, 5000 nam: a size with a suffix or the unit reads as "at least"
  const a = amountAt(toks, i);
  if (a && (a.dollar || hasSuffix(t.w.replace(/nam$/i, '')) || /nam$/i.test(t.w) || toks[i + 1]?.w === 'nam')) {
    if (a.dollar) return dollarMatch(tokText(a.n), a.n);
    return sizeMatch('min', a.v!, a.n);
  }
  return null;
}

/** A pasted explorer link: the record or the address in its path. */
function matchLink(t: Tok): Match | null {
  if (t.quoted || !/^(https?:\/\/|www\.)/i.test(t.raw)) return null;
  const h = /\/(?:tx|txs|transaction|transactions)\/([0-9a-f]{8,64})(?:[/?#]|$)/i.exec(t.raw);
  if (h) return { n: 1, set: { hash: h[1].toUpperCase() }, label: hashLabel(h[1].toUpperCase()), note: 'Read from the explorer link.' };
  const a = /\/(?:account|accounts|address|addresses)\/((?:tnam1|osmo1)[0-9a-z]+)(?:[/?#]|$)/i.exec(t.raw);
  if (a && ADDRESS_RE.test(a[1].toLowerCase())) return { ...addressMatch(a[1].toLowerCase()), note: 'Read from the explorer link.' };
  return { n: 1, set: { text: t.raw }, label: `${quote(t.raw.length > 32 ? `${t.raw.slice(0, 31)}…` : t.raw)} searched as text`, note: 'Only explorer links to a record or an address are read.' };
}

const hashLabel = (h: string) => (h.length === HASH_MAX ? `Record ${h.slice(0, 12)}…` : `Record starts with ${h}`);

function addressMatch(a: string): Match {
  if (isWholeAddress(a)) return { n: 1, set: { address: a }, label: `Address ${shortAddr(a)}` };
  return { n: 1, set: { address: a }, label: `Address starts with ${a}…` };
}

function matchIdentifiers(toks: Tok[], i: number): Match | null {
  const t = toks[i];
  if (t.quoted) return null;
  const w = t.w;
  // tnam1qxyz…kj4mq: the short form the site prints
  const sf = SHORT_FORM_RE.exec(w);
  if (sf) {
    const prefix = sf[1] + sf[2];
    if (prefix.length >= SHORT_FORM_PREFIX_MIN && prefix.length - 5 <= MAX_DATA[sf[1]]) {
      return { n: 1, set: { address: prefix, tail: sf[3] }, label: `Address starts with ${prefix}… and ends with ${sf[3]}` };
    }
  }
  // tnam1… / osmo1…
  const am = ADDRESS_RE.exec(w);
  if (am) {
    if (am[2].length > MAX_DATA[am[1]]) return { n: 1, set: {}, label: `${quote(t.raw.slice(0, 14))}… is not an address`, note: 'It is longer than any address on that chain.' };
    if (w.length < ADDRESS_PREFIX_MIN) return { n: 1, set: {}, label: `${quote(t.raw)} is too short`, note: `Type at least ${ADDRESS_PREFIX_MIN} characters of an address to find it by its start.` };
    return addressMatch(w);
  }
  // …kj4m
  const td = TAIL_DOTS_RE.exec(w);
  if (td) return { n: 1, set: { tail: td[1] }, label: `Address ends with ${td[1]}` };
  // tx A1B2C3D4 / hash … / record …
  if (['tx', 'hash', 'record'].includes(w) && toks[i + 1] && HEX_RE.test(toks[i + 1].w)) {
    const h = toks[i + 1].w.toUpperCase();
    return { n: 2, set: { hash: h }, label: hashLabel(h) };
  }
  // block 8294006 / height …
  if ((w === 'block' || w === 'height') && toks[i + 1] && /^\d{1,3}(,\d{3})+$|^\d+$/.test(toks[i + 1].w)) {
    const h = Number(toks[i + 1].w.replace(/,/g, ''));
    if (Number.isSafeInteger(h) && h > 0) return { n: 2, set: { height: h }, label: `Block ${fmtNam(h)}` };
  }
  // pool 3005 / pool #3005 / #3005
  const poolTok = w === 'pool' && toks[i + 1] ? toks[i + 1].w.replace(/^#/, '') : null;
  if (poolTok && /^\d{1,4}$/.test(poolTok) && Number(poolTok) > 0) return { n: 2, set: { pool: Number(poolTok) }, label: `Pool ${Number(poolTok)}` };
  if (/^#\d{1,4}$/.test(w) && Number(w.slice(1)) > 0) return { n: 1, set: { pool: Number(w.slice(1)) }, label: `Pool ${Number(w.slice(1))}` };
  // digits: 5 or more a block, 1 to 4 a pool
  if (/^\d{1,3}(,\d{3})+$|^\d+$/.test(w)) {
    const digits = w.replace(/,/g, '');
    const v = Number(digits);
    if (digits.length >= 5 && digits.length <= 12) return { n: 1, set: { height: v }, label: `Block ${fmtNam(v)}` };
    if (digits.length <= 4 && v > 0) return { n: 1, set: { pool: v }, label: `Pool ${v}` };
    // longer digit runs (a pasted time, say) are not a block or a record start here: plain text
    return { n: 1, set: { text: t.raw } };
  }
  // 8+ hex: a record (not 0x…, which no record on these chains has)
  if (HEX_RE.test(w)) return { n: 1, set: { hash: w.toUpperCase() }, label: hashLabel(w.toUpperCase()) };
  return null;
}

function matchWords(toks: Tok[], i: number): Match | null {
  const t = toks[i];
  if (t.quoted) return null;
  if (words(toks, i, ['on', 'namada']) || t.w === 'namada') return { n: t.w === 'on' ? 2 : 1, set: { chain: 'namada' }, label: 'On Namada' };
  if (words(toks, i, ['on', 'osmosis']) || t.w === 'osmosis') return { n: t.w === 'on' ? 2 : 1, set: { chain: 'osmosis' }, label: 'On Osmosis' };
  for (const p of BOT_PHRASES) if (words(toks, i, p)) return { n: p.length, set: { bots: 'off' }, label: 'Bot trades left out' };
  for (const p of BOTH_PHRASES) if (words(toks, i, p)) return { n: p.length, set: { crossings: 'both' }, label: 'Both records of each crossing' };
  for (const p of WHAT_PHRASES) if (words(toks, i, p.words)) return { n: p.words.length, set: { what: p.what }, label: p.chip };
  for (const p of KIND_PHRASES) if (words(toks, i, p.words)) return { n: p.words.length, set: { kind: p.kind }, label: KIND_CHIP[p.kind] };
  const k = KIND_WORDS[t.w];
  if (k) return { n: 1, set: { kind: k }, label: KIND_CHIP[k] };
  return null;
}

/** 4 to 8 address characters with a digit and a letter, and not 0x…: the end of an address. */
function matchTail(t: Tok): Match | null {
  if (t.quoted || !TAIL_BARE_RE.test(t.w) || !/\d/.test(t.w) || !/[a-z]/.test(t.w) || t.w.startsWith('0x')) return null;
  return { n: 1, set: { tail: t.w }, label: `Address ends with ${t.w}` };
}

// ---------------------------------------------------------------- parse

const FIELD_ORDER: ParsedField[] = ['address', 'tail', 'hash', 'height', 'pool', 'kind', 'chain', 'min', 'max', 'since', 'until', 'bots', 'crossings', 'what'];
const FIELD_WORD: Record<ParsedField, string> = {
  text: 'text', address: 'address', tail: 'address end', hash: 'record', height: 'block', pool: 'pool', kind: 'kind', chain: 'chain',
  min: 'lower size', max: 'upper size', since: 'start date', until: 'end date', bots: 'bot setting', crossings: 'crossing setting', what: 'holder group',
};
const LIST_WORD: Record<GrammarList, string> = { moves: 'the moves list', holders: 'the holders list' };

export const emptyParsed = (): Parsed => ({
  text: [], address: null, tail: null, hash: null, height: null, pool: null, kind: null, chain: null,
  min: null, max: null, since: null, until: null, bots: null, crossings: null, what: null, chips: [],
});

/**
 * Read a search text (section 4.1). Never throws: a token that fits nothing is text. With `opts.list`, a token
 * whose field that list does not filter by is a left-out chip (an address end on the moves list becomes "address
 * or record contains", which is what the moves search does).
 */
export function parse(input: string, opts: ParseOptions = {}): Parsed {
  const now = opts.now ?? Date.now();
  const src = (input ?? '').slice(0, INPUT_MAX);
  const toks = tokenize(src);
  const out = emptyParsed();
  const setBy = new Map<ParsedField, string>();

  for (let i = 0; i < toks.length; ) {
    const t = toks[i];
    let m: Match | null = null;
    if (t.quoted) m = { n: 1, set: { text: t.raw } };
    else m = matchLink(t) ?? matchDates(toks, i, now) ?? matchSizes(toks, i) ?? matchIdentifiers(toks, i) ?? matchWords(toks, i) ?? matchTail(t);
    if (!m) m = STOP_WORDS.has(t.w) ? { n: 1, set: {} } : { n: 1, set: { text: t.raw } };
    const n = Math.max(1, m.n);
    const last = toks[Math.min(toks.length, i + n) - 1];
    const span: [number, number] = [t.start, last.end];
    const token = src.slice(span[0], span[1]);
    i += n;
    applyMatch(out, m, token, span, setBy, opts.list);
  }
  return out;
}

function applyMatch(out: Parsed, m: Match, token: string, span: [number, number], setBy: Map<ParsedField, string>, list: GrammarList | undefined) {
  const { text, ...rest } = m.set;
  let fields = FIELD_ORDER.filter((f) => (rest as Record<string, unknown>)[f] !== undefined);
  let label = m.label;
  let note = m.note;
  let textValue = text;

  if (list && fields.length) {
    const allowed = LIST_FIELDS[list];
    // the moves search looks for the text anywhere in an address or a record: an address end is that, said so
    if (list === 'moves' && fields.includes('tail')) {
      const tail = rest.tail!;
      if (rest.address != null && rest.address.length >= ADDRESS_PREFIX_MIN) {
        delete rest.tail;
        fields = fields.filter((f) => f !== 'tail');
        textValue = tail;
        label = `Address starts with ${rest.address}… and contains ${tail}`;
      } else {
        delete rest.tail;
        delete rest.address;
        fields = [];
        textValue = tail;
        label = `Address or record contains ${tail}`;
      }
      note = undefined;
    }
    const outside = fields.filter((f) => !allowed.includes(f));
    if (outside.length) {
      out.chips.push({ label: label ?? quote(token), fields: [], token, span, note: `Not a filter on ${LIST_WORD[list]}.` });
      return;
    }
  }

  // a second value for a field already set is left out: the first one stays, and the chip says so
  const taken = fields.find((f) => setBy.has(f));
  if (taken) {
    out.chips.push({ label: `${quote(token)} left out`, fields: [], token, span, note: `One ${FIELD_WORD[taken]} at a time: ${setBy.get(taken)} is used.` });
    return;
  }
  for (const f of fields) {
    (out as unknown as Record<string, unknown>)[f] = (rest as Record<string, unknown>)[f];
    setBy.set(f, label ?? quote(token));
  }
  if (textValue != null) out.text.push(textValue);
  if (label != null) {
    const chipFields: ParsedField[] = textValue != null ? [...fields, 'text'] : fields;
    out.chips.push(note ? { label, fields: chipFields, token, span, note } : { label, fields: chipFields, token, span });
  }
}

/** The input without a chip's text (and the space around it): what the field reads after the chip is removed. */
export function removeToken(input: string, chip: Pick<ParsedChip, 'span'>): string {
  const [a, b] = chip.span;
  return `${input.slice(0, a)} ${input.slice(b)}`.replace(/\s+/g, ' ').trim();
}

/** How many filters (fields other than text) the text sets: the palette's "Lists" row shows when this is above 0. */
export const filterCount = (p: Parsed): number => FIELD_ORDER.filter((f) => p[f as keyof Parsed] != null).length;
