// Security review (2026-10-22), the page after a save the channel cap refused: with every channel taken, the save of a
// link answers 409 CHANNELS_FULL and keeps the row with the link and sending off, telling the owner to turn sending on
// later. The page threw the answer away before reading the settings it carried, so it said no link was saved, kept
// the link in the field and disabled the switch; until a reload the owner could not do what the message said, and
// saving again got the same 409. A refusal that carries the saved settings now updates the page: the saved link with
// sending off and a switch that can be used. Fetch is stubbed: no request leaves.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import type { UserSettings } from '../shared/types';
import { defaultPrefs, CHANNELS_FULL } from '../worker/src/settings';

let api: typeof import('../web/src/api');
beforeAll(async () => {
  const g = globalThis as any;
  const noop = () => {};
  g.location ??= new URL('https://namada.trade/settings');
  g.window ??= g;
  g.addEventListener ??= noop;
  g.removeEventListener ??= noop;
  g.localStorage ??= { getItem: () => null, setItem: noop, removeItem: noop };
  api = await import('../web/src/api');
});
afterEach(() => { vi.unstubAllGlobals(); });

const saved: UserSettings = { address: `tnam1q${'q'.repeat(39)}`, notifications: defaultPrefs(), channels: { discord: { enabled: false, hasUrl: true, webhookUrlMasked: 'https://discord.com/api/webhooks/123456••••abcd', stopped: null } }, createdAt: 1, updatedAt: 2 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Security review (2026-10-22), a save refused by the channel cap still reaches the page', () => {
  it('updateSettings throws the refusal with the settings the server saved, and a plain error otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { error: CHANNELS_FULL, settings: saved })));
    const e = await api.updateSettings({ channels: { discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/1/x' } } }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(api.SettingsRefusedError);
    expect((e as Error).message).toBe(CHANNELS_FULL);
    expect((e as InstanceType<typeof api.SettingsRefusedError>).settings).toEqual(saved);
    expect(api.settingsOfRefusal(e)).toEqual(saved);
    // A refusal that saved nothing (the rows cap, a bad link) carries no settings: a plain error, nothing to show.
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: 'that is not a Discord webhook URL' })));
    const plain = await api.updateSettings({}).catch((err: unknown) => err);
    expect(plain).toBeInstanceOf(Error);
    expect(plain).not.toBeInstanceOf(api.SettingsRefusedError);
    expect(api.settingsOfRefusal(plain)).toBeNull();
    expect(api.settingsOfRefusal(new Error('x'))).toBeNull();
    // A save that went through answers the settings as before.
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { settings: { ...saved, channels: { discord: { ...saved.channels.discord, enabled: true } } } })));
    expect((await api.updateSettings({})).channels.discord.enabled).toBe(true);
  });
});
