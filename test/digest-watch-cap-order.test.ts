// Digest watchlists under the address cap: wallets saved later with full watchlists of made-up addresses must not
// take the cap from a wallet saved before them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import { fixtureAddress, seedCharts, seedSurvey, T } from './digest-survey';
import { sent, stubDiscord, textOf } from './digest-net';
import { alertBudget, configureAlerts, resetClaimMemory } from '../worker/src/sources/discord';
import { prepareDigests, resetDigestMemory, sendDigests } from '../worker/src/digest/deliver';
import { applyUpdate, defaultPrefs, saveSettings, type StoredSettings } from '../worker/src/settings';
import { WATCH_CAP_REASON } from '../worker/src/digest/watchlists';

const KEY = base64.encode(new Uint8Array(32).fill(59));
const OP = 'https://discord.com/api/webhooks/59/operator';
const DAY = 86_400_000;
const hook = (i: number) => `https://discord.com/api/webhooks/${5900 + i}/digest`;
function wallet(i: number, watch: string[]): StoredSettings {
  const n = defaultPrefs();
  n.dailyDigest = true;
  const at = T - 2 * DAY + i * 1000;
  const base: StoredSettings = { address: fixtureAddress('namada', 100 + i, 'qwallet'), notifications: n, channels: { discord: { enabled: true, webhookUrl: hook(i) } }, createdAt: at, updatedAt: at };
  // the watchlist goes through the Settings save's own check, as a signed-in wallet's would
  const s = applyUpdate(base, { notifications: { watchlist: watch, watchlistOn: true } });
  if (typeof s === 'string') throw new Error(s);
  return s;
}
beforeEach(() => { resetDigestMemory(); resetClaimMemory(); configureAlerts(KEY, true); stubDiscord(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the watchlist cap', () => {
  it('a wallet saved first keeps its watchlist while 100 later wallets each watch 100 made-up addresses', { timeout: 240_000 }, async () => {
    const db = testD1();
    seedSurvey(db);
    seedCharts(db);
    await saveSettings(db as any, KEY, wallet(0, [fixtureAddress('namada', 7, 'qvictim')]));
    for (let i = 1; i <= 100; i++) {
      const fake = Array.from({ length: 100 }, (_, j) => fixtureAddress('namada', i * 1000 + j, 'qfake'));
      await saveSettings(db as any, KEY, wallet(i, fake));
    }
    const cappedDays: number[] = [];
    for (let d = 0; d < 6; d++) {
      resetDigestMemory();
      sent.length = 0;
      const at = T + d * DAY;
      vi.useFakeTimers({ now: at, toFake: ['Date'] });
      const run = await prepareDigests(db as any, at, true);
      await sendDigests(db as any, OP, run, alertBudget(), []);
      vi.useRealTimers();
      const mine = sent.filter((p) => p.url === hook(0)).map(textOf).join('');
      if (mine.includes(WATCH_CAP_REASON)) cappedDays.push(d);
    }
    expect(cappedDays).toEqual([]);
  });
});
