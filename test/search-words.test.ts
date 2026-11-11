// The plain words in the search box (shared/search-words.ts, web/src/app/palette-match.ts): the public review of
// 2026-11-10 found that "price", "volume" and "market cap" found nothing, because the Views group matched only a
// page's label and heading. What is held here: the table (each row leads to a real page, under a name that page
// prints), the matching (pure: read without the shell), and how the search box lists the rows.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SEARCH_WORDS } from '../shared/search-words';
import { routeByPath } from '../shared/routes';
import { SUPPLY_WORDS, VALUE_WORDS } from '../shared/copy';
import { BOOK_EYEBROW } from '../shared/depth';
import { NO_MATCH, WORDS_MIN_CHARS, textTier, wordRows } from '../web/src/app/palette-match';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const row = (id: string) => SEARCH_WORDS.find((r) => r.id === id)!;
const found = (text: string, listed: { path: string; label: string }[] = []) => wordRows(text, listed).map((r) => r.word.id);

/**
 * Where each row's label is printed: the screen's file and the line of it that prints the label. A label that is a
 * constant of shared/ is held equal to that constant in the test below, and the line here is the one that renders it.
 */
const PRINTED: Record<string, { file: string; line: string }> = {
  price: { file: 'web/src/screens/trade/Head.tsx', line: '<span className="tk-price__k">NAM price, as the pools quote it{rewound ? \' then\' : \'\'}</span>' },
  volume: { file: 'web/src/screens/trade/Head.tsx', line: '>Traded, 24 h</Defined> : \'Traded, 24 h\'}' },
  'all-nam': { file: 'web/src/screens/trade/Head.tsx', line: '<Defined title={allLabel} text={thenWords(DEFINE.allNam)}>{allLabel}</Defined>' },
  'new-nam': { file: 'web/src/screens/supply/SinceGenesis.tsx', line: '<h2 id="sp-gen-h" className="h2">{SUPPLY_WORDS.heading}</h2>' },
  'pool-depth': { file: 'web/src/screens/trade/Head.tsx', line: '<Defined title="Pool depth" text={DEFINE.depth}>Pool depth</Defined>' },
  'price-move': { file: 'web/src/screens/trade/Ticket.tsx', line: '<dt><Term id="price-move">Price move</Term></dt>' },
  book: { file: 'web/src/screens/depth/index.tsx', line: '<p className="eyebrow dp-band__eyebrow">{BOOK_EYEBROW}</p>' },
  'staking-rate': { file: 'web/src/screens/seo/Staking.tsx', line: 'label: \'Staking rate a year, before commission\',' },
  validators: { file: 'web/src/screens/seo/Validators.tsx', line: 'eyebrow={<Dateline label="Validators" />}' },
  holders: { file: 'web/src/screens/activity/index.tsx', line: '<p className="eyebrow">Activity · {tab === \'holders\' ? \'Holders\' : \'Transactions\'}</p>' },
  bridges: { file: 'web/src/screens/seo/Bridges.tsx', line: 'eyebrow={<Dateline label="Bridges" />}' },
  unstaking: { file: 'web/src/screens/supply/Unlocks.tsx', line: '<h2 id="ul-h" className="h2">Unstaking and restaking</h2>' },
  shielded: { file: 'web/src/screens/shielded/index.tsx', line: '<p className="eyebrow">Shielded{asOf != null' },
  votes: { file: 'web/src/screens/seo/Governance.tsx', line: 'eyebrow={<Dateline label="Votes" />}' },
  api: { file: 'web/src/screens/seo/Developers.tsx', line: '<p className="eyebrow seo-eyebrow">API{route?.updated' },
  download: { file: 'web/src/screens/activity/Transactions.tsx', line: '<span>Download page data</span>' },
  status: { file: 'web/src/screens/seo/Status.tsx', line: 'eyebrow={<Dateline label="Status" />}' },
  alerts: { file: 'web/src/screens/alerts/index.tsx', line: ': \'Alerts\'}</p>' },
};
/** The rows whose label is a constant of shared/, or is put together by the screen: the line renders it, the test below holds it. */
const BY_CONSTANT = new Set(['all-nam', 'new-nam', 'book']);

describe('the table of plain words', () => {
  it('is a short table of rows with distinct ids, lower-case words and a real page each', () => {
    expect(SEARCH_WORDS.length).toBeGreaterThanOrEqual(12);
    expect(SEARCH_WORDS.length).toBeLessThanOrEqual(18);
    expect(new Set(SEARCH_WORDS.map((r) => r.id)).size).toBe(SEARCH_WORDS.length);
    for (const r of SEARCH_WORDS) {
      expect(r.id, r.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(r.words.length, r.id).toBeGreaterThan(0);
      expect(new Set(r.words).size, `${r.id}: a word twice`).toBe(r.words.length);
      for (const w of r.words) expect(w, `${r.id}: "${w}"`).toBe(w.trim().toLowerCase());
      // a route path as it is: no query, no fragment (the router opens a page at its top)
      const route = routeByPath(r.path);
      expect(route, `${r.id}: ${r.path} is not a route`).toBeDefined();
      expect(route!.index, `${r.id}: ${r.path} is a public page`).toBe(true);
      // where it is: the page by its own name, or the page itself
      expect(r.where, r.id).toBe(r.label === route!.label ? 'On its own page' : `On ${route!.label}`);
    }
  });

  it('names each thing as its page prints it', () => {
    expect(Object.keys(PRINTED).sort()).toEqual(SEARCH_WORDS.map((r) => r.id).sort());
    for (const r of SEARCH_WORDS) {
      const at = PRINTED[r.id];
      expect(read(at.file), `${r.id}: ${at.file} no longer prints "${r.label}" this way`).toContain(at.line);
      if (!BY_CONSTANT.has(r.id)) expect(at.line, r.id).toContain(r.label);
    }
    // the three labels the screens read from shared/ or put together
    expect(row('new-nam').label).toBe(SUPPLY_WORDS.heading);
    expect(row('book').label).toBe(BOOK_EYEBROW);
    expect(row('all-nam').label).toBe(VALUE_WORDS.allNamLabel);
    const head = read('web/src/screens/trade/Head.tsx');
    expect(head).toContain("const atPrice = rewound ? 'at the price then' : 'at today’s price';");
    expect(head).toContain('const allLabel = `All NAM ${atPrice}`;');
    expect(row('all-nam').label).toBe('All NAM at today’s price');
  });

  it('writes "market cap" in no label and no place: the row a reader finds by it carries the site\'s own phrase', () => {
    for (const r of SEARCH_WORDS) {
      expect(r.label, r.id).not.toMatch(/market\s*cap/i);
      expect(r.where, r.id).not.toMatch(/market\s*cap/i);
    }
    expect(row('all-nam').words).toContain('market cap');
  });
});

describe('what a typed text finds', () => {
  it('"price", "volume" and "market cap" each find their row, as an exact match', () => {
    expect(wordRows('price').find((r) => r.word.id === 'price')).toMatchObject({ tier: 0, word: { label: 'NAM price, as the pools quote it', where: 'On Trade', path: '/trade' } });
    expect(wordRows('volume').find((r) => r.word.id === 'volume')).toMatchObject({ tier: 0, word: { label: 'Traded, 24 h', where: 'On Trade', path: '/trade' } });
    expect(wordRows('market cap').find((r) => r.word.id === 'all-nam')).toMatchObject({ tier: 0, word: { label: 'All NAM at today’s price', where: 'On Trade', path: '/trade' } });
    // typed as people type it
    for (const t of ['Market Cap', ' market cap ', 'marketcap', 'mcap', 'MCAP']) expect(found(t), t).toContain('all-nam');
  });

  it('finds the rest by the words a newcomer uses', () => {
    const want: Record<string, string> = {
      slippage: 'price-move', liquidity: 'pool-depth', 'order book': 'book', apr: 'staking-rate', inflation: 'new-nam', whales: 'holders',
      ibc: 'bridges', unbonding: 'unstaking', masp: 'shielded', governance: 'votes', json: 'api', csv: 'download', uptime: 'status', notifications: 'alerts', commission: 'validators',
    };
    for (const [text, id] of Object.entries(want)) expect(found(text), text).toContain(id);
  });

  it('matches a row by its words and by its own label, with the tier the search box ranks by', () => {
    // "price": the word itself, the start of "Price move", the end of "All NAM at today’s price"
    expect(Object.fromEntries(wordRows('price').map((r) => [r.word.id, r.tier]))).toEqual({ price: 0, 'price-move': 1, 'all-nam': 2 });
    // the rows come in the table's order: the search box sorts them with the pages it lists
    expect(found('price')).toEqual(['price', 'all-nam', 'price-move']);
    expect(wordRows('since genesis')[0]).toMatchObject({ tier: 3, word: { id: 'new-nam' } });
  });

  it('leaves out a row that would repeat a page already listed for the same text', () => {
    // "holders" lists the Holders page itself: the row with that path and label says nothing more
    expect(found('holders')).toContain('holders');
    expect(found('holders', [{ path: '/holders', label: 'Holders' }])).not.toContain('holders');
    // the same page under another name is not a repeat, nor is the same name on another page
    expect(found('price', [{ path: '/trade', label: 'Trade' }])).toContain('price');
    expect(found('holders', [{ path: '/activity', label: 'Holders' }])).toContain('holders');
    // a word no page's name holds finds the row whatever is listed
    expect(found('whales', [{ path: '/', label: 'Home' }])).toEqual(['holders']);
  });

  it('while the site is rewound, leaves out the row whose page shows the thing only as it is now', () => {
    expect(SEARCH_WORDS.filter((r) => r.liveOnly).map((r) => r.id)).toEqual(['new-nam']);
    // the Supply page draws "NAM since genesis" from current figures, so not on a rewound page
    expect(read('web/src/screens/supply/index.tsx')).toContain('{!rewound ? <SinceGenesis overview={o} wide={wide} cohorts={cohorts.data} failed={cohorts.failed} /> : null}');
    expect(found('inflation')).toEqual(['new-nam']);
    expect(wordRows('inflation', [], true)).toEqual([]);
    // every other row is found either way
    expect(wordRows('price', [], true).map((r) => r.word.id)).toEqual(found('price'));
  });

  it('finds nothing for no text, for one letter, or for a text no row holds', () => {
    expect(WORDS_MIN_CHARS).toBe(2);
    for (const t of ['', '   ', 'p', ' p ']) expect(wordRows(t), `"${t}"`).toEqual([]);
    expect(wordRows('pr').length).toBeGreaterThan(0);
    // texts the browser tests type, whose first result must stay what it is (an address, a record, an action)
    for (const t of ['zond', 'zonda', 'zondax', 'keys', 'where every', '8294006', 'foundation', 'sell >100k', 'tnam1q8nm', 'qqqqqqqqqqqqqq']) expect(wordRows(t), t).toEqual([]);
  });

  it('textTier: exact, the start, the end, a word start, inside, none', () => {
    expect(textTier('price', 'price')).toBe(0);
    expect(textTier('PRICE', 'nam price', 'price')).toBe(0);
    expect(textTier('pri', 'price')).toBe(1);
    expect(textTier('cap', 'market cap')).toBe(2);
    expect(textTier('cap', 'the market cap, in words')).toBe(3);
    expect(textTier('ark', 'market cap')).toBe(4);
    expect(textTier('zz', 'price', null, undefined)).toBe(NO_MATCH);
    expect(textTier('', 'price')).toBe(NO_MATCH);
    // a text with a character a pattern would read as its own is matched as written
    expect(textTier('(vp', 'query (vp/pos)')).toBe(3);
    expect(textTier('a.b', 'axb')).toBe(NO_MATCH);
  });
});

describe('the rows in the search box', () => {
  const palette = read('web/src/app/Palette.tsx');

  it('the matching is read without the shell: one import, the table', () => {
    const src = read('web/src/app/palette-match.ts');
    expect(src.match(/^import .*$/gm)).toEqual(["import { SEARCH_WORDS, type SearchWord } from '../../../shared/search-words';"]);
    // the search box uses that one copy, and keeps the names it exported before
    expect(palette).toContain("import { NO_MATCH, textTier, wordRows } from './palette-match';");
    expect(palette).toContain("export { NO_MATCH, WORDS_MIN_CHARS, textTier, wordRows, type WordRow } from './palette-match';");
    expect(palette).not.toContain('export function textTier(');
  });

  it('join the Views group while typing, ranked with the pages, and are chosen and remembered as a page is', () => {
    // against the pages listed for the same text, so a repeat is left out
    expect(palette).toContain('listed.push({ path, label });');
    expect(palette).toContain('wordRows(term, listed, rewound).forEach(({ word: w, tier }, i) =>');
    expect(palette).toContain("out.push({ id: `w:${w.id}`, group: 'views', label: w.label, sub: w.where, icon: iconOfPath(w.path), tier, score: recentScore(recent, 'view', w.path, now), order: TABS.length + ROUTES.length + i, run: () => { noteRecent('view', w.path, { label: w.label }); go(w.path); } }),");
    // a page is chosen and remembered the same way
    expect(palette).toContain("run: () => { noteRecent('view', path, { label }); go(path); } });");
    // one ranking for the group: the tier, then how often it was opened here, then the table's order
    expect(palette).toContain('const byRank = (a: Item, b: Item) => a.tier - b.tier || b.score - a.score || a.order - b.order;');
    expect(palette).toContain('const list = items.filter((i) => i.group === g).sort(byRank);');
  });
});
