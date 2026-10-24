// Security review (2026-10-22), a channel Discord said is gone: when Discord answers that a subscriber's webhook link
// no longer exists (404, Unknown Webhook) or has a wrong token (401, Invalid Webhook Token), the dispatcher turns the
// channel off and the settings API says so (channels.discord.stopped). The Settings page ignored it: it said "sending
// is off" beside a switch described as pausing, as if the owner had paused it, and switching it on again saved
// "Sending is on." for the same dead link, which no alert reached. The page now says what Discord answered and when,
// and keeps the switch off until a new link is saved. Rendered on the server; no network.
import { describe, it, expect, beforeAll } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UserSettings } from '../shared/types';
import { defaultPrefs } from '../worker/src/settings';

// The Settings screen reads the page's address when its modules load: a page at /settings, with nothing else.
let DeliveryPanel: ComponentType<{ s: UserSettings; save: (patch: unknown) => Promise<UserSettings> }>;
beforeAll(async () => {
  const g = globalThis as any;
  const noop = () => {};
  g.location ??= new URL('https://namada.trade/settings');
  g.history ??= { pushState: noop, replaceState: noop, state: null };
  g.window ??= g;
  g.addEventListener ??= noop;
  g.removeEventListener ??= noop;
  g.matchMedia ??= () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
  g.localStorage ??= { getItem: () => null, setItem: noop, removeItem: noop };
  DeliveryPanel = (await import('../web/src/screens/settings/index')).DeliveryPanel;
});

const AT = Date.UTC(2026, 9, 23, 8, 10);
const settings = (discord: UserSettings['channels']['discord']): UserSettings => ({ address: `tnam1q${'q'.repeat(39)}`, notifications: defaultPrefs(), channels: { discord }, createdAt: 1, updatedAt: 1 });
const masked = 'https://discord.com/api/webhooks/123456••••abcd';
const panel = (s: UserSettings) => renderToStaticMarkup(createElement(DeliveryPanel, { s, save: async () => s }));
/** The sending switch's button, as rendered. */
const switchInput = (html: string) => /<button[^>]*role="switch"[^>]*>/.exec(html)?.[0] ?? '';

describe('Security review (2026-10-22), a channel Discord said is gone: the Settings page says so', () => {
  it('a channel turned off after a 404 says what Discord answered and when, and its switch stays off and cannot be used', () => {
    const html = panel(settings({ enabled: false, hasUrl: true, webhookUrlMasked: masked, stopped: { status: 404, at: AT } }));
    expect(html).toContain('Discord said this channel link no longer exists');
    expect(html).toContain('23 Oct 2026, 08:10');
    expect(html).toContain('the link is gone (404)');
    expect(html).not.toContain('but sending is off');
    expect(html).not.toContain('pause sending without removing the link');
    expect(html).toContain('Paste a new link from Discord above to turn sending on again.');
    expect(switchInput(html)).toContain('aria-checked="false"');
    expect(switchInput(html)).toMatch(/disabled/);
  });

  it('a wrong token (401) is said as such', () => {
    const html = panel(settings({ enabled: false, hasUrl: true, webhookUrlMasked: masked, stopped: { status: 401, at: AT } }));
    expect(html).toContain('Discord said this channel link no longer works');
    expect(html).toContain('token is wrong (401)');
    expect(switchInput(html)).toMatch(/disabled/);
  });

  it('a link the connection notice did not reach when it was saved says so, with Discord\'s answer and when, and keeps its switch, which says it posts the notice again', () => {
    const html = panel(settings({ enabled: false, hasUrl: true, webhookUrlMasked: masked, stopped: { status: 503, at: AT, reason: 'notice' } }));
    expect(html).toContain('The connection notice did not reach this channel');
    expect(html).toContain('Discord answered 503');
    expect(html).toContain('23 Oct 2026, 08:10');
    expect(html).toContain('Switch sending on to post the notice again, or save the link again.');
    expect(html).toContain('Switching on posts a connection notice to the channel; sending turns on once Discord takes it.');
    expect(html).toContain('the connection notice did not reach the channel');
    expect(html).not.toContain('Discord said');
    expect(html).not.toContain('but sending is off');
    expect(switchInput(html)).toContain('aria-checked="false"');
    expect(switchInput(html)).not.toMatch(/disabled/);
    // No answer at all (status 0) is said as such.
    expect(panel(settings({ enabled: false, hasUrl: true, webhookUrlMasked: masked, stopped: { status: 0, at: AT, reason: 'notice' } }))).toContain('Discord did not answer');
    // The panel's lead says what a save does.
    expect(html).toContain('Saving a link posts a short connection notice to the channel; sending turns on once Discord takes it.');
  });

  it('a channel on whose connection notice did not reach it (a 5xx or no answer, twice) says sending is on and the first alert or a test message shows whether the link works; its switch is on and can be used', () => {
    const html = panel(settings({ enabled: true, hasUrl: true, webhookUrlMasked: masked, stopped: null, notice: { status: 503, at: AT } }));
    expect(html).toContain('The connection notice has not reached this channel yet');
    expect(html).toContain('Discord answered 503');
    expect(html).toContain('23 Oct 2026, 08:10');
    expect(html).toContain('Sending is on');
    expect(html).toMatch(/first alert[^<]*test message[^<]*whether the link works/);
    expect(html).not.toContain('Discord said');
    expect(html).not.toContain('sending is off');
    expect(switchInput(html)).toContain('aria-checked="true"');
    expect(switchInput(html)).not.toMatch(/disabled/);
    // No answer at all (status 0) is said as such; a channel the owner then paused reads as paused.
    expect(panel(settings({ enabled: true, hasUrl: true, webhookUrlMasked: masked, stopped: null, notice: { status: 0, at: AT } }))).toContain('Discord did not answer');
    const paused = panel(settings({ enabled: false, hasUrl: true, webhookUrlMasked: masked, stopped: null, notice: { status: 0, at: AT } }));
    expect(paused).toContain('but sending is off');
    expect(paused).not.toContain('has not reached this channel yet');
  });

  it('what the status line says after a save that was meant to turn sending on', async () => {
    const { savedWords } = await import('../web/src/screens/settings/delivery');
    expect(savedWords({ enabled: true, hasUrl: true, webhookUrlMasked: masked, stopped: null })).toEqual({ ok: true, text: 'Saved. A connection notice was posted to the channel, and alerts now go there.' });
    expect(savedWords({ enabled: true, hasUrl: true, webhookUrlMasked: masked, stopped: null, notice: { status: 503, at: AT } })).toEqual({ ok: true, text: 'Saved. The connection notice did not reach the channel (Discord answered 503), but sending is on: the first alert, or a test message, shows whether the link works.' });
    expect(savedWords({ enabled: true, hasUrl: true, webhookUrlMasked: masked, stopped: null, notice: { status: 0, at: AT } }).text).toContain('Discord did not answer');
    expect(savedWords({ enabled: false, hasUrl: true, webhookUrlMasked: masked, stopped: { status: 429, at: AT, reason: 'notice' } })).toEqual({ ok: false, text: 'The link was saved, but the connection notice did not reach the channel: Discord answered 429. Sending stays off; switch it on to try again.' });
    expect(savedWords({ enabled: false, hasUrl: true, webhookUrlMasked: masked, stopped: { status: 0, at: AT, reason: 'notice' } }).text).toContain('Discord did not answer');
    expect(savedWords({ enabled: false, hasUrl: true, webhookUrlMasked: masked, stopped: { status: 404, at: AT } })).toEqual({ ok: false, text: 'The link was saved, but Discord said it no longer exists (404). Sending stays off until a new link is saved.' });
    expect(savedWords({ enabled: false, hasUrl: true, webhookUrlMasked: masked, stopped: { status: 401, at: AT } }).text).toContain('its token is wrong (401)');
  });

  it('a channel its owner paused still reads as paused, with a switch that turns it on', () => {
    const html = panel(settings({ enabled: false, hasUrl: true, webhookUrlMasked: masked, stopped: null }));
    expect(html).toContain('but sending is off');
    expect(html).not.toContain('Discord said');
    expect(switchInput(html)).toContain('aria-checked="false"');
    expect(switchInput(html)).not.toMatch(/disabled/);
    const on = panel(settings({ enabled: true, hasUrl: true, webhookUrlMasked: masked }));
    expect(on).toContain('Alerts go to a Discord channel.');
    expect(switchInput(on)).toContain('aria-checked="true"');
    expect(switchInput(panel(settings({ enabled: false, hasUrl: false, webhookUrlMasked: null })))).toMatch(/disabled/);
  });
});
