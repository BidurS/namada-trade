// A rule added after a subscriber saved their settings (the sixth, a shielded exit sent over the bridge, 2026-10-30):
// worker/src/settings.ts withEveryRule gives it an entry, off at the site's size, so Settings lists it with a switch
// and the save reads a size for it; thresholdsOf keeps it from firing until it is turned on. A new subscriber's
// defaults have it on.
import { describe, it, expect } from 'vitest';
import { applyUpdate, defaultPrefs, loadSettings, saveSettings, thresholdsOf, withEveryRule, type StoredSettings } from '../worker/src/settings';
import { testD1 } from './d1-sqlite';
import { base64 } from '@scure/base';
import { DEFAULT_THRESHOLDS } from '../shared/alerts';

const saved = (): StoredSettings => {
  const p = defaultPrefs();
  delete (p.rules as Record<string, unknown>).exit_bridge;
  return { address: 'tnam1qxuser00000000000000000000000000000000', notifications: p, channels: { discord: { enabled: false, webhookUrl: null } }, createdAt: 0, updatedAt: 0 };
};

describe('a rule the saved settings do not have yet', () => {
  it('is filled in off, at the site’s size, and fires nothing until turned on; the rules a subscriber had stay as they were', () => {
    const s = withEveryRule(saved());
    expect(s.notifications.rules.exit_bridge).toEqual({ on: false, thresholdNam: DEFAULT_THRESHOLDS.exitBridge });
    expect(s.notifications.rules.big_swap).toEqual(defaultPrefs().rules.big_swap);
    expect(thresholdsOf(s.notifications).exitBridge).toBe(Number.MAX_SAFE_INTEGER);
    const on = applyUpdate(s, { notifications: { rules: { exit_bridge: { on: true, thresholdNam: 250_000 } } } });
    expect(typeof on).not.toBe('string');
    expect(thresholdsOf((on as StoredSettings).notifications).exitBridge).toBe(250_000);
    // a save that names the rule with no size takes the site's
    const bare = applyUpdate(saved(), { notifications: { rules: { exit_bridge: { on: true, thresholdNam: NaN } } } });
    expect((bare as StoredSettings).notifications.rules.exit_bridge).toEqual({ on: true, thresholdNam: DEFAULT_THRESHOLDS.exitBridge });
  });
  it('settings saved without the rule come back from the store with it, off (review of 2026-10-30: the read, not only the function)', async () => {
    const db = testD1();
    const key = base64.encode(new Uint8Array(32).fill(7));
    expect(await saveSettings(db as any, key, saved())).toBe(true);
    const back = await loadSettings(db as any, key, saved().address);
    expect(back!.notifications.rules.exit_bridge).toEqual({ on: false, thresholdNam: DEFAULT_THRESHOLDS.exitBridge });
  });
  it('settings that have every rule come back as they were; a new subscriber has the sixth rule on', () => {
    const full = { ...saved(), notifications: defaultPrefs() };
    expect(withEveryRule(full)).toBe(full);
    expect(defaultPrefs().rules.exit_bridge).toEqual({ on: true, thresholdNam: 100_000 });
  });
});
