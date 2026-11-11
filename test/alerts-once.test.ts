// The newest alerts are asked for once as a page loads (review item 6; owner, 2026-11-11: "Lets go ahead"). The
// shell (the count of new alerts) and Home (what changed) both ask for them at the same address in the same moment;
// the second asker takes the first one's answer instead of sending the request again.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const answer = () => new Response(JSON.stringify({ since: 0, until: 0, hits: [{ ts: 5 }, { ts: 9 }], last: null }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('the newest alerts, asked for once', () => {
  let calls: string[];
  beforeEach(() => {
    calls = [];
    vi.resetModules();
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 11, 2, 0), toFake: ['Date'] });
    const g = globalThis as any;
    g.location ??= new URL('https://namada.trade/');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { calls.push(String(input)); return answer(); }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('two askers of one address in the same moment send one request, and each gets its own answer', async () => {
    const { fetchAlertsRecent } = await import('../web/src/api');
    const [home, shell] = await Promise.all([fetchAlertsRecent(null), fetchAlertsRecent(null, Date.now() - 3_600_000)]);
    expect(calls.filter((u) => u.includes('/api/alerts/recent'))).toHaveLength(1);
    expect(home.hits).toHaveLength(2);
    // the shell narrows its copy to its own last visit; Home's answer is not touched by that
    expect(shell.hits.every((h: { ts: number }) => h.ts >= shell.since)).toBe(true);
    expect(home.hits).toHaveLength(2);
  });

  it('a refresh after the shared moment asks again, and another address is another request', async () => {
    const { fetchAlertsRecent, ALERTS_SHARE_MS } = await import('../web/src/api');
    await fetchAlertsRecent(null);
    vi.setSystemTime(Date.now() + ALERTS_SHARE_MS);
    await fetchAlertsRecent(null);
    expect(calls.filter((u) => u.includes('/api/alerts/recent'))).toHaveLength(2);
    // a wider window is another address
    await fetchAlertsRecent(null, Date.now() - 5 * 86_400_000);
    expect(calls.filter((u) => u.includes('/api/alerts/recent'))).toHaveLength(3);
    expect(calls[2]).toContain('days=');
  });

  it('a request that failed is not kept: the next asker tries again', async () => {
    const { fetchAlertsRecent } = await import('../web/src/api');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response('x', { status: 503 }); }));
    await expect(fetchAlertsRecent(null)).rejects.toBeTruthy();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => { calls.push(String(input)); return answer(); }));
    const again = await fetchAlertsRecent(null);
    expect(again.hits).toHaveLength(2);
    expect(calls.filter((u) => u.includes('/api/alerts/recent')).length).toBeGreaterThanOrEqual(2);
  });
});
