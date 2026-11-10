// The validators page as it is drawn (web/src/screens/seo/Validators.tsx), rendered to static markup; nothing reaches
// the network. What is held true: the list is a role="table" grid and never a <table>; a validator's name, which is
// the chain's own text, is printed as text only, cut at forty characters, and is never part of a link, a class name
// or markup (the link carries the address); a state is said in the table's plain words, and a word that is not in
// the table is "Not recorded", never printed as it came; a figure that was not read is a dash, never a zero; every
// figure sits in one scope whose source line lists it; the first rows are shown until all are asked for; and the
// page itself states its one heading and both paragraphs of its copy before any answer has arrived.
import { describe, it, expect, beforeAll } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BODY } from '../shared/copy';
import { routeByPath } from '../shared/routes';
import { VALIDATORS_SHOWN, VALIDATORS_SOURCE, VALIDATOR_NAMES_SOURCE } from '../shared/validators';
import type { Provenance, ValidatorRow, ValidatorsResponse } from '../shared/types';

let ValidatorList: ComponentType<any>;
let Validators: ComponentType<any>;
beforeAll(async () => {
  const g = globalThis as any;
  const noop = () => {};
  g.location ??= new URL('https://namada.trade/validators');
  g.history ??= { pushState: noop, replaceState: noop, state: null };
  g.window ??= g;
  g.addEventListener ??= noop;
  g.removeEventListener ??= noop;
  g.matchMedia ??= () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
  g.localStorage ??= { getItem: () => null, setItem: noop, removeItem: noop };
  ({ ValidatorList, Validators } = await import('../web/src/screens/seo/Validators'));
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ');

const NOW = Date.UTC(2026, 10, 10, 5, 30);
const AT = Date.UTC(2026, 10, 9, 0, 10);
const addr = (c: string) => `tnam1q${c.repeat(39)}`;
const HOSTILE = '<img src=x onerror=alert(1)>" class="x';
const LONG = 'A very long validator name that goes on and on past any sensible length';
const rows: ValidatorRow[] = [
  { validator: addr('a'), name: 'Alpha', stake: 4_000_000, share: 0.4, delegators: 1204, commission: 0.05, state: 'consensus', changeNam: 12_345.5 },
  { validator: addr('c'), name: HOSTILE, stake: 3_000_000, share: 0.3, delegators: 80, commission: 0.1, state: 'jailed', changeNam: -500 },
  { validator: addr('d'), name: LONG, stake: 2_000_000, share: 0.2, delegators: 7, commission: 0, state: 'belowCapacity', changeNam: 0 },
  { validator: addr('e'), name: null, stake: 1_000_000, share: 0.1, delegators: 1, commission: null, state: 'tombstoned', changeNam: null },
];
const live = (source: string): Provenance => ({ source, at: AT, status: 'live' });
const answer = (validators: ValidatorRow[] = rows): ValidatorsResponse => ({
  asOf: NOW, day: '2026-11-09', days: ['2026-11-09', '2026-11-08'], validators, totalNam: 10_000_000, count: validators.length, third: 1, twoThirds: 2, prev: '2026-11-08',
  prov: live(VALIDATORS_SOURCE), namesProv: live(VALIDATOR_NAMES_SOURCE),
});
const draw = (d: ValidatorsResponse, over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(ValidatorList, {
  d, listP: d.prov, namesP: d.namesProv, changeP: d.prov, sel: null, hrefOf: (a: string) => `/validators?v=${a}`, now: NOW, ...over,
}));

describe('the list of validators', () => {
  it('is a grid with the roles of a table and no <table>, one row a validator under a head row', () => {
    const html = draw(answer());
    expect(html).not.toMatch(/<table|<tr|<td/);
    expect(html).toContain('role="table"');
    expect(html.split('role="row"').length - 1).toBe(rows.length + 1);
    expect(html.split('role="columnheader"').length - 1).toBe(8);
    expect(html.split('role="cell"').length - 1).toBe(rows.length * 8);
    expect(html).toContain(`aria-rowcount="${rows.length + 1}"`);
    const t = text(html);
    for (const head of ['Validator', 'Stake', 'Share', 'Addresses', 'Commission', 'State', 'Change']) expect(t).toContain(head);
    // rank, stake, share, addresses, commission and the signed change of the first row
    expect(t).toMatch(/1 Alpha tnam1qaaaa…aaaaa 4,000,000\s+NAM 40% Addresses 1,204 Commission 5% In the active set Change, NAM \+12,346\s+NAM/);
  });

  it('prints a name as text only: escaped, cut at forty characters, and never in a link, a class or an attribute', () => {
    const html = draw(answer());
    // the markup in the name is text on the page
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot; class=&quot;x');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror=alert(1)>');
    // the long name is cut, with an ellipsis as its fortieth character
    expect(text(html)).toContain('A very long validator name that goes on…');
    expect(text(html)).not.toContain('past any sensible length');
    // every link carries the address and nothing of the name; no attribute holds the name
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(rows.map((r) => `/validators?v=${r.validator}`));
    for (const m of html.matchAll(/\s(class|id|style|href|aria-label|title|data-[a-z-]+)="([^"]*)"/g)) {
      expect(m[2], m[0]).not.toMatch(/img|onerror|Alpha|very long/);
    }
    // a validator without a name is printed by its short address, and the address is not repeated under it
    expect(text(html)).toMatch(/4 tnam1qeeee…eeeee 1,000,000/);
  });

  it('says a state in plain words, and a word it does not know as "Not recorded"; a figure not read is a dash', () => {
    const t = text(draw(answer()));
    expect(t).toContain('In the active set');
    expect(t).toContain('Jailed');
    expect(t).toContain('Below the active set');
    expect(t).toContain('Not recorded');
    for (const raw of ['consensus', 'jailed', 'belowCapacity', 'tombstoned']) expect(t).not.toContain(raw);
    // the last row: no commission and no change on record, shown as dashes; a change of nothing is "0", which is a figure
    expect(t).toMatch(/Commission — Not recorded Change, NAM —/);
    expect(t).toMatch(/Commission 0% Below the active set Change, NAM 0\s+NAM/);
    expect(t).not.toMatch(/Commission 0% Not recorded/);
  });

  it('keeps every figure inside one scope whose source line lists what it covers', () => {
    const html = draw(answer());
    expect(html.split('data-prov-scope').length - 1).toBe(1);
    const scope = /data-scope="([^"]*)"/.exec(html)?.[1].replace(/&amp;/g, '&');
    expect(scope).toBe('Stake, share and addresses staked|Names, commission and state|Change since 8 Nov 2026');
    expect(text(html)).toContain('The first complete listing of 9 Nov 2026, UTC.');
    // every figure is a stamped number of the kit (data-num), inside the scope
    expect(html.split('data-num').length - 1).toBeGreaterThanOrEqual(rows.length * 5);
    // a current listing is not dimmed
    expect(html).not.toContain('is-old');
  });

  it('an old listing is dimmed once and says how old it is; a day whose names were not read says so above the rows', () => {
    const d = answer();
    const old: Provenance = { source: VALIDATORS_SOURCE, at: NOW - 6 * 86_400_000, status: 'stale', note: 'The listing of a newer day is not on record.' };
    const html = draw(d, { listP: old, namesP: { source: VALIDATOR_NAMES_SOURCE, at: null, status: 'missing', note: 'Names, commission and state were not read for that day.' } });
    expect(html).toContain('is-old');
    expect(text(html)).toContain('This listing is 6 days old, so it is shown dimmed.');
    expect(text(html)).toContain('Names, commission and state were not read for that day.');
    // what was not read at all is said above the rows and left out of the source line, which sums up what is shown
    expect(/data-scope="([^"]*)"/.exec(html)?.[1]).toBe('Stake, share and addresses staked|Change since 8 Nov 2026');
    const first = draw({ ...d, prev: null }, { changeP: { source: VALIDATORS_SOURCE, at: null, status: 'missing', note: 'No earlier day is on record to compare with.' } });
    expect(text(first)).toContain('No earlier day is on record to compare with.');
    expect(/data-scope="([^"]*)"/.exec(first)?.[1]).toBe('Stake, share and addresses staked|Names, commission and state');
  });

  it('shows the first rows and a button for the rest; the open validator\'s row is marked', () => {
    const many = Array.from({ length: VALIDATORS_SHOWN + 12 }, (_, i): ValidatorRow => ({ validator: `tnam1q${String(i).padStart(39, '0').replace(/1/g, 'x')}`, name: null, stake: 1000 - i, share: 0.001, delegators: 1, commission: 0.05, state: 'consensus', changeNam: 0 }));
    const html = draw(answer(many), { sel: many[3].validator });
    expect(html.split('role="row"').length - 1).toBe(VALIDATORS_SHOWN + 1);
    expect(html).toContain(`aria-rowcount="${many.length + 1}"`);
    expect(text(html)).toContain(`Show all ${many.length}`);
    expect(html.split('aria-current="true"').length - 1).toBe(1);
    expect(html.split('is-sel').length - 1).toBe(1);
    // the tools: a text filter with its own label and the three orders
    expect(html).toContain('placeholder="Name or address"');
    for (const o of ['Stake', 'Commission', 'Addresses']) expect(html).toMatch(new RegExp(`<input type="radio"[^>]*value="${o.toLowerCase()}"`));
    // few enough rows need no button
    expect(text(draw(answer()))).not.toContain('Show all');
  });
});

describe('the page before any answer', () => {
  it('states its one heading and both paragraphs of its copy, holds the list\'s place, and links the related pages', () => {
    const route = routeByPath('/validators')!;
    const html = renderToStaticMarkup(createElement(Validators, { view: 'validators', route }));
    expect(html.split('<h1').length - 1).toBe(1);
    expect(text(html)).toContain(route.h1);
    for (const p of BODY.validators.paras) expect(text(html)).toContain(p);
    expect(html).not.toMatch(/<table/);
    expect(html).toContain('aria-busy="true"');
    for (const to of ['/staking', '/holders', '/developers']) expect(html).toContain(`href="${to}"`);
    // no figure is shown before it is read: no number of the kit is in the page yet
    expect(html).not.toContain('data-num');
  });
});
