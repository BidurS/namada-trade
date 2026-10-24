// Daily digest, a slow Discord under the run's deadline: the channels a run claims and cannot post before its deadline
// (or its window, or its posts) are given back and posted by a later run, so every subscriber gets the day's digest
// once. Discord is stubbed so that each post moves the clock on as six 500 ms posts in flight would; the digest starts
// 8 s into each run, after the intel read. The survey's stored rows are seeded; the wallets are fixture-shaped; fetch
// is stubbed before anything could post, so nothing reaches Discord.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64 } from '@scure/base';
import { testD1, type TestD1 } from './d1-sqlite';
import { fixtureAddress, seedCharts, seedSurvey, T } from './digest-survey';
import { kvKeys, sent, stubDiscord, titlesOf } from './digest-net';
import { alertBudget, configureAlerts, resetClaimMemory, POST_CONCURRENCY, POST_PACE_MS, RUN_ALERT_DEADLINE_MS } from '../worker/src/sources/discord';
import { prepareDigests, resetDigestMemory, sendDigests } from '../worker/src/digest/deliver';
import { defaultPrefs, saveSettings, type StoredSettings } from '../worker/src/settings';
import type { SourceHealth } from '../shared/types';

const KEY = base64.encode(new Uint8Array(32).fill(47));
const OP = 'https://discord.com/api/webhooks/47/operator';
const hook = (i: number) => `https://discord.com/api/webhooks/${4700 + i}/digest`;
const MIN = 60_000, H = 60 * MIN, DAY = 24 * H;

function wallet(i: number): StoredSettings {
  const n = defaultPrefs();
  n.dailyDigest = true;
  const at = T - DAY + i;
  return { address: fixtureAddress('namada', 300 + i, 'qslow'), notifications: n, channels: { discord: { enabled: true, webhookUrl: hook(i) } }, createdAt: at, updatedAt: at };
}

function seeded(): TestD1 {
  const db = testD1();
  seedSurvey(db);
  seedCharts(db);
  return db;
}

beforeEach(() => {
  resetDigestMemory();
  resetClaimMemory();
  configureAlerts(KEY, true);
  vi.useFakeTimers({ now: T, toFake: ['Date'] });
});
/** Each post moves the clock on by `slow` times a sixth of POST_PACE_MS: six in flight, each answered in `slow` × POST_PACE_MS. */
const slowDiscord = (slow: number) => stubDiscord(() => { vi.setSystemTime(Date.now() + (slow * POST_PACE_MS) / POST_CONCURRENCY); return new Response(null, { status: 204 }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the digest under a slow Discord and the run\'s deadline', () => {
  it.each([
    ['as fast as the pace the run assumes', 1, 8_000],
    ['twice as slow as the pace the run assumes', 2, 8_000],
    ['three times as slow, the digest starting 40 s into the run', 3, 40_000],
  ])('300 subscribers, Discord %s: the channels a run cannot post are given back and the later runs post them, each once', { timeout: 240_000 }, async (_, slow, startAfter) => {
    slowDiscord(slow);
    const db = seeded();
    for (let i = 0; i < 300; i++) await saveSettings(db as any, KEY, wallet(i));
    const got = () => new Set(sent.filter((p) => p.url !== OP && titlesOf(p)[0]?.startsWith('NAM daily digest')).map((p) => p.url)).size;
    for (let k = 0; k < 40 && got() < 300; k++) {
      const at = T + k * MIN;
      vi.setSystemTime(at);
      const budget = alertBudget(at);
      const run = await prepareDigests(db as any, at, true);
      for (const j of run.jobs) await j.build;
      vi.setSystemTime(at + startAfter);
      const health: SourceHealth[] = [];
      await sendDigests(db as any, OP, run, budget, health);
      // no subscriber's digest starts at or after the run's deadline
      expect(sent.filter((p) => p.url !== OP && titlesOf(p)[0]?.startsWith('NAM daily digest') && p.at >= at + RUN_ALERT_DEADLINE_MS && p.at < at + MIN)).toEqual([]);
    }
    const firsts = (url: string) => sent.filter((p) => p.url === url && titlesOf(p)[0]?.startsWith('NAM daily digest'));
    const missing = Array.from({ length: 300 }, (_, i) => i).filter((i) => firsts(hook(i)).length !== 1);
    expect(missing).toEqual([]);
    expect(firsts(OP)).toHaveLength(1);
    // every channel claim taken is a channel posted: the operator's and the 300 subscribers'
    const claims = kvKeys(db, 'alert:digest:daily:%:%');
    expect(claims).toHaveLength(301);
  });
});
