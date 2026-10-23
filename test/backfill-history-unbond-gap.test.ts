// The history backfill's unbond-gap step: it looks for bond and unbond requests between the end of the indexer pull
// and the first block the live decoders handled, which it took as the lowest unbond row of source 'namada-rpc'. The
// nine rows restored on 2026-10-23 (meta.restored) carry that source too, and the lowest of them, block 7,832,000,
// would have ended the range there. The start now leaves restored rows out, and bonds (decoded live since) end at the
// first live bond row, or at the head while there is none. Each live decoder also records in its kv row the first
// block it read (firstHeight), which ends its range when given; without one, a row scripts/rederive-namada.ts wrote
// (meta.rederived) is left out as a restored row is.
//
// The run is a copy of the script in a temporary folder with wrangler replaced by a stub that answers its SELECTs from
// an in-memory SQLite holding the real migrations, and fetch stubbed: nothing reaches a database, a node or the indexer.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testD1, insert } from './d1-sqlite';

const ROOT = join(__dirname, '..');
const CHAIN = 'namada.5f5de2dd1b88cba30586420';
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
const A = 'tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp';
const V = 'tnam1q8e4mk446hs3jjaj0ymmurn59fz6ylktd52v9yn3';
const HEAD = 1000;
const T0 = Date.now() - 10 * 86_400_000;

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as any).__backfillWrangler;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const hist = (id: string, kind: string, h: number, nam: number, exitCode = 'applied') =>
  ({ tx: { id, wrapperId: `w${id}`, kind, data: JSON.stringify({ validator: V, amount: String(nam * 1e6), source: A }), exitCode }, kind, blockHeight: h });

const HIST = [hist('d1', 'bond', 600, 50), hist('c1', 'unbond', 450, 40), hist('b2', 'bond', 300, 25, 'rejected'), hist('b1', 'unbond', 200, 30)];

async function runGap(flows: Record<string, unknown>[], opts: { kv?: Record<string, unknown>; listed?: ReturnType<typeof hist>[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-gap-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'scripts'));
  const IMPORT_CP = "import { execFileSync } from 'node:child_process';";
  const IMPORT_CONFIG = "'../worker/src/config.ts'";
  const src = readFileSync(join(ROOT, 'scripts', 'backfill-history.ts'), 'utf8');
  expect(src).toContain(IMPORT_CP);
  writeFileSync(
    join(dir, 'scripts', 'backfill-history.ts'),
    src.replace(IMPORT_CP, 'const execFileSync = (globalThis as any).__backfillWrangler;').replace(IMPORT_CONFIG, `'${join(ROOT, 'worker', 'src', 'config.ts')}'`),
  );
  copyFileSync(join(ROOT, 'scripts', 'chain-agree.ts'), join(dir, 'scripts', 'chain-agree.ts'));

  const db = testD1();
  insert(db, 'flows', flows);
  for (const [key, value] of Object.entries(opts.kv ?? {})) db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run(key, JSON.stringify(value));
  insert(db, 'holders', [{ chain: 'namada', address: A, balance: '5000000', balance_num: 5, updated_height: 900, updated_at: 0 }]);
  (globalThis as any).__backfillWrangler = (cmd: string, args: string[]) => {
    expect([cmd, ...args.slice(0, 3)]).toEqual(['npx', 'wrangler', 'd1', 'execute']);
    const s = args[args.length - 1];
    expect(s).toMatch(/^\s*SELECT\b/);
    return JSON.stringify([{ results: db.raw.prepare(s).all() }]);
  };
  vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
    const url = new URL(String(u));
    let a: unknown = null;
    if (url.pathname === '/status') a = { result: { sync_info: { latest_block_height: String(HEAD) } } };
    else if (url.host === 'indexer.namada.net') {
      a = { pagination: { totalPages: 1 }, results: url.searchParams.get('addresses') === A ? (opts.listed ?? HIST) : [] };
    } else if (url.pathname === '/blockchain') {
      const lo = Number(url.searchParams.get('minHeight')), hi = Number(url.searchParams.get('maxHeight'));
      const metas = [];
      for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: CHAIN, height: String(h), time: new Date(T0 + h * 6000).toISOString() } });
      a = { result: { block_metas: metas } };
    }
    if (a == null) throw new Error(`unexpected read ${url}`);
    return new Response(JSON.stringify(a), { status: 200 });
  }));
  const logs: string[] = [];
  let exit: number | undefined;
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { exit = c ?? 0; }) as any);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  const argv = process.argv[2];
  process.argv[2] = 'unbond-gap';
  try {
    await import(join(dir, 'scripts', 'backfill-history.ts'));
    await vi.waitFor(() => { if (exit === undefined && !logs.some((l) => /06_unbond_gap: \d+ statements/.test(l))) throw new Error('running'); }, { timeout: 20000, interval: 20 });
  } finally {
    process.argv[2] = argv;
  }
  expect(exit, logs.join('\n')).toBeUndefined();
  const f = join(dir, 'scripts', 'out', 'history', '06_unbond_gap_000.sql');
  return { logs, ids: existsSync(f) ? [...readFileSync(f, 'utf8').matchAll(/VALUES \('namada:([A-Z0-9]+):pos'/g)].map((m) => m[1]) : [] };
}

const row = (id: string, height: number, kind: string, meta: Record<string, unknown> | null) =>
  ({ id, chain: 'namada', height, ts: T0 + height * 6000, tx_hash: id, kind, from_addr: kind === 'bond' ? A : POS, to_addr: kind === 'bond' ? POS : A, amount_num: 1, meta: meta && JSON.stringify(meta) });

describe('unbond-gap: where the live decoders started', () => {
  it('a restored row is not the decoder\'s start: the range runs to the first unbond the live scan wrote', async () => {
    const r = await runGap([
      row('X0', 100, 'transfer', null), // the indexer pull: no meta.source, the range's start
      row('R1', 150, 'unbond', { source: 'namada-rpc', txKind: 'unbond', restored: '2026-10-23' }),
      row('L1', 400, 'unbond', { source: 'namada-rpc', txKind: 'unbond' }),
    ]);
    expect(r.logs.some((l) => l.includes('unbond requests in [100, 400)'))).toBe(true);
    // no live bond row yet: bonds up to the head; the rejected bond and the unbond after the live start are left out
    expect(r.logs.some((l) => l.includes('bond requests in [100, 1000)') && l.includes('has not decoded anything yet'))).toBe(true);
    expect(r.ids.sort()).toEqual(['B1', 'D1']);
  });

  it('with a live bond row, bonds end there too; restored bond rows are left out the same way', async () => {
    const r = await runGap([
      row('X0', 100, 'transfer', null),
      row('L1', 400, 'unbond', { source: 'namada-rpc', txKind: 'unbond' }),
      row('R2', 120, 'bond', { source: 'namada-rpc', txKind: 'bond', restored: '2026-10-23' }),
      row('L2', 550, 'bond', { source: 'namada-rpc', txKind: 'bond' }),
    ]);
    expect(r.logs.some((l) => l.includes('bond requests in [100, 550)') && l.includes('starts at 550'))).toBe(true);
    expect(r.ids).toEqual(['B1']);
  });

  it('a row scripts/rederive-namada.ts inserted (meta.rederived) is not the decoder\'s start either', async () => {
    const r = await runGap([
      row('X0', 100, 'transfer', null),
      row('L1', 420, 'unbond', { source: 'namada-rpc', txKind: 'unbond' }),
      row('RU', 300, 'unbond', { source: 'namada-rpc', txKind: 'unbond', rederived: '2026-10-22' }),
      row('RD', 350, 'bond', { source: 'namada-rpc', txKind: 'bond', rederived: '2026-10-22' }),
      row('L2', 550, 'bond', { source: 'namada-rpc', txKind: 'bond' }),
    ], {
      // the production unbond row has no first block: the stored rows decide
      kv: { 'namada.unbonds.live': { decoded: 6, failures: [] } },
      listed: [hist('e1', 'bond', 400, 10), hist('d1', 'bond', 600, 50), hist('c1', 'unbond', 450, 40), hist('b1', 'unbond', 200, 30)],
    });
    expect(r.logs.some((l) => l.includes('unbond requests in [100, 420)') && l.includes('starts at 420, its lowest row'))).toBe(true);
    expect(r.logs.some((l) => l.includes('bond requests in [100, 550)') && l.includes('starts at 550, its lowest row'))).toBe(true);
    expect(r.ids.sort()).toEqual(['B1', 'E1']);
  });

  it('the first block each decoder recorded in its kv row ends its range, whatever rows are stored', async () => {
    const r = await runGap([
      row('X0', 100, 'transfer', null),
      row('RD', 350, 'bond', { source: 'namada-rpc', txKind: 'bond', rederived: '2026-10-22' }),
      row('L1', 440, 'unbond', { source: 'namada-rpc', txKind: 'unbond' }),
    ], {
      kv: {
        'namada.bonds.live': { decoded: 0, failures: [], firstHeight: 580 },
        'namada.unbonds.live': { decoded: 1, failures: [], firstHeight: 430 },
      },
      listed: [hist('e1', 'bond', 400, 10), hist('d1', 'bond', 600, 50), hist('f1', 'unbond', 425, 5), hist('c1', 'unbond', 450, 40), hist('b1', 'unbond', 200, 30)],
    });
    expect(r.logs.some((l) => l.includes('bond requests in [100, 580)') && l.includes('starts at 580, the first block it read (kv namada.bonds.live)'))).toBe(true);
    expect(r.logs.some((l) => l.includes('unbond requests in [100, 430)') && l.includes('kv namada.unbonds.live'))).toBe(true);
    // bonds below 580 (E1 at 400), unbonds below 430 (B1, F1); D1 at 600 and C1 at 450 are the live decoders' own
    expect(r.ids.sort()).toEqual(['B1', 'E1', 'F1']);
  });

  it('a first block that is not a block height is not used', async () => {
    const r = await runGap([
      row('X0', 100, 'transfer', null),
      row('L1', 400, 'unbond', { source: 'namada-rpc', txKind: 'unbond' }),
    ], { kv: { 'namada.unbonds.live': { decoded: 1, failures: [], firstHeight: 'soon' }, 'namada.bonds.live': { decoded: 0, failures: [], firstHeight: -5 } } });
    expect(r.logs.some((l) => l.includes('unbond requests in [100, 400)') && l.includes('its lowest row'))).toBe(true);
    expect(r.logs.some((l) => l.includes('bond requests in [100, 1000)') && l.includes('has not decoded anything yet'))).toBe(true);
  });
});
