// The pages that speak of Discord alerts say what the alerts say: Settings describes the card and that quiet hours
// drop what happens in them; the Activity row of a move found late says so, as its alert's title does. Rendered on the
// server; no network.
import { describe, it, expect, beforeAll } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Flow, UserSettings } from '../shared/types';
import { defaultPrefs } from '../worker/src/settings';

let DeliveryPanel: ComponentType<any>;
let QuietPanel: ComponentType<any>;
let TxList: ComponentType<any>;
beforeAll(async () => {
  // the Settings screen reads the page's address when its modules load: a page at /settings, with nothing else
  const g = globalThis as any;
  const noop = () => {};
  g.location ??= new URL('https://namada.trade/settings');
  g.history ??= { pushState: noop, replaceState: noop, state: null };
  g.window ??= g;
  g.addEventListener ??= noop;
  g.removeEventListener ??= noop;
  g.matchMedia ??= () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
  g.localStorage ??= { getItem: () => null, setItem: noop, removeItem: noop };
  ({ DeliveryPanel, QuietPanel } = await import('../web/src/screens/settings/index'));
  ({ TxList } = await import('../web/src/ui/TxList'));
});

const settings = (): UserSettings => ({ address: `tnam1q${'q'.repeat(39)}`, notifications: defaultPrefs(), channels: { discord: { enabled: true, webhookUrlMasked: 'https://discord.com/api/webhooks/1••••abcd' } as any }, createdAt: 1, updatedAt: 1 });
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&');

describe('Settings says what an alert looks like and what quiet hours do', () => {
  it('where alerts go: one card, its parts, and the test message built from the newest matching move', () => {
    const t = text(renderToStaticMarkup(createElement(DeliveryPanel, { s: settings(), save: async () => settings() })));
    expect(t).toContain('Each alert is one card: the amount and what happened, who moved it with the names this site knows, the price with its source, and links back here and to an explorer.');
    expect(t).toContain('A test message shows one card, built from the newest move that matches your rules.');
    expect(t).not.toMatch(/\bwebhook\b/i);
  });
  it('quiet hours: nothing in them is sent, then or later', () => {
    const t = text(renderToStaticMarkup(createElement(QuietPanel, { s: settings(), save: async () => settings() })));
    expect(t).toContain('Nothing is sent between these hours, and nothing is sent later for them: a move made in them, or a forum post or proposal read in them, gets no alert.');
  });
});

describe('the Activity row says what the alert says', () => {
  const T = Date.UTC(2026, 9, 21, 18, 34);
  const row = (meta: Record<string, unknown>): Flow => ({
    id: 'osmosis:ROW:0', chain: 'osmosis', height: 72940905, ts: T, txHash: 'ROW', kind: 'ibc_in', from: `tnam1${'q'.repeat(40)}`, to: `osmo1${'q'.repeat(38)}`,
    amount: 21_623, priceUsd: 0.000878, valueUsd: 18.98, meta,
  } as Flow);
  const render = (f: Flow) => text(renderToStaticMarkup(createElement(TxList, { rows: [f], now: T + 60_000, onAddr: () => {} })));
  it('a move the catch-up search found is marked found late; a live one is not', () => {
    expect(render(row({ via: 'catch-up search', priceSource: 'spot' }))).toContain('found late');
    expect(render(row({ priceSource: 'spot' }))).not.toContain('found late');
  });
});
