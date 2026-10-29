// The Keplr key (the KEPLR_KEY secret) reaches Keplr in the X-API-Key header only, never in a URL, and no API answer
// carries the key, a Keplr URL or what Keplr answered: a failed source's health note is in publicNote's words, the
// details go to the logs. The key here does not look like Keplr's (no keplr_ prefix), so only redaction by its value
// can mask it; the stubbed Keplr fails every way it can and echoes the key and the URL it was asked in each answer.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class { ctx: any; env: any; constructor(ctx: any, env: any) { this.ctx = ctx; this.env = env; } },
}));
import { runCron } from '../worker/src/cron';
import { app } from '../worker/src/api';
import { LiveHub } from '../worker/src/live-hub';
import { OSMOSIS } from '../worker/src/config';
import { fetchJson, HttpError, publicNote, redact, registerSecrets } from '../worker/src/util';
import { fetchOsmosisBalanceBase, fetchOsmosisHolderList, fetchOsmosisStatus, fetchOsmosisSupplyBase, searchOsmosisTxs } from '../worker/src/sources/osmosis';
import { testD1, insert, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const KEY = 'Zq7Hs0prodKey4b9e1c2d3f';
const MARK = 'KEPLR-SAID-THIS';
/** What no answer, stored row or (redacted) log line may contain. */
const LEAKS = [KEY, encodeURIComponent(KEY), 'api.keplr.app', MARK];
const leaksIn = (text: string) => LEAKS.filter((l) => text.includes(l));

interface Asked { url: string; key: string | null; upgrade: string | null }

/**
 * The network: Keplr fails each read its own way (a 403 and a 502 that quote the key and the URL, a 200 that is not
 * JSON and quotes them too); every other host answers 404, quickly.
 */
function network() {
  const asked: Asked[] = [];
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    if (!url.includes('api.keplr.app')) return new Response('not here', { status: 404 });
    asked.push({ url, key: h.get('x-api-key'), upgrade: h.get('upgrade') });
    const echo = `${MARK}: key ${h.get('x-api-key')} at ${url}`;
    if (url.includes('denom_owners')) return new Response(`<html>${echo}</html>`, { status: 200 });
    if (url.includes('supply/by_denom') || url.includes('tx_search')) return new Response(JSON.stringify({ error: echo }), { status: 502 });
    return new Response(JSON.stringify({ error: echo }), { status: 403 });
  });
  vi.stubGlobal('fetch', f);
  return asked;
}

/** One cron tick in virtual time (its retries and phase deadlines would otherwise take real seconds). */
async function tick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false;
  let err: unknown = null;
  runCron(env).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}

/** Every text value of every table: what a later answer could be built from. */
function everyRow(db: TestD1): string {
  const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
  return tables.map((t) => JSON.stringify(db.raw.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

// The API's GET routes with no path parameter, and one with: every answer the site gives without signing in.
const ROUTES = [
  '/api/overview', '/api/pressure', '/api/blindspot', '/api/orderflow', '/api/alerts/rules', '/api/alerts/recent',
  '/api/holders', '/api/holders?chain=osmosis', '/api/flows', '/api/pools', '/api/quote', '/api/quote/curve',
  '/api/address/osmo1zzz', '/api/intel', '/api/search?q=osmo', '/api/auth/me', '/api/me/settings', '/api/me/sessions',
  '/api/me/export', '/api/donation', '/api/export/holders', '/api/export/flows', '/api/integrity',
  '/api/metrics/history?key=supply.osmosis',
];
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as any;

async function everyAnswer(env: any): Promise<string> {
  const out: string[] = [];
  for (const r of ROUTES) {
    const res = await app.request(r, {}, env, ctx);
    out.push(`${r} ${res.status} ${await res.text()}`);
  }
  return out.join('\n');
}

const SYNC = Date.parse('2026-10-17T22:40:05Z'); // a 10-minute holder sync: the holder list and the supply are read

describe('the Keplr key never reaches a client', () => {
  it('a cron tick against a failing Keplr: the key went in the header only, and no answer or stored row has it, a Keplr URL or what Keplr said', async () => {
    const db = testD1();
    insert(db, 'holders', [{ chain: 'osmosis', address: 'osmo1zzz', balance: '5000000', balance_num: 5, updated_at: SYNC - 600000, verified_at: SYNC - 600000 }]);
    const asked = network();
    const logged: string[] = [];
    for (const m of ['error', 'warn', 'log'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    await tick({ DB: db, KEPLR_KEY: KEY }, SYNC);

    // Keplr was asked (the holder list and the supply), always with the key in its header and never in the URL.
    expect(asked.some((a) => a.url.includes('denom_owners'))).toBe(true);
    expect(asked.some((a) => a.url.includes('supply/by_denom'))).toBe(true);
    for (const a of asked) {
      expect(a.url).not.toContain(KEY);
      expect(a.key).toBe(KEY);
    }

    // The failures are recorded, in words safe to publish.
    const health = JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get().value);
    expect(health['Keplr Osmosis REST (supply)']).toMatchObject({ ok: false, note: 'Error: upstream unavailable (HTTP 502)' });
    expect(health['Keplr Osmosis REST (holders)'].ok).toBe(false);
    expect(health['Keplr Osmosis REST (holders)'].note).toMatch(/upstream sent an answer that is not JSON/);
    expect(leaksIn(everyRow(db))).toEqual([]);

    // The details are in the logs, without the key.
    expect(logged.some((l) => l.includes('Keplr Osmosis REST (supply)') && l.includes('HTTP 502'))).toBe(true);
    expect(logged.filter((l) => l.includes(KEY))).toEqual([]);

    // No answer carries any of it: /api/overview, /api/integrity, and every other route.
    const overview = await (await app.request('/api/overview', {}, { DB: db, KEPLR_KEY: KEY } as any, ctx)).json() as any;
    expect(overview.sources.find((s: any) => s.name === 'Keplr Osmosis REST (supply)')).toMatchObject({ ok: false, note: 'Error: upstream unavailable (HTTP 502)' });
    expect(leaksIn(await everyAnswer({ DB: db, KEPLR_KEY: KEY }))).toEqual([]);
  });

  it('a note stored before the fix (the key in the URL, its query and Keplr\'s answer) is served without any of it', async () => {
    registerSecrets(KEY);
    const db = testD1();
    const old = `Error: HTTP 403 for https://api.keplr.app/rest/osmosis/${KEY}/cosmos/bank/v1beta1/supply/by_denom?denom=ibc%2FX: {"error":"${MARK} ${KEY}"}`;
    // and one cut at 160 characters, mid-key
    const cut = `Error: deadline passed before https://api.keplr.app/rest/osmosis/${KEY.slice(0, 9)}`;
    insert(db, 'kv', [{ key: 'source.health', value: JSON.stringify({
      a: { name: 'Keplr Osmosis REST (supply)', ok: false, at: 1, note: old },
      b: { name: 'Keplr Osmosis REST (holders)', ok: false, at: 1, note: cut },
      c: { name: 'Namada RPC', ok: true, at: 1 },
    }), updated_at: 1 }]);
    const env = { DB: db, KEPLR_KEY: KEY } as any;
    for (const path of ['/api/overview', '/api/integrity']) {
      const text = await (await app.request(path, {}, env, ctx)).text();
      expect(leaksIn(text), path).toEqual([]);
      expect(text).not.toContain(KEY.slice(0, 9));
      const sources = JSON.parse(text).sources as any[];
      expect(sources.find((s) => s.name === 'Keplr Osmosis REST (supply)').note).toBe('Error: upstream unavailable (HTTP 403)');
      expect(sources.find((s) => s.name === 'Keplr Osmosis REST (holders)').note).toBe('Error: deadline passed before upstream');
      expect(sources.find((s) => s.name === 'Namada RPC')).toEqual({ name: 'Namada RPC', ok: true, at: 1 });
    }
  });

  it('every Keplr read sends the key as a header, and its errors (for the logs) name the URL without its query and mask the key', async () => {
    registerSecrets(KEY);
    const asked = network();
    const errs: unknown[] = [];
    const fast = { timeoutMs: 1000, retries: 0 };
    for (const read of [
      () => fetchOsmosisHolderList(KEY, 1, fast),
      () => fetchOsmosisSupplyBase(KEY, fast),
      () => fetchOsmosisStatus(KEY),
      () => searchOsmosisTxs(KEY, "message.sender='osmo1zzz'", 1, 50),
    ]) await read().then(() => errs.push(null), (e) => errs.push(e));
    // The balance read falls back to Osmosis's public REST (404 here): its error is its own words.
    await fetchOsmosisBalanceBase(KEY, 'osmo1zzz', fast).then(() => errs.push(null), (e) => errs.push(e));
    expect(errs.every((e) => e instanceof Error)).toBe(true);
    for (const e of errs) {
      const all = `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack ?? ''}`;
      expect(all).not.toContain(KEY);
      // The URL the worker asked, as its own words name it: no query (Keplr's answer after it quotes its own).
      const asked = /HTTP \d{3} for (\S+): /.exec(String(e))?.[1];
      if (asked) expect(asked).not.toContain('?');
    }
    expect(errs.filter((e) => /HTTP \d{3} for /.test(String(e))).length).toBeGreaterThanOrEqual(3);
    expect(asked.length).toBeGreaterThanOrEqual(5);
    for (const a of asked) {
      expect(a.url.startsWith(OSMOSIS.keplrRest) || a.url.startsWith(OSMOSIS.keplrRpc)).toBe(true);
      expect(a.url).not.toContain(KEY);
      expect(a.key).toBe(KEY);
    }
  });

  it('the live hub opens Keplr\'s socket with the key in a header, and its catch-up search reads Keplr the same way', async () => {
    const asked = network();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const db = testD1();
    const ctx: any = { blockConcurrencyWhile: (f: () => Promise<unknown>) => f(), storage: { getAlarm: async () => 1, setAlarm: async () => {} } };
    const hub = new LiveHub(ctx, { DB: db, KEPLR_KEY: KEY } as any) as any;
    hub.ensureOsmosisWs();
    await vi.waitFor(() => expect(asked.some((a) => a.upgrade === 'websocket')).toBe(true));
    const ws = asked.find((a) => a.upgrade === 'websocket')!;
    expect(ws).toEqual({ url: OSMOSIS.keplrWs, key: KEY, upgrade: 'websocket' });
    // A refused upgrade (a 403, no socket) is retried later, not held open.
    await vi.waitFor(() => expect(hub.isConnectingOsmo).toBe(false));

    // The search asks the public node first (404 here), then Keplr, with the key in the header.
    await hub.sweepOsmosis().catch(() => {});
    const reads = asked.filter((a) => a.upgrade == null);
    expect(reads.length).toBeGreaterThan(0);
    for (const a of reads) {
      expect(a.url.startsWith(OSMOSIS.keplrRpc)).toBe(true);
      expect(a.url).not.toContain(KEY);
      expect(a.key).toBe(KEY);
    }
  });

  it('redaction is by the value: any key form is masked, a placeholder too short to be one is not', () => {
    registerSecrets(KEY, 'k');
    expect(redact(`x ${KEY} y ${encodeURIComponent(KEY)}`)).toBe('x *** y ***');
    expect(redact('a k b')).toBe('a k b');
    const e = new HttpError(401, `${OSMOSIS.keplrRest}/x?denom=1&key=${KEY}`, `bad key ${KEY}`);
    expect(e.message).toBe(`HTTP 401 for ${OSMOSIS.keplrRest}/x: bad key ***`);
    expect(e.url).toBe(`${OSMOSIS.keplrRest}/x`);
    expect(publicNote(String(e))).toBe('Error: upstream unavailable (HTTP 401)');
    expect(publicNote('SyntaxError: Unexpected token \'<\', "<html>KEPLR"... is not valid JSON')).toBe('upstream sent an answer that is not JSON');
    expect(publicNote('the holder list stopped at page 3')).toBe('the holder list stopped at page 3');
  });

  it('fetchJson\'s final error masks the key in a network error\'s own text', async () => {
    registerSecrets(KEY);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(`network lost for ${KEY}`); }));
    await expect(fetchJson(`${OSMOSIS.keplrRest}/status?k=${KEY}`, { retries: 0 })).rejects.toThrow('network lost for ***');
  });
});
