import { describe, it, expect } from 'vitest';
import { applyUpdate, defaultPrefs, inQuietHours, thresholdsOf, type StoredSettings } from '../worker/src/settings';
import { evaluateFlow } from '../shared/alerts';
import type { Flow } from '../shared/types';

const base = (): StoredSettings => ({ address: 'tnam1qtest', notifications: defaultPrefs(), channels: { discord: { enabled: false, webhookUrl: null } }, createdAt: 0, updatedAt: 0 });
const sell = (amount: number): Flow => ({ id: 'osmosis:X:0', chain: 'osmosis', height: 1, ts: Date.UTC(2026, 9, 16, 3), txHash: 'X', kind: 'sell', from: 'osmo1seller', to: null, amount, meta: null });

describe('per-user settings', () => {
  it('disabled rules never fire; enabled rules use the user threshold', () => {
    const s = base();
    s.notifications.rules.big_swap = { on: true, thresholdNam: 500 };
    expect(evaluateFlow(sell(600), thresholdsOf(s.notifications)).map((h) => h.ruleId)).toEqual(['big_swap']);
    s.notifications.rules.big_swap.on = false;
    expect(evaluateFlow(sell(1e9), thresholdsOf(s.notifications))).toEqual([]);
  });

  it('quiet hours wrap around midnight (UTC)', () => {
    const p = defaultPrefs();
    p.quietHoursUtc = { start: 22, end: 7 };
    expect(inQuietHours(p, Date.UTC(2026, 9, 16, 3))).toBe(true);
    expect(inQuietHours(p, Date.UTC(2026, 9, 16, 12))).toBe(false);
    p.quietHoursUtc = { start: 9, end: 17 };
    expect(inQuietHours(p, Date.UTC(2026, 9, 16, 12))).toBe(true);
  });

  it('validates updates and never enables Discord without a URL', () => {
    const s = base();
    expect(applyUpdate(s, { channels: { discord: { webhookUrl: 'https://evil.example/x' } } })).toMatch(/not a Discord webhook/);
    const ok = applyUpdate(s, { channels: { discord: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/123/abc_DEF-9' } }, notifications: { watchlist: ['tnam1qrk5pyvtzxjmykcqmhglssshdjf3njac2qvqmlse', 'bogus', 'osmo1mpgtkc7aym9f3k8ll7hahtu7rvpdjc95e6m5tg'], quietHoursUtc: { start: 22, end: 7 } } });
    expect(typeof ok).not.toBe('string');
    const n = ok as StoredSettings;
    expect(n.channels.discord.enabled).toBe(true);
    expect(n.notifications.watchlist).toHaveLength(2);
    const off = applyUpdate(n, { channels: { discord: { webhookUrl: '' } } }) as StoredSettings;
    expect(off.channels.discord.webhookUrl).toBeNull();
    expect(off.channels.discord.enabled).toBe(false);
  });
});
