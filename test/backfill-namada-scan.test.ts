// The full-history backfill's scan (scripts/backfill-namada.ts scan) finds blocks with block_search, which answers only
// from where a node's event index starts. The config nodes keep every block but index events only from block
// 7,679,994 (5ElementsNodes), 7,914,171 (Papadritta, both read 2026-11-02) and 4,546,325 (StakeAndRelax, the third node
// since 2026-11-07): an empty answer below that read as "no blocks",
// and a scan from block 1 saw 505 blocks over 8.28M heights and said "scan complete". The scan now reads where each
// node's index starts first and stops below it, refuses a progress file from a scan that did not, stops on a page with
// no block before the count is reached, and never reports complete when the index listed no block at all.
//
// The run is a copy of the script in a temporary folder (its output goes there) with fetch stubbed: nothing reaches a node.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const CHAIN = 'namada.5f5de2dd1b88cba30586420';
const FIVE = 'rpc-namada.5elementsnodes.com', PAPA = 'rpc.papadritta.com', SAR = 'namada-rpc.stakeandrelax.net';
const T0 = Date.parse('2026-06-13T00:00:00Z');

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Chain {
  head: number;
  /** where each node's block index starts; null: the node lists no block */
  floors: Record<string, number | null>;
  /** the blocks with a transfer that block_search lists */
  transfers: number[];
  /** a page that answers no block whatever the count says */
  emptyPage?: number;
  /** a progress file left by an earlier run */
  progress?: Record<string, unknown>;
}

const header = (h: number) => ({ chain_id: CHAIN, height: String(h), time: new Date(T0 + h * 6000).toISOString() });

async function runScan(c: Chain) {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-scan-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'scripts', 'out', 'namada'), { recursive: true });
  const src = readFileSync(join(ROOT, 'scripts', 'backfill-namada.ts'), 'utf8');
  expect(src).toContain("from './genesis-labels'");
  writeFileSync(
    join(dir, 'scripts', 'backfill-namada.ts'),
    src.replace(/from '\.\.\/worker\/src\/([^']+)'/g, `from '${join(ROOT, 'worker', 'src')}/$1.ts'`)
      .replace("from './genesis-labels'", `from '${join(ROOT, 'scripts', 'genesis-labels.ts')}'`),
  );
  if (c.progress) writeFileSync(join(dir, 'scripts', 'out', 'namada', 'progress.json'), JSON.stringify(c.progress));

  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
    const url = new URL(String(u));
    asked.push(url.host + url.pathname + ' ' + (url.searchParams.get('query') ?? url.searchParams.get('height') ?? ''));
    let a: unknown = null;
    if (url.pathname === '/status') {
      a = { result: { node_info: { network: CHAIN }, sync_info: { latest_block_height: String(c.head), latest_block_time: header(c.head).time, catching_up: false, earliest_block_height: '1' } } };
    } else if (url.pathname === '/block_search' && url.searchParams.get('query') === '"block.height>=1"') {
      const f = c.floors[url.host];
      a = { result: { total_count: f == null ? '0' : String(c.head - f + 1), blocks: f == null ? [] : [{ block: { header: header(f) } }] } };
    } else if (url.pathname === '/block_search') {
      const m = /token\/transfer\.height>=(\d+) AND token\/transfer\.height<=(\d+)/.exec(url.searchParams.get('query') ?? '');
      if (m) {
        const page = Number(url.searchParams.get('page')), per = Number(url.searchParams.get('per_page'));
        const all = c.transfers.filter((h) => h >= Number(m[1]) && h <= Number(m[2]));
        const blocks = page === c.emptyPage ? [] : all.slice((page - 1) * per, page * per).map((h) => ({ block: { header: header(h) } }));
        a = { result: { total_count: String(all.length), blocks } };
      }
    } else if (url.pathname === '/block_results') {
      a = { result: { height: url.searchParams.get('height'), end_block_events: [] } };
    }
    if (a == null) throw new Error(`unexpected read ${url}`);
    return new Response(JSON.stringify(a), { status: 200 });
  }));
  const logs: string[] = [];
  let exit: number | undefined;
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; }) as any);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  const argv = process.argv[2];
  process.argv[2] = 'scan';
  try {
    await import(join(dir, 'scripts', 'backfill-namada.ts'));
    await vi.waitFor(() => { if (exit === undefined && !logs.some((l) => l.includes('scan complete'))) throw new Error('running'); }, { timeout: 20000, interval: 20 });
  } finally {
    process.argv[2] = argv;
  }
  const progressFile = join(dir, 'scripts', 'out', 'namada', 'progress.json');
  return { logs, exit, asked, progress: existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, 'utf8')) : null };
}

describe('backfill-namada scan: where the nodes index events', () => {
  it('stops before reading a block when the nodes index events only from later, naming where each starts', async () => {
    const r = await runScan({ head: 8_516_900, floors: { [FIVE]: 7_679_994, [PAPA]: 7_914_171, [SAR]: 4_546_325 }, transfers: [7_682_174, 8_202_488] });
    expect(r.exit).toBe(1);
    const err = r.logs.join('\n');
    expect(err).toContain('the scan is at block 1, but the nodes index events only from later (5ElementsNodes from block 7679994, Papadritta from block 7914171, StakeAndRelax from block 4546325)');
    expect(err).toContain('block_search answers nothing below block 7914171');
    expect(err).not.toContain('scan complete');
    // no transfer search, no block read and no progress written
    expect(r.asked.filter((a) => a.includes('token/transfer') || a.includes('/block_results'))).toEqual([]);
    expect(r.progress).toBeNull();
  });

  it('refuses a progress file from a scan that did not check the index: such a run read unindexed blocks as empty', async () => {
    // what the run of 2026-10 left: past the floor, so the old scan went on from there and said "scan complete"
    const r = await runScan({
      head: 8_516_900, floors: { [FIVE]: 7_679_994, [PAPA]: 7_914_171, [SAR]: 4_546_325 }, transfers: [8_400_000],
      progress: { nextFrom: 8_280_001, head: 8_280_000, blocks: 505, flows: 900 },
    });
    expect(r.exit).toBe(1);
    expect(r.logs.join('\n')).toContain('was written by a scan that did not check where the nodes\' event index starts');
    expect(r.asked.filter((a) => a.includes('token/transfer'))).toEqual([]);
    expect(r.progress).toEqual({ nextFrom: 8_280_001, head: 8_280_000, blocks: 505, flows: 900 });
  });

  it('stops when a node does not say where its index starts: any node may answer the scan', async () => {
    const r = await runScan({ head: 250_000, floors: { [FIVE]: 1, [PAPA]: null, [SAR]: 1 }, transfers: [5] });
    expect(r.exit).toBe(1);
    expect(r.logs.join('\n')).toContain("where Papadritta's event index starts could not be read");
    expect(r.progress).toBeNull();
  });

  it('never reports complete when the index lists no block with a transfer', async () => {
    const r = await runScan({ head: 250_000, floors: { [FIVE]: 1, [PAPA]: 1, [SAR]: 1 }, transfers: [] });
    expect(r.exit).toBe(1);
    const all = r.logs.join('\n');
    expect(all).toContain('block_search listed no block with a transfer from block 1 to 250000');
    expect(all).not.toContain('scan complete');
  });

  it('stops on a page with no block before the count is reached, without writing that window', async () => {
    const transfers = Array.from({ length: 150 }, (_, i) => 10 + i * 100);
    const r = await runScan({ head: 50_000, floors: { [FIVE]: 1, [PAPA]: 1, [SAR]: 1 }, transfers, emptyPage: 2 });
    expect(r.exit).toBe(1);
    expect(r.logs.join('\n')).toContain('block_search 1-50000 answered page 2 with no block after 100 of 150');
    expect(r.asked.filter((a) => a.includes('/block_results'))).toEqual([]);
    expect(r.progress).toBeNull();
  });

  it('with an index from block 1 it scans every window and says how far the index reached', async () => {
    const r = await runScan({ head: 250_000, floors: { [FIVE]: 1, [PAPA]: 1, [SAR]: 1 }, transfers: [5, 150_000] });
    expect(r.exit, r.logs.join('\n')).toBeUndefined();
    expect(r.logs.some((l) => l.includes('scan complete: 2 blocks with transfers from block 1 to 250000 (event index from block 1)'))).toBe(true);
    expect(r.progress).toMatchObject({ nextFrom: 250_001, head: 250_000, blocks: 2, from: 1, indexFrom: 1 });
    expect(r.asked.filter((a) => a.includes('/block_results')).sort()).toEqual([`${FIVE}/block_results 150000`, `${FIVE}/block_results 5`]);
  });
});
