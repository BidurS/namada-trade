// Security review (2026-10-22), the live scan head and the indexer's vote: with 5ElementsNodes down, a low node that
// answers the indexer's own lagging height made the cron store a lag of 0, so the vote counted, vouched for that node,
// and the agreed head moved an honest cursor back. One node and the indexer can both be behind by as much; only two
// nodes agreeing now moves the cursor back.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.unstubAllGlobals(); });

function chain(spec: Record<'five' | 'papa', { height: number; down?: boolean }>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    const who = url.host.includes('5elementsnodes') ? 'five' : 'papa';
    const n = spec[who];
    calls.push(`${who} ${url.pathname}${url.search}`);
    if (n.down) throw new Error('refused');
    if (url.pathname === '/status') return Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(n.height), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    if (url.pathname === '/blockchain') {
      const lo = Number(url.searchParams.get('minHeight')), hi = Math.min(Number(url.searchParams.get('maxHeight')), n.height);
      if (lo > hi) return Response.json({ error: { code: -32603, message: 'Internal error' } });
      const metas = [];
      for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: NAMADA.chainId, height: String(h), time: new Date().toISOString() }, num_txs: '0' });
      return Response.json({ result: { last_height: String(n.height), block_metas: metas } });
    }
    if (url.pathname === '/block_results') return Response.json({ result: { height: url.searchParams.get('height'), end_block_events: [] } });
    throw new Error(`unexpected ${url}`);
  }));
  return calls;
}
const hubOf = (db: TestD1) => Object.assign(Object.create(LiveHub.prototype), {
  env: { DB: db }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote: new HubQuote(async () => null, async () => null),
}) as any;

describe('a low node matching a lagging indexer while the other node is down', () => {
  it('does not move an honest cursor back', async () => {
    const db = testD1();
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', '8300000', 0)").run();
    // the indexer is 300 blocks behind; 5ElementsNodes is down, so the cron's "RPC height" is Papadritta's own answer
    db.raw.prepare("INSERT OR REPLACE INTO checks (key, status, title, detail, checked_at) VALUES ('indexer_lag', 'ok', 'indexer', ?, ?)")
      .run(JSON.stringify({ indexerHeight: 8_299_700, rpcHeight: 8_299_700, lagBlocks: 0 }), Date.now());
    const calls = chain({ five: { height: 8_300_000, down: true }, papa: { height: 8_299_700 } });
    await hubOf(db).scanNamada();
    const cur = (db.raw.prepare("SELECT value FROM kv WHERE key='namada.cursor'").get() as any).value;
    const notes = JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='namada.scan'").get() as any)?.value ?? '{"failures":[]}').failures.map((f: any) => f.note);
    console.log('cursor', cur, 'notes', JSON.stringify(notes), 'papa block reads', calls.filter((c) => c.startsWith('papa') && !c.endsWith('/status')).length);
    expect(cur).toBe('8300000');
  });
});
