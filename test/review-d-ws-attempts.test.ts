// Security review (2026-10-22): /ws upgrade attempts are counted per client address in the Worker before the one LiveHub object sees
// them. The hub's admission (ws-admit.ts) bounds open sockets only; before, every attempt, refused or accepted,
// reached the object that also runs the 6 s Namada scan.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
const worker = (await import('../worker/src/index')).default as ExportedHandler<any> & { fetch: (r: Request, e: any, c: any) => Promise<Response> };
const WRANGLER = join(__dirname, '..', 'wrangler.jsonc');

const IP = '203.0.113.7';
const upgrade = (ip = IP) => new Request('https://namada.trade/ws', { headers: { Upgrade: 'websocket', 'cf-connecting-ip': ip } });
const ctx = { waitUntil() {}, passThroughOnException() {} };
/** As the Workers binding: `allow` calls per key in the window, then refusals. */
const limiter = (allow: number) => {
  const n = new Map<string, number>();
  const keys: string[] = [];
  return { keys, async limit({ key }: { key: string }) { keys.push(key); n.set(key, (n.get(key) ?? 0) + 1); return { success: n.get(key)! <= allow }; } };
};
const envWith = (extra: Record<string, unknown>) => {
  const hub: Request[] = [];
  const env = { ...extra, LIVE: { idFromName: (s: string) => s, get: () => ({ fetch: async (r: Request) => (hub.push(r), new Response('hub')) }) } };
  return { env, hub };
};

describe('D: /ws upgrade attempts are limited per address before the live hub', () => {
  it('past the budget, attempts are answered 429 by the Worker and never reach the hub; another address keeps its own', async () => {
    const ws = limiter(3);
    const { env, hub } = envWith({ WS_LIMITER: ws });
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await worker.fetch(upgrade(), env, ctx)).status);
    expect(hub).toHaveLength(3);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3).every((c) => c === 429)).toBe(true);
    expect(new Set(ws.keys)).toEqual(new Set([`${IP}:/ws`]));
    expect((await worker.fetch(upgrade(), env, ctx)).headers.get('retry-after')).toBe('60');
    expect((await worker.fetch(upgrade('198.51.100.9'), env, ctx)).status).toBe(200);
    expect(hub).toHaveLength(4);
  });
  it('the other limiters are not spent by /ws, and /ws attempts do not spend them', async () => {
    const heavy = limiter(0), replay = limiter(0), search = limiter(0), ws = limiter(100);
    const { env, hub } = envWith({ HEAVY_LIMITER: heavy, REPLAY_LIMITER: replay, SEARCH_LIMITER: search, WS_LIMITER: ws });
    expect((await worker.fetch(upgrade(), env, ctx)).status).toBe(200);
    expect(heavy.keys.length + replay.keys.length + search.keys.length).toBe(0);
    expect(hub).toHaveLength(1);
  });
  it('a request without the upgrade header is answered 426 by the Worker and not counted', async () => {
    const ws = limiter(3);
    const { env, hub } = envWith({ WS_LIMITER: ws });
    expect((await worker.fetch(new Request('https://namada.trade/ws', { headers: { 'cf-connecting-ip': IP } }), env, ctx)).status).toBe(426);
    expect(ws.keys).toHaveLength(0);
    expect(hub).toHaveLength(0);
  });
  it('the binding is declared: 60 a minute per address and path', () => {
    const cfg = readFileSync(WRANGLER, 'utf8');
    expect(cfg).toMatch(/"name":\s*"WS_LIMITER",\s*"namespace_id":\s*"\d+",\s*"simple":\s*\{\s*"limit":\s*60,\s*"period":\s*60\s*\}/);
  });
});
