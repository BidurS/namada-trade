// Security review (2026-10-22), alerts from a copy of the production database: a local `wrangler dev` run on a
// production export (the README's real-data workflow) started the one LiveHub, whose scan and catch-up search found
// every move production had already posted since the export. The once-only claims live in the bound database, and the
// copy had none of production's later ones, so each move was posted again: to the operator channel, and to every
// copied user webhook the local SETTINGS_KEY could decrypt, including ones their owners had since deleted in
// production, saying "The live feed missed this move". Only a Worker whose SEND_ALERTS secret is 'yes' (production
// alone) now posts at all; any other run posts nothing, never reads the users' settings, and records what it did not
// send. scripts/deploy-check.sh does not deploy a Worker that lacks the secret.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { base64 } from '@scure/base';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
// The cron itself is not run here (it would read every producer); only its entry's setup is.
vi.mock('../worker/src/cron', () => ({ runCron: vi.fn(async () => {}) }));
import { testD1, insert, type TestD1 } from './d1-sqlite';
import { LiveHub } from '../worker/src/live-hub';
import worker from '../worker/src/index';
import { sendDiscordForumAlert, sendDiscordTestAlert, sendsAlerts } from '../worker/src/sources/discord';
import { saveSettings, deleteSettings, defaultPrefs, type StoredSettings } from '../worker/src/settings';
import type { Flow, ForumPost } from '../shared/types';

const KEY = base64.encode(new Uint8Array(32).fill(9));
const OP = 'https://discord.com/api/webhooks/1/op';
const U = 'https://discord.com/api/webhooks/2/user';
const A = 'tnam1qcopy' + 'q'.repeat(35);

let posts: { url: string; body: any }[] = [];
const stub = () => {
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (u: any, init?: RequestInit) => {
    const url = String(u);
    if (url.startsWith('https://discord.com/')) { posts.push({ url, body: JSON.parse(String(init?.body ?? '{}')) }); return new Response(null, { status: 204 }); }
    return new Response('offline', { status: 404 });
  }));
};
afterEach(() => vi.unstubAllGlobals());

const whale = (id: string, via?: string): Flow => ({
  id, chain: 'osmosis', height: 1, ts: Date.now(), txHash: id.split(':')[1], kind: 'sell',
  from: 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3', to: null, amount: 60000, meta: via ? { via } : null,
} as any);

const user = (): StoredSettings => {
  const notifications = defaultPrefs();
  notifications.rules.big_swap = { on: true, thresholdNam: 1 };
  notifications.forumAndGov = true;
  return { address: A, notifications, channels: { discord: { enabled: true, webhookUrl: U } }, createdAt: Date.now(), updatedAt: Date.now() };
};

/** Production's database with one user's settings, and an export of it taken then. */
async function prodAndCopy() {
  const prod = testD1();
  await saveSettings(prod as any, KEY, user());
  const copy = testD1();
  insert(copy, 'kv', prod.raw.prepare('SELECT * FROM kv').all());
  return { prod, copy };
}

/** The LiveHub as the runtime makes it (its real constructor), for a run whose secrets are `env`. */
async function hubFor(db: TestD1, env: Record<string, string>, Hub: typeof LiveHub = LiveHub) {
  const ctx: any = { blockConcurrencyWhile: (f: () => Promise<unknown>) => f(), storage: { getAlarm: async () => 1, setAlarm: async () => {} } };
  const hub = new Hub(ctx, { DB: db, DISCORD_WEBHOOK_URL: OP, SETTINGS_KEY: KEY, ...env } as any) as any;
  await new Promise((r) => setTimeout(r, 10));
  return hub as { alertFlows(flows: Flow[]): Promise<void> };
}

const skipped = (db: TestD1) => {
  const v = (db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get() as any)?.value;
  return v ? JSON.parse(v) : null;
};
/** The SQL a database is asked, from now on. */
const asked = (db: TestD1) => {
  const sql: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (q: string) => (sql.push(q), prepare(q));
  return sql;
};

describe('alerts from a copy of the production database', () => {
  it('a local run (no SEND_ALERTS) on the copy posts nothing, reads no user settings, and records what it did not send', async () => {
    stub();
    const { prod, copy } = await prodAndCopy();
    // Production posts the move, then the user deletes everything.
    const live = await hubFor(prod, { SEND_ALERTS: 'yes' });
    await live.alertFlows([whale('osmosis:CP1:0')]);
    expect(new Set(posts.map((p) => p.url))).toEqual(new Set([OP, U]));
    await deleteSettings(prod as any, A);

    // The local run on the export finds the same move late, in an isolate of its own.
    posts = [];
    vi.resetModules();
    const local = await hubFor(copy, {}, (await import('../worker/src/live-hub')).LiveHub);
    const sql = asked(copy);
    await local.alertFlows([whale('osmosis:CP1:0', 'catch-up search')]);
    expect(posts).toEqual([]);
    expect(sql.some((q) => q.includes("'user:'"))).toBe(false);
    const s = skipped(copy);
    expect(s.last.n).toBe(1); // the operator's channel only: the copied user row was never matched
    expect(s.last.what).toContain('SEND_ALERTS is not yes');
  });

  it('production (SEND_ALERTS is yes) posts as before: each channel once, and a second offer of the move posts nothing', async () => {
    stub();
    const { prod } = await prodAndCopy();
    const live = await hubFor(prod, { SEND_ALERTS: 'yes' });
    await live.alertFlows([whale('osmosis:CP2:0')]);
    expect(posts.map((p) => p.url).sort()).toEqual([OP, U].sort());
    await live.alertFlows([whale('osmosis:CP2:0', 'catch-up search')]);
    expect(posts).toHaveLength(2);
    expect(skipped(prod)).toBeNull();
  });

  it('every entry sets it again: a run without the secret after one with it in the same isolate posts nothing', async () => {
    stub();
    const { prod, copy } = await prodAndCopy();
    await hubFor(prod, { SEND_ALERTS: 'yes' });
    const local = await hubFor(copy, { SEND_ALERTS: 'true' });
    await local.alertFlows([whale('osmosis:CP3:0')]);
    expect(posts).toEqual([]);
  });

  it("the Worker's fetch and scheduled entries: no forum post and no Settings test post without the secret", async () => {
    stub();
    const { copy } = await prodAndCopy();
    const env = { DB: copy, DISCORD_WEBHOOK_URL: OP, SETTINGS_KEY: KEY } as any;
    const post: ForumPost = { id: 77, topicId: 1, topicTitle: 't', topicSlug: 't', postNumber: 2, url: 'https://forum.namada.net/t/t/1/2', username: 'u', displayName: null, avatarUrl: null, createdAt: new Date().toISOString(), excerpt: 'x', isNewTopic: false };
    const ctx = { waitUntil() {}, passThroughOnException() {} } as any;

    await worker.scheduled!({} as any, env, ctx);
    await sendDiscordForumAlert(env.DISCORD_WEBHOOK_URL, post, copy as any);
    expect(posts).toEqual([]);

    await worker.fetch!(new Request('http://localhost:8787/robots.txt') as any, env, ctx);
    expect(await sendDiscordTestAlert(U, user())).toBe(false);
    expect(posts).toEqual([]);

    // The same entries with the secret post again.
    await worker.fetch!(new Request('http://localhost:8787/robots.txt') as any, { ...env, SEND_ALERTS: 'yes' }, ctx);
    expect(await sendDiscordTestAlert(U, user())).toBe(true);
    expect(posts.map((p) => p.url)).toEqual([U]);
  });

  it("only the exact value 'yes' sends", () => {
    expect(sendsAlerts({ SEND_ALERTS: 'yes' })).toBe(true);
    for (const v of [undefined, '', 'no', 'true', '1', 'YES', ' yes']) expect(sendsAlerts({ SEND_ALERTS: v })).toBe(false);
  });

  it('wrangler.jsonc gives no run the secret: it is not a plain var', () => {
    const cfg = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
    expect(cfg).not.toMatch(/"SEND_ALERTS"/);
  });

  it('deploy-check.sh refuses to deploy without the secret, before anything remote changes', () => {
    const script = readFileSync(join(__dirname, '..', 'scripts', 'deploy-check.sh'), 'utf8');
    const at = script.indexOf('wrangler secret list --format json');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(script.indexOf('migrations apply'));
    const m = script.slice(at).match(/python3 -c "\n([\s\S]*?)" \|\| \{ echo "FAIL SEND_ALERTS/);
    expect(m).not.toBeNull();
    const run = (stdin: string) => {
      try { execFileSync('python3', ['-c', m![1]], { input: stdin, stdio: ['pipe', 'pipe', 'pipe'] }); return 0; } catch (e: any) { return e.status as number; }
    };
    const list = (...names: string[]) => JSON.stringify(names.map((name) => ({ name, type: 'secret_text' })), null, 2);
    expect(run(list('DISCORD_WEBHOOK_URL', 'KEPLR_KEY', 'SETTINGS_KEY'))).toBe(1);
    expect(run(`▲ [WARNING] a note\n${list('SEND_ALERTS', 'SETTINGS_KEY')}`)).toBe(0);
    expect(run('✘ [ERROR] Authentication error [code: 10000]\n')).toBe(1);
  });
});
