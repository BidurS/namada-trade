// Review 2, second worker round (2026-10-18): each block names the finding it guards. The cron's hung-source cases
// are in test/cron-hang.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, csvCell, holderFiguresProv, FULL_SESSION_ONLY } from '../worker/src/api';
import { testD1, insert } from './d1-sqlite';
import { pressure } from '../worker/src/analytics';
import { CACHE_PARAMS, CACHEABLE_API } from '../worker/src/http';
import { createSession, createPairCode, claimPairCode, pairKey, sessionFromRequest, listSessions, sweepAuth, MAX_SESSIONS, MAX_API_KEYS, type Session } from '../worker/src/auth';
import { sendDiscordTestAlert, WEBHOOK_TIMEOUT_MS } from '../worker/src/sources/discord';
import { onePerCrossing, counterpartiesOf } from '../shared/flow-rules';
import { tagByline, labelAuthorShort } from '../shared/labels';
import { DEFAULT_THRESHOLDS } from '../shared/alerts';
import type { AddressReport, Flow, FlowsResponse, Overview } from '../shared/types';

const H = 3600000, D = 86400000, M = 60000;
const NOW = Date.now();
const env = (db: ReturnType<typeof testD1>) => ({ DB: db } as any);
const MASP = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah';
afterEach(() => vi.unstubAllGlobals());

// ------------------------------------------------------------------ data/holder-figures-freshness-mismatch
describe('holder figures carry the age of the balances behind them', () => {
  it('the overview sends one stamp per chain: the oldest top-10 reading, old past 6 hours', async () => {
    const db = testD1();
    insert(db, 'holders', [
      { chain: 'namada', address: 'tnam1qa', balance: '1', balance_num: 900, updated_at: NOW - 67 * H, verified_at: NOW - 67 * H },
      { chain: 'namada', address: 'tnam1qb', balance: '1', balance_num: 50, updated_at: NOW - M, verified_at: NOW - M },
      { chain: 'osmosis', address: 'osmo1a', balance: '1', balance_num: 5, updated_at: NOW - 5 * M, verified_at: NOW - 5 * M },
    ]);
    insert(db, 'metrics', [{ ts: NOW - 2 * M, key: 'supply.total', value: 1000 }, { ts: NOW - 2 * M, key: 'supply.osmosis', value: 10 }]);
    // rewound, so no live price is fetched; the holder stamps are current readings either way
    const o = (await (await app.request(`/api/overview?at=${NOW - M}`, {}, env(db))).json()) as Overview;
    expect(o.concentration.namadaProv).toMatchObject({ source: 'NamadaTrade holder index', at: NOW - 67 * H, status: 'stale' });
    expect(o.concentration.namadaProv?.note).toMatch(/older than 6 hours/);
    expect(o.concentration.osmosisProv).toMatchObject({ at: NOW - 5 * M, status: 'live' });
    // never the answer's own time
    expect(o.concentration.namadaProv?.at).not.toBe(o.generatedAt);
  });
  it('the older of the top-10 reading and the count\'s data, missing when neither is recorded', () => {
    expect(holderFiguresProv(NOW - 2 * H, NOW - M, NOW)).toMatchObject({ at: NOW - 2 * H, status: 'live' });
    expect(holderFiguresProv(null, NOW - 7 * H, NOW)).toMatchObject({ at: NOW - 7 * H, status: 'stale' });
    expect(holderFiguresProv(null, null, NOW)).toMatchObject({ at: null, status: 'missing' });
  });
});

// ------------------------------------------------------------------ worker/csv-formula-injection (address columns)
describe('CSV cells never start a formula', () => {
  const F = '=HYPERLINK("https://example.invalid/x","Claim airdrop")';
  it('a bridge receiver written as a formula is text in the moves export', async () => {
    const db = testD1();
    insert(db, 'flows', [{ id: 'osmosis:abc:ibc_out:0', chain: 'osmosis', height: 1, ts: NOW - M, tx_hash: 'ABC', kind: 'ibc_out', from_addr: `osmo1${'q'.repeat(38)}`, to_addr: F, amount_num: 1, meta: '{}' }]);
    const csv = await (await app.request('/api/export/flows?format=csv', {}, env(db))).text();
    const row = csv.split('\n')[1];
    expect(row).toContain(`"'=HYPERLINK(""https://example.invalid/x"",""Claim airdrop"")"`);
    expect(row).not.toMatch(/,=HYPERLINK/);
  });
  it('every text cell is guarded and quoted; numbers stay numbers', () => {
    expect(csvCell('-5')).toBe(`"'-5"`);
    expect(csvCell('@SUM(A1)')).toBe(`"'@SUM(A1)"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('\tx')).toBe(`"'\tx"`);
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell('tnam1qxyz')).toBe('tnam1qxyz');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
  });
});

// ------------------------------------------------------------------ security/unauthenticated-heavy-endpoints (cache key guard)
describe('the edge cache key', () => {
  it('lists every query parameter each cached route reads (a new parameter cannot be missed)', () => {
    const src = readFileSync(join(__dirname, '..', 'worker', 'src', 'api.ts'), 'utf8');
    const fq = readFileSync(join(__dirname, '..', 'worker', 'src', 'flows-query.ts'), 'utf8');
    const flowKeys = [...fq.matchAll(/\bq\('([A-Za-z]+)'\)/g)].map((m) => m[1]);
    expect(flowKeys).toEqual(expect.arrayContaining(['chain', 'kind', 'whale', 'minNam', 'arb', 'search', 'pairs']));
    const routes = [...src.matchAll(/app\.get\('(\/api\/[^']+)'/g)].map((m) => m[1]);
    for (const route of routes) {
      if (!(CACHEABLE_API.test(route) || route.startsWith('/api/export/'))) continue;
      expect(CACHE_PARAMS[route], `${route} has no CACHE_PARAMS entry`).toBeDefined();
      const i = src.indexOf(`app.get('${route}'`);
      const rest = src.slice(i + 1);
      const end = rest.search(/\napp\.(get|post|put|delete|use)\(/);
      const body = end < 0 ? rest : rest.slice(0, end);
      const reads = new Set([...body.matchAll(/c\.req\.query\('([A-Za-z]+)'\)/g)].map((m) => m[1]));
      if (/asOfParam\(c\)/.test(body)) reads.add('at');
      if (/thresholdsParam\(c\)/.test(body)) for (const k of Object.keys(DEFAULT_THRESHOLDS)) reads.add(k);
      if (/flowsFilterFromQuery\(/.test(body)) for (const k of flowKeys) reads.add(k);
      for (const k of reads) expect(CACHE_PARAMS[route], `${route} reads ?${k}`).toContain(k);
    }
  });
});

// ------------------------------------------------------------------ ux/address-sheet-osmo-and-double-count
describe('who an address moves NAM with', () => {
  const O = `osmo1${'s'.repeat(38)}`;
  const T = `tnam1${'q'.repeat(40)}`;
  const rows = [
    // one 15,000 NAM crossing, recorded on both chains
    { id: 'osmosis:x1:ibc_out:0', chain: 'osmosis', height: 10, ts: NOW - 2 * H, tx_hash: 'X1', kind: 'ibc_out', from_addr: O, to_addr: T, amount_num: 15000, meta: null },
    { id: 'namada:x1:ibc_in:0', chain: 'namada', height: 20, ts: NOW - 2 * H + 30000, tx_hash: 'X2', kind: 'ibc_in', from_addr: O, to_addr: T, amount_num: 15000, meta: null },
    // 200 OSMO out of the shielded pool: not NAM
    { id: 'namada:x3:unshield:0', chain: 'namada', height: 21, ts: NOW - H, tx_hash: 'X3', kind: 'unshield', from_addr: MASP, to_addr: O, amount_num: 200, meta: '{"tokenSymbol":"OSMO"}' },
    // 1,000 NAM into the pool, crossing straight into it, recorded on both chains
    { id: 'osmosis:x4:ibc_out:0', chain: 'osmosis', height: 11, ts: NOW - 30 * M, tx_hash: 'X4', kind: 'ibc_out', from_addr: O, to_addr: MASP, amount_num: 1000, meta: null },
    { id: 'namada:x4:ibc_in:0', chain: 'namada', height: 22, ts: NOW - 29 * M, tx_hash: 'X5', kind: 'ibc_in', from_addr: O, to_addr: MASP, amount_num: 1000, meta: null },
  ];
  it('counts NAM only and each crossing once, as the moves listed', async () => {
    const db = testD1();
    insert(db, 'flows', rows);
    insert(db, 'labels', [{ address: T, chain: 'namada', label: 'my friend', category: 'watch', source: 'user', author: `tnam1${'a'.repeat(40)}` }]);
    const r = (await (await app.request(`/api/address/${O}`, {}, env(db))).json()) as AddressReport;
    const byAddr = new Map(r.counterparties.map((c) => [c.address, c]));
    expect(byAddr.get(T)).toMatchObject({ outNam: 15000, inNam: 0, count: 1, label_source: 'user', label_author: `tnam1${'a'.repeat(7)}…` });
    expect(byAddr.get(MASP)).toMatchObject({ outNam: 1000, inNam: 0, count: 1 });
  });
  it('the rule is the shared one the sheet uses', () => {
    const flows = rows.map((x) => ({ id: x.id, chain: x.chain, height: x.height, ts: x.ts, txHash: x.tx_hash, kind: x.kind, from: x.from_addr, to: x.to_addr, amount: x.amount_num, meta: x.meta ? JSON.parse(x.meta) : null }) as Flow);
    expect(onePerCrossing(flows).map((f) => f.id)).toEqual(['osmosis:x1:ibc_out:0', 'namada:x3:unshield:0', 'osmosis:x4:ibc_out:0']);
    const cps = counterpartiesOf(flows, O);
    expect(cps.reduce((a, c) => a + c.inNam + c.outNam, 0)).toBe(16000);
  });
});

// ------------------------------------------------------------------ security/label-overwrite (display side: where each label came from)
describe('a wallet\'s tag says whose it is, wherever a label is sent', () => {
  const U = `osmo1${'u'.repeat(38)}`;
  const AUTHOR = `tnam1${'b'.repeat(40)}`;
  const seed = () => {
    const db = testD1();
    insert(db, 'labels', [{ address: U, chain: 'osmosis', label: 'Exchange hot wallet', category: 'watch', source: 'user', author: AUTHOR }]);
    insert(db, 'flows', [
      { id: 'osmosis:s1:buy:0', chain: 'osmosis', height: 1, ts: NOW - H, tx_hash: 'S1', kind: 'buy', from_addr: 'osmo1pool', to_addr: U, amount_num: 5000, counter_denom: 'USDC', counter_amount: 100, meta: null },
    ]);
    return db;
  };
  it('flows carry the label source and the tag\'s author', async () => {
    const r = (await (await app.request('/api/flows', {}, env(seed()))).json()) as FlowsResponse;
    expect(r.flows[0]).toMatchObject({ toLabelPlain: 'Exchange hot wallet', toLabelSource: 'user', toLabelAuthor: `${AUTHOR.slice(0, 12)}…`, fromLabelAuthor: null });
  });
  it('the supply page\'s movers carry them too', async () => {
    const p = await pressure(seed() as any, NOW, false);
    expect(p.movers[0]).toMatchObject({ address: U, labelSource: 'user', labelAuthor: `${AUTHOR.slice(0, 12)}…` });
  });
  it('the words: "Tag by …" for a tag, nothing for a curated name', () => {
    expect(tagByline('user', labelAuthorShort('user', AUTHOR))).toBe(`Tag by ${AUTHOR.slice(0, 12)}…`);
    expect(tagByline('user', null)).toBe('Tag by a signed-in wallet');
    expect(tagByline('genesis', null)).toBeNull();
    expect(labelAuthorShort('genesis', AUTHOR)).toBeNull();
  });
});

// ------------------------------------------------------------------ security/delete-leaves-sessions, apikey-pair-escalation, plaintext-tokens
describe('sessions and keys', () => {
  const A = 'tnam1qsessionxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
  const req = (token: string, path = '/api/auth/me', init: RequestInit = {}) => new Request(`https://namada.trade${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } });
  const tok = (r: Session | { error: string }) => ('token' in r ? r.token : '');
  const PK = Buffer.alloc(32, 7).toString('base64');
  it('pairing many devices never ends the device that pairs them, nor an API key', async () => {
    const db = testD1();
    const first = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    const key = tok(await createSession(db as any, A, 'namada', 'api'));
    for (let i = 0; i < MAX_SESSIONS + 5; i++) {
      const { code } = (await createPairCode(db as any, first, PK)) as { code: string };
      expect((await claimPairCode(db as any, code, PK)).session).toBeTruthy();
    }
    expect(await sessionFromRequest(db as any, req(first.token))).not.toBeNull();
    expect(await sessionFromRequest(db as any, req(key))).not.toBeNull();
    const listed = await listSessions(db as any, A, first.token);
    expect(listed.filter((x) => x.via !== 'api')).toHaveLength(MAX_SESSIONS);
    // the pair row holds a hash of the pairing device's token, never the token
    const { code } = (await createPairCode(db as any, first, PK)) as { code: string };
    expect(db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(pairKey(PK, code)).value).not.toContain(first.token);
  });
  it('one key too many is refused (409), never made by ending another key', async () => {
    const db = testD1();
    const s = (await createSession(db as any, A, 'namada', 'keplr')) as Session;
    const keys: string[] = [];
    for (let i = 0; i < MAX_API_KEYS; i++) keys.push(tok(await createSession(db as any, A, 'namada', 'api')));
    const res = await app.request('/api/me/apikey', { method: 'POST', headers: { Authorization: `Bearer ${s.token}` } }, env(db));
    expect(res.status).toBe(409);
    for (const k of keys) expect(await sessionFromRequest(db as any, req(k))).not.toBeNull();
  });
  it('an API key can neither make a key nor pair a device (one rule)', async () => {
    const db = testD1();
    const k = tok(await createSession(db as any, A, 'namada', 'api'));
    const pair = await app.request('/api/auth/pair', { method: 'POST', headers: { Authorization: `Bearer ${k}` } }, env(db));
    const mint = await app.request('/api/me/apikey', { method: 'POST', headers: { Authorization: `Bearer ${k}` } }, env(db));
    expect([pair.status, mint.status]).toEqual([403, 403]);
    expect(((await pair.json()) as any).error).toBe(FULL_SESSION_ONLY.pair);
    expect(((await mint.json()) as any).error).toBe(FULL_SESSION_ONLY.apikey);
  });
  it('rows from before hashing are deleted by migration 0005 and by the sweep; hashed rows stay', async () => {
    const legacy = (db: ReturnType<typeof testD1>, t: string) => insert(db, 'kv', [{ key: `session:${t}`, value: JSON.stringify({ token: t, address: A, chain: 'namada', linked: null, via: 'api', createdAt: NOW, expiresAt: NOW + 300 * D }), updated_at: NOW }]);
    const db = testD1();
    const live = (await createSession(db as any, A, 'namada', 'namada')) as Session;
    legacy(db, 'b'.repeat(64));
    insert(db, 'kv', [{ key: `sessions:${A}`, value: JSON.stringify(['b'.repeat(64)]), updated_at: NOW }]);
    db.exec(readFileSync(join(__dirname, '..', 'migrations', '0005_drop_plaintext_sessions.sql'), 'utf8'));
    expect(db.raw.prepare("SELECT key FROM kv WHERE key LIKE 'session%'").all().map((r: any) => r.key)).toEqual([expect.stringMatching(/^session:[0-9a-f]{64}$/)]);
    expect(await sessionFromRequest(db as any, req(live.token))).not.toBeNull();
    legacy(db, 'c'.repeat(64));
    await sweepAuth(db as any);
    expect(db.raw.prepare('SELECT COUNT(*) n FROM kv WHERE key = ?').get(`session:${'c'.repeat(64)}`).n).toBe(0);
    expect(await sessionFromRequest(db as any, req(live.token))).not.toBeNull();
  });
});

// ------------------------------------------------------------------ worker/cron-hung-rpc-no-deadline (webhooks)
describe('Discord posts', () => {
  it('end after a timeout, so a webhook that never answers cannot hold up the tick', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => { seen.push(init?.signal); return new Response(null, { status: 204 }); }));
    const u = { address: 'tnam1qx', notifications: { rules: {}, watchlistOn: false, watchlist: [], forumAndGov: false, quietHoursUtc: null }, channels: { discord: { enabled: true, webhookUrl: 'https://discord.invalid/x' } } } as any;
    expect(await sendDiscordTestAlert('https://discord.invalid/x', u)).toBe(true);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(WEBHOOK_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});
