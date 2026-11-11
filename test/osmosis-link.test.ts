// The one link from the Trade ticket to Osmosis (owner decision 46, 2026-11-10). The site stays read-only: the link is
// plain text named for the pair, opens the Osmosis app's own page for it in a new tab with no referrer and no handle
// back, and carries nothing of the reader's (no amount, no address, no side). It is not a button.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { OSMOSIS_PAIR_LINK, OSMOSIS_PAIR_NOTE, OSMOSIS_PAIR_URL } from '../shared/osmosis-app';

const ticket = readFileSync(new URL('../web/src/screens/trade/Ticket.tsx', import.meta.url), 'utf8');

describe('the link from the ticket to Osmosis', () => {
  it('is the Osmosis app\'s page for the pair and nothing else: a fixed address with the two coins', () => {
    const u = new URL(OSMOSIS_PAIR_URL);
    expect(u.protocol).toBe('https:');
    expect(u.host).toBe('app.osmosis.zone');
    expect(u.pathname).toBe('/');
    expect([...u.searchParams.entries()]).toEqual([['from', 'NAM'], ['to', 'USDC']]);
    expect(u.hash).toBe('');
  });

  it('is named for the pair, and says beside it that this site makes no trade', () => {
    expect(OSMOSIS_PAIR_LINK).toBe('Open NAM / USDC on Osmosis');
    expect(OSMOSIS_PAIR_NOTE).toBe('Opens the Osmosis app in a new tab. This site makes no trade and sends nothing with the link.');
  });

  it('is a text link in a new tab with no referrer and no handle back, built from the fixed address alone', () => {
    const a = /<a className="link tk-out__a"[^>]*>/.exec(ticket)![0];
    expect(a).toContain('href={OSMOSIS_PAIR_URL}');
    expect(a).toContain('target="_blank"');
    expect(a).toContain('rel="noopener noreferrer"');
    // nothing of the reader's is put into the address: the ticket uses the constant as it is, once
    expect(ticket.split('OSMOSIS_PAIR_URL').length - 1).toBe(2);
    expect(ticket).not.toMatch(/OSMOSIS_PAIR_URL\s*\+|\$\{OSMOSIS_PAIR_URL\}/);
    // a link, not a button
    expect(a).not.toMatch(/btn|role="button"/);
    expect(ticket).toContain('<span className="tk-out__n">{OSMOSIS_PAIR_NOTE}</span>');
  });
});
