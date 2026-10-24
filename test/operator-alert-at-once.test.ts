// Security review (2026-10-22), the operator's forum and governance alerts: a cron run admits a forum or governance
// alert only when all its posts fit what is left of the run's RUN_ALERT_POSTS, and the operator's post was counted in
// the alert and waited with it. From about 300 subscribers with forum and governance alerts on, each run sent one
// alert and every other alert waited, the operator's post with it, so a governance epoch that changed five proposals
// reached the operator over five minutes. The operator's post now goes at once, under a claim of its own, whatever
// the run's budget; only the subscribers' posts wait for a later run, and the operator is never posted twice. Fetch
// is stubbed: nothing reaches Discord.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { base64 } from '@scure/base';
import { testD1 } from './d1-sqlite';
import { configureAlerts, sendDiscordGovAlert, alertBudget } from '../worker/src/sources/discord';
import { saveSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import type { GovernanceProposal } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); });

const KEY = base64.encode(new Uint8Array(32).fill(13));
const OP = 'https://discord.com/api/webhooks/990/operator';
const proposal = (id: number, status: string): GovernanceProposal => ({ id, title: 'p', authors: null, abstract: null, type: 'default', status, startEpoch: 1, endEpoch: 2, activationEpoch: 3, yayNam: 0, nayNam: 0, abstainNam: 0, discussionsUrl: null } as GovernanceProposal);

describe('Security review (2026-10-22), the operator\'s forum and governance alerts do not wait behind subscribers', () => {
  it('with 500 forum and governance subscribers, five proposal changes reach the operator in the first run; their subscribers hear them over the next runs', { timeout: 60_000 }, async () => {
    const db = testD1();
    configureAlerts(KEY);
    const now = Date.now();
    for (let i = 0; i < 500; i++) {
      const p = defaultPrefs();
      p.forumAndGov = true;
      const s: StoredSettings = { address: `tnam1qgov${String(i).padStart(5, '0')}${'q'.repeat(31)}`, notifications: p, channels: { discord: { enabled: true, webhookUrl: `https://discord.com/api/webhooks/${7000 + i}/gov` } }, createdAt: now, updatedAt: now };
      await saveSettings(db as any, KEY, s);
    }
    const posts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { posts.push(String(u)); return new Response(null, { status: 204 }); }));
    const ops = () => posts.filter((u) => u === OP).length;
    // Each run offers every proposal still to send, as the cron does (cron.ts syncIntelAndAlerts).
    let pending = [1, 2, 3, 4, 5].map((id) => proposal(880600 + id, 'passed'));
    const run = async () => {
      const budget = alertBudget();
      const left: GovernanceProposal[] = [];
      for (const prop of pending) if ((await sendDiscordGovAlert(OP, prop, false, db as any, budget)) === 'waiting') left.push(prop);
      pending = left;
    };
    await run();
    expect(ops()).toBe(5);
    expect(pending).toHaveLength(4);
    for (let r = 0; r < 4; r++) await run();
    expect(pending).toHaveLength(0);
    expect(ops()).toBe(5);
    expect(posts.length).toBe(5 + 5 * 500);
  });
});
