// The search grammar (docs/design/nav-search-plan.md 4.1, tests in section 6): every row of the plan's table, the
// named cases ("sell >100k last 7 days", "zondax", "tnam1qx…kj4m" pasted whole, an explorer link, a quoted name,
// "$100", "0x…"), the list rules (a filter the list does not apply is a left-out chip, never a silent one), and
// that the parser never throws.
import { describe, it, expect } from 'vitest';
import {
  parse, removeToken, filterCount, isWholeAddress, emptyParsed, KIND_CHIP, LIST_FIELDS,
  ADDRESS_PREFIX_MIN, HASH_PREFIX_MIN, type Parsed, type ParsedField,
} from '../shared/search-grammar';

const NOW = Date.UTC(2026, 9, 20, 14, 32, 10);
const DAY = (m: number, d: number, y = 2026) => Date.UTC(y, m - 1, d);
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
const OSMO = 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3';
const HASH = 'A1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F60718293A4B5C6D7E8F90';

const p = (s: string, list?: 'moves' | 'holders') => parse(s, { now: NOW, list });
/** The fields a parse set, besides chips (the defaults left out), so a table row states only what it sets. */
function setFields(r: Parsed): Partial<Parsed> {
  const out: Record<string, unknown> = {};
  const empty = emptyParsed() as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(r)) {
    if (k === 'chips') continue;
    if (k === 'text' ? (v as string[]).length > 0 : v !== empty[k]) out[k] = v;
  }
  return out as Partial<Parsed>;
}
const labels = (r: Parsed) => r.chips.map((c) => c.label);

describe('the plan table, row by row (section 4.1)', () => {
  // [typed, the fields it sets, the chip labels]
  const rows: [string, Partial<Parsed>, string[]][] = [
    // sizes: k, m, b suffixes; "nam" optional; NAM only
    ['>100k', { min: 100_000 }, ['At least 100,000 NAM']],
    ['>=1m', { min: 1_000_000 }, ['At least 1,000,000 NAM']],
    ['≥ 2.5m', { min: 2_500_000 }, ['At least 2,500,000 NAM']],
    ['<5000', { max: 5000 }, ['At most 5,000 NAM']],
    ['<= 5k', { max: 5000 }, ['At most 5,000 NAM']],
    ['100k..1m', { min: 100_000, max: 1_000_000 }, ['100,000 to 1,000,000 NAM']],
    ['>100000 nam', { min: 100_000 }, ['At least 100,000 NAM']],
    ['>100,000', { min: 100_000 }, ['At least 100,000 NAM']],
    ['at least 50k', { min: 50_000 }, ['At least 50,000 NAM']],
    ['over 1b', { min: 1_000_000_000 }, ['At least 1,000,000,000 NAM']],
    ['under 1,000', { max: 1000 }, ['At most 1,000 NAM']],
    ['100k', { min: 100_000 }, ['At least 100,000 NAM']],
    ['5000 nam', { min: 5000 }, ['At least 5,000 NAM']],
    // kinds, in the site's words
    ['sell', { kind: 'sell' }, ['Sells only']],
    ['sold', { kind: 'sell' }, ['Sells only']],
    ['buy', { kind: 'buy' }, ['Buys only']],
    ['bought', { kind: 'buy' }, ['Buys only']],
    ['staked', { kind: 'bond' }, ['Staked only']],
    ['stake', { kind: 'bond' }, ['Staked only']],
    ['unstaking', { kind: 'unbond' }, ['Unstaking only']],
    ['unstake', { kind: 'unbond' }, ['Unstaking only']],
    ['unlocked', { kind: 'withdraw' }, ['Unlocked only']],
    ['withdraw', { kind: 'withdraw' }, ['Unlocked only']],
    ['bridged', { kind: 'ibc' }, ['Bridge crossings only']],
    ['bridge', { kind: 'ibc' }, ['Bridge crossings only']],
    ['shielded', { kind: 'shield' }, ['Shielded in only']],
    ['shield', { kind: 'shield' }, ['Shielded in only']],
    ['unshield', { kind: 'unshield' }, ['Shielded out only']],
    ['reward', { kind: 'rewards' }, ['Staking rewards only']],
    ['rewards', { kind: 'rewards' }, ['Staking rewards only']],
    ['pool', { kind: 'dex' }, ['Trades and pool moves']],
    ['bot', { kind: 'other' }, ['Bot trades only']],
    ['bots', { kind: 'other' }, ['Bot trades only']],
    ['transfer', { kind: 'transfer' }, ['Transfers only']],
    ['trades', { kind: 'dex' }, ['Trades and pool moves']],
    ['crossings', { kind: 'ibc' }, ['Bridge crossings only']],
    ['added to pool', { kind: 'lp_add' }, ['Added to pool only']],
    ['staking account balance', { kind: 'pos_balance' }, ['Staking account balance only']],
    // chain
    ['namada', { chain: 'namada' }, ['On Namada']],
    ['osmosis', { chain: 'osmosis' }, ['On Osmosis']],
    ['on namada', { chain: 'namada' }, ['On Namada']],
    ['on Osmosis', { chain: 'osmosis' }, ['On Osmosis']],
    // dates: UTC midnights; hours rolling to the minute
    ['last 7 days', { since: DAY(10, 14) }, ['Last 7 days (since 14 Oct 2026)']],
    ['last 24 h', { since: Date.UTC(2026, 9, 19, 14, 32) }, ['Last 24 hours (since 19 Oct 2026 14:32 UTC)']],
    ['last 24 hours', { since: Date.UTC(2026, 9, 19, 14, 32) }, ['Last 24 hours (since 19 Oct 2026 14:32 UTC)']],
    ['7d', { since: DAY(10, 14) }, ['Last 7 days (since 14 Oct 2026)']],
    ['last week', { since: DAY(10, 14) }, ['Last week (since 14 Oct 2026)']],
    ['today', { since: DAY(10, 20) }, ['Today (since 20 Oct 2026)']],
    ['yesterday', { since: DAY(10, 19), until: DAY(10, 20) }, ['Yesterday (19 Oct 2026)']],
    ['since 2026-10-01', { since: DAY(10, 1) }, ['Since 1 Oct 2026']],
    ['before 2026-10-01', { until: DAY(10, 1) }, ['Before 1 Oct 2026']],
    ['2026-09-01..2026-10-01', { since: DAY(9, 1), until: DAY(10, 2) }, ['1 Sep 2026 to 1 Oct 2026']],
    ['since 1 Oct 2026', { since: DAY(10, 1) }, ['Since 1 Oct 2026']],
    ['since oct 1', { since: DAY(10, 1) }, ['Since 1 Oct 2026']],
    ['since 1 dec', { since: DAY(12, 1, 2025) }, ['Since 1 Dec 2025']],
    ['2026-10-05', { since: DAY(10, 5), until: DAY(10, 6) }, ['On 5 Oct 2026']],
    // options
    ['-bots', { bots: 'off' }, ['Bot trades left out']],
    ['no bots', { bots: 'off' }, ['Bot trades left out']],
    ['both records', { crossings: 'both' }, ['Both records of each crossing']],
    // holder groups
    ['foundation', { what: 'foundation' }, ['Foundation only']],
    ['genesis', { what: 'genesis' }, ['Genesis only']],
    ['backers', { what: 'backer' }, ['Early backers only']],
    ['early backers', { what: 'backer' }, ['Early backers only']],
    ['validators', { what: 'validator' }, ['Validators only']],
    ['no label', { what: 'none' }, ['Without a label only']],
    ['unlabelled', { what: 'none' }, ['Without a label only']],
    // addresses: never fuzzy
    ['tnam1qxyz', { address: 'tnam1qxyz' }, ['Address starts with tnam1qxyz…']],
    ['TNAM1QXYZ', { address: 'tnam1qxyz' }, ['Address starts with tnam1qxyz…']],
    ['osmo1yl6hd', { address: 'osmo1yl6hd' }, ['Address starts with osmo1yl6hd…']],
    [POS, { address: POS }, ['Address tnam1qgqqq…8j2fp']],
    [OSMO, { address: OSMO }, ['Address osmo1yl6hd…y9ep3']],
    ['…kj4m', { tail: 'kj4m' }, ['Address ends with kj4m']],
    ['...kj4mq', { tail: 'kj4mq' }, ['Address ends with kj4mq']],
    ['kj4m', { tail: 'kj4m' }, ['Address ends with kj4m']],
    // records and blocks
    ['a1b2c3d4', { hash: 'A1B2C3D4' }, ['Record starts with A1B2C3D4']],
    [HASH.toLowerCase(), { hash: HASH }, ['Record A1B2C3D4E5F6…']],
    [`https://namada.valopers.com/transactions/${HASH}`, { hash: HASH }, ['Record A1B2C3D4E5F6…']],
    [`https://www.mintscan.io/osmosis/tx/${HASH}?height=1`, { hash: HASH }, ['Record A1B2C3D4E5F6…']],
    [`https://namada.valopers.com/account/${POS}`, { address: POS }, ['Address tnam1qgqqq…8j2fp']],
    ['8294006', { height: 8_294_006 }, ['Block 8,294,006']],
    ['8,294,006', { height: 8_294_006 }, ['Block 8,294,006']],
    ['block 12345', { height: 12_345 }, ['Block 12,345']],
    ['3005', { pool: 3005 }, ['Pool 3005']],
    ['pool 3005', { pool: 3005 }, ['Pool 3005']],
    ['#3368', { pool: 3368 }, ['Pool 3368']],
    // text
    ['"Zondax Validator"', { text: ['Zondax Validator'] }, []],
    ['zondax', { text: ['zondax'] }, []],
    ['0x1234abcd', { text: ['0x1234abcd'] }, []],
  ];
  for (const [typed, fields, chips] of rows) {
    it(`${typed.length > 40 ? `${typed.slice(0, 40)}…` : typed}`, () => {
      const r = p(typed);
      expect(setFields(r)).toEqual(fields);
      expect(labels(r)).toEqual(chips);
    });
  }
});

describe('the named cases (section 6)', () => {
  it('"sell >100k last 7 days": three chips, three filters, no text', () => {
    const r = p('sell >100k last 7 days');
    expect(setFields(r)).toEqual({ kind: 'sell', min: 100_000, since: DAY(10, 14) });
    expect(labels(r)).toEqual(['Sells only', 'At least 100,000 NAM', 'Last 7 days (since 14 Oct 2026)']);
    expect(r.chips.map((c) => c.token)).toEqual(['sell', '>100k', 'last 7 days']);
    expect(r.chips.map((c) => c.fields)).toEqual([['kind'], ['min'], ['since']]);
    expect(filterCount(r)).toBe(3);
  });

  it('"zondax" is a name to look for, not an address end (o is not an address character)', () => {
    expect(p('zondax')).toMatchObject({ text: ['zondax'], tail: null, chips: [] });
    expect(filterCount(p('zondax'))).toBe(0);
  });

  it('"tnam1qx…kj4m" pasted whole: the start and the end of one address', () => {
    const r = p('tnam1qx…kj4m');
    expect(setFields(r)).toEqual({ address: 'tnam1qx', tail: 'kj4m' });
    expect(labels(r)).toEqual(['Address starts with tnam1qx… and ends with kj4m']);
    // the short form the site prints (fmtAddr: first 10, last 5), three dots too
    expect(setFields(p('tnam1qgqqq...8j2fp'))).toEqual({ address: 'tnam1qgqqq', tail: '8j2fp' });
  });

  it('a pasted explorer link gives its record', () => {
    const r = p(`see https://namada.valopers.com/transactions/${HASH.toLowerCase()}`);
    expect(r.hash).toBe(HASH);
    expect(r.text).toEqual(['see']);
    expect(r.chips[0].note).toBe('Read from the explorer link.');
    // any other link is text, and the chip says what is read
    const other = p('https://example.com/whatever');
    expect(other.text).toEqual(['https://example.com/whatever']);
    expect(other.chips[0]).toMatchObject({ fields: ['text'], note: 'Only explorer links to a record or an address are read.' });
  });

  it('"Anoma Foundation" in quotes is one text entry with its space; unquoted, foundation is the holder group', () => {
    expect(p('"Anoma Foundation"')).toMatchObject({ text: ['Anoma Foundation'], what: null, chips: [] });
    expect(p('“Anoma Foundation”').text).toEqual(['Anoma Foundation']);
    expect(setFields(p('anoma foundation'))).toEqual({ text: ['anoma'], what: 'foundation' });
  });

  it('"$100" is text, with the chip that says sizes are NAM', () => {
    for (const typed of ['$100', '>$100', '100 usd', '$1k']) {
      const r = p(typed);
      expect(r.text).toEqual([typed]);
      expect(r.min).toBeNull();
      expect(r.chips).toEqual([{ label: `“${typed}” searched as text`, fields: ['text'], token: typed, span: [0, typed.length], note: 'Sizes are in NAM: a dollar amount is not understood.' }]);
    }
  });

  it('"0x…" is text: no record on these chains starts with 0x, and it is not an address end', () => {
    for (const typed of ['0x1234abcd', '0xdeadbeef00', '0x2f3a']) expect(p(typed)).toMatchObject({ text: [typed], hash: null, tail: null, chips: [] });
  });
});

describe('ambiguity is settled the same way every time', () => {
  it('an address start needs ADDRESS_PREFIX_MIN characters; a shorter one is a left-out chip, not text', () => {
    expect(ADDRESS_PREFIX_MIN).toBe(8);
    const r = p('tnam1qx');
    expect(r.address).toBeNull();
    expect(r.text).toEqual([]);
    expect(r.chips[0]).toMatchObject({ fields: [], note: 'Type at least 8 characters of an address to find it by its start.' });
  });

  it('an address longer than any on its chain is not one', () => {
    const r = p(`${POS}qq`);
    expect(r.address).toBeNull();
    expect(r.chips[0].fields).toEqual([]);
  });

  it('isWholeAddress knows each chain\'s lengths', () => {
    expect(isWholeAddress(POS)).toBe(true);
    expect(isWholeAddress(OSMO)).toBe(true);
    expect(isWholeAddress(POS.slice(0, -1))).toBe(false);
    expect(isWholeAddress('tnam1qxyz')).toBe(false);
    expect(isWholeAddress('tnam1qbcd')).toBe(false); // b is not an address character
  });

  it('digits: 1 to 4 a pool, 5 to 12 a block, longer is text; tx/hash before digits make a record', () => {
    expect(p('7').pool).toBe(7);
    expect(p('12345').height).toBe(12_345);
    expect(p('1790000000000')).toMatchObject({ height: null, hash: null, text: ['1790000000000'] });
    expect(p('tx 12345678').hash).toBe('12345678');
    expect(p('0').pool).toBeNull();
  });

  it('hex of HASH_PREFIX_MIN or more is a record, shorter is not; a hex-looking address end needs the ellipsis', () => {
    expect(HASH_PREFIX_MIN).toBe(8);
    expect(p('a2c3d4e5').hash).toBe('A2C3D4E5');
    expect(p('…a2c3d4e5')).toMatchObject({ tail: 'a2c3d4e5', hash: null });
    expect(p('a2c3d4e').hash).toBeNull();
  });

  it('an address end needs a digit unless it has the ellipsis: plain words stay text', () => {
    expect(p('wallet')).toMatchObject({ tail: null, text: ['wallet'] });
    expect(p('…kjmq').tail).toBe('kjmq');
    expect(p('test2').tail).toBe('test2');
    expect(p('kj4').tail).toBeNull(); // too short
  });

  it('a second value for a field is left out with a chip that says which one is used', () => {
    const r = p('sell buy');
    expect(r.kind).toBe('sell');
    expect(r.chips[1]).toEqual({ label: '“buy” left out', fields: [], token: 'buy', span: [5, 8], note: 'One kind at a time: Sells only is used.' });
    const s = p('>100k >5k');
    expect(s.min).toBe(100_000);
    expect(s.chips[1].note).toBe('One lower size at a time: At least 100,000 NAM is used.');
    // a lower and an upper size are two fields
    expect(setFields(p('>100k <1m'))).toEqual({ min: 100_000, max: 1_000_000 });
  });

  it('a range typed backwards is read the right way round, and says so', () => {
    const r = p('1m..100k');
    expect(setFields(r)).toEqual({ min: 100_000, max: 1_000_000 });
    expect(r.chips[0].note).toBe('Read as 100,000 to 1,000,000 NAM.');
    const d = p('2026-10-01..2026-09-01');
    expect(setFields(d)).toEqual({ since: DAY(9, 1), until: DAY(10, 2) });
  });

  it('>0 sets no lower size', () => {
    expect(p('>0')).toMatchObject({ min: null, chips: [{ label: 'Any size', fields: [] }] });
  });

  it('an impossible date is not a date', () => {
    const r = p('since 2026-02-30');
    expect(r.since).toBeNull();
  });

  it('stop words are dropped without a chip; bridged to osmosis is a kind and a chain', () => {
    expect(setFields(p('bridged to osmosis'))).toEqual({ kind: 'ibc', chain: 'osmosis' });
    expect(setFields(p('sells of at least 100k nam on osmosis'))).toEqual({ kind: 'sell', min: 100_000, chain: 'osmosis' });
  });

  it('removed from pool is a phrase, not "from" a date', () => {
    expect(setFields(p('removed from pool'))).toEqual({ kind: 'lp_remove' });
  });
});

describe('the list a field filters (section 4.3)', () => {
  it('the moves list: a size ceiling, a pool and a holder group are left out, with the reason', () => {
    const r = p('sell <5000 foundation 3005', 'moves');
    expect(setFields(r)).toEqual({ kind: 'sell' });
    expect(r.chips.slice(1).map((c) => [c.label, c.fields, c.note])).toEqual([
      ['At most 5,000 NAM', [], 'Not a filter on the moves list.'],
      ['Foundation only', [], 'Not a filter on the moves list.'],
      ['Pool 3005', [], 'Not a filter on the moves list.'],
    ]);
  });

  it('the moves list searches text anywhere in an address or a record: an address end is that', () => {
    const r = p('…kj4m', 'moves');
    expect(setFields(r)).toEqual({ text: ['kj4m'] });
    expect(r.chips).toEqual([{ label: 'Address or record contains kj4m', fields: ['text'], token: '…kj4m', span: [0, 5] }]);
    const sf = p('tnam1qgqqq…8j2fp', 'moves');
    expect(setFields(sf)).toEqual({ address: 'tnam1qgqqq', text: ['8j2fp'] });
    expect(labels(sf)).toEqual(['Address starts with tnam1qgqqq… and contains 8j2fp']);
    // a 7-character start is too short for the moves list's address range on its own
    expect(setFields(p('tnam1qx…kj4m', 'moves'))).toEqual({ text: ['kj4m'] });
  });

  it('the holders list: kinds, dates, records and blocks are left out; sizes both ways and groups apply', () => {
    const r = p('foundation >1m <10m last 7 days sell', 'holders');
    expect(setFields(r)).toEqual({ what: 'foundation', min: 1_000_000, max: 10_000_000 });
    expect(r.chips.filter((c) => c.fields.length === 0).map((c) => c.label)).toEqual(['Last 7 days (since 14 Oct 2026)', 'Sells only']);
  });

  it('every field a list names is a real field', () => {
    const all = Object.keys(emptyParsed()).filter((k) => k !== 'chips');
    for (const fs of Object.values(LIST_FIELDS)) for (const f of fs) expect(all).toContain(f);
  });
});

describe('chips and the field text', () => {
  it('removing a chip removes exactly its text', () => {
    const input = 'sell  >100k last 7 days zondax';
    const r = p(input);
    expect(removeToken(input, r.chips[1])).toBe('sell last 7 days zondax');
    expect(removeToken(input, r.chips[2])).toBe('sell >100k zondax');
    // and the text that is left parses to the same filters minus that one
    expect(setFields(p(removeToken(input, r.chips[0])))).toEqual({ min: 100_000, since: DAY(10, 14), text: ['zondax'] });
  });

  it('spans point into the input as typed (case and commas kept)', () => {
    const input = 'On Osmosis, SELL';
    const r = p(input);
    for (const c of r.chips) expect(input.slice(c.span[0], c.span[1])).toBe(c.token);
    expect(r.chips.map((c) => c.token)).toEqual(['On Osmosis', 'SELL']);
  });

  it('every kind has chip words and none of them is a banned word', () => {
    const banned = /\b(SQS|IBC|DEX|PoS|MASP|ABCI|RPC|D[1-7])\b|cron|webhook/i;
    for (const w of Object.values(KIND_CHIP)) expect(w).not.toMatch(banned);
  });

  it('every chip a parse makes names fields that exist', () => {
    const all = new Set<ParsedField>(Object.keys(emptyParsed()).filter((k) => k !== 'chips') as ParsedField[]);
    const r = p('sell >100k last 7 days -bots both records on namada tnam1qxyzab …kj4m 8294006 a1b2c3d4 "x y" $5');
    for (const c of r.chips) for (const f of c.fields) expect(all.has(f)).toBe(true);
  });
});

describe('it never throws and never invents a filter', () => {
  it('odd input', () => {
    for (const s of ['', '   ', '""', '"', '>', '>=', '..', '…', '-', '#', 'last', 'since', 'before', 'pool', 'block', 'tx', 'on', '1..', '..5', '>nam', '$', 'tnam1', 'osmo1', '\u0000', '🙂', 'a'.repeat(1000)]) {
      expect(() => p(s)).not.toThrow();
      expect(() => p(s, 'moves')).not.toThrow();
      expect(() => p(s, 'holders')).not.toThrow();
    }
    expect(p('')).toEqual(emptyParsed());
    expect(setFields(p('>'))).toEqual({ text: ['>'] });
    expect(setFields(p('last'))).toEqual({ text: ['last'] });
  });

  it('random input: every chip span is inside the input and set fields have chips', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const parts = ['sell', '>', '100k', '..', 'tnam1', 'qxyz', '…', 'kj4m', 'last', '7', 'days', '"', 'a1b2c3d4', '3005', '$', 'nam', 'since', '2026-10-01', ' ', ' ', 'no', 'bots', 'x'];
    for (let n = 0; n < 500; n++) {
      const s = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => parts[Math.floor(rnd() * parts.length)]).join(rnd() < 0.5 ? ' ' : '');
      const r = parse(s, { now: NOW });
      for (const c of r.chips) {
        expect(c.span[0]).toBeGreaterThanOrEqual(0);
        expect(c.span[1]).toBeLessThanOrEqual(s.length);
        expect(s.slice(c.span[0], c.span[1])).toBe(c.token);
      }
      const chipFields = new Set(r.chips.flatMap((c) => c.fields));
      for (const f of Object.keys(setFields(r)) as ParsedField[]) if (f !== 'text') expect(chipFields.has(f)).toBe(true);
    }
  });
});
