// Security review (2026-10-22), the MASP backfill's lone answers: scripts/backfill-history.ts takes a block with no MASP
// NAM transfer from one node, since nothing is stored from it. It took such an answer even after another node had
// answered the same block with a transfer, and at heights the indexer or flows say hold one, so a single node that
// left a shield out of a block set the cached block and the published daily balance alone (1,000 NAM where three
// nodes and the live metric say 1,500). A missing inflow leaves no negative residual, so the 2% gate did not see it.
// Now a lone answer is taken only as the first answer of a height no record names, a block cached from one node
// without the transfer at such a height is asked again, and the series and corrective flows are written only when the
// ledger's last balance is also within 2% of the live metric.
//
// Each run is a copy of the script in a temporary folder with wrangler replaced by a stub and fetch stubbed: nothing
// reaches a database or a node, and the repo's scripts/out/ is never touched.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maspEvents } from '../scripts/chain-agree';

const ROOT = join(__dirname, '..');
const NAM = 'tnam1q9gr66cvu4hrzm0sd5kmlnjje82gs3xlfg3v6nu7';
const MASP = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah';
const CHAIN = 'namada.5f5de2dd1b88cba30586420';
const FIVE = 'https://rpc-namada.5elementsnodes.com', PAPA = 'https://rpc.papadritta.com';
const POLK = 'https://namada-rpc.polkachu.com', SAR = 'https://namada-rpc.stakeandrelax.net';
const NOW_METRIC = Date.parse('2026-10-01T20:00:00Z');

const transfer = (inner: string, from: string, to: string, amount: string, post: [string, string][]) => ({
  type: 'token/transfer',
  attributes: [
    { key: 'source-accounts', value: JSON.stringify([[[from, NAM], amount]]) },
    { key: 'target-accounts', value: JSON.stringify([[[to, NAM], amount]]) },
    { key: 'post-balances', value: JSON.stringify(post.map(([a, v]) => [[a, NAM], v])) },
    { key: 'inner-tx-hash', value: inner },
    { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
  ],
});
const metas = (h: number, time: string) => ({ result: { block_metas: [{ header: { height: String(h), time, chain_id: CHAIN }, num_txs: '1' }] } });
// Block 200: a 1 NAM shield, the pool 1,000 NAM after it. Block 300: a 500 NAM shield, the pool 1,500 NAM after it.
const B200 = { result: { finalize_block_events: [transfer('AAAA', 'tnam1x', MASP, '1000000', [[MASP, '1000000000']])] } };
const B300 = { result: { finalize_block_events: [transfer('CCCC', 'tnam1y', MASP, '500000000', [[MASP, '1500000000']])] } };
// Block 300 as a node that leaves the shield out gives it: not empty, an ordinary transfer, no MASP NAM.
const B300_OMIT = { result: { finalize_block_events: [transfer('DDDD', 'tnam1a', 'tnam1b', '1000000', [['tnam1b', '5000000']])] } };
const FLOW_300 = { id: 'namada:CCCC:h0', height: 300, ts: 2, tx_hash: 'CCCC', kind: 'shield', from_addr: 'tnam1y', to_addr: MASP, amount_num: 500, meta: null };
// The indexer's record of block 200's shield (flows lacks it, so the run writes it as a corrective row).
const HIST_200 = { tx: { id: 'aaaa', wrapperId: 'w', kind: 'shieldingTransfer', data: JSON.stringify({ target: MASP, token: NAM }), exitCode: 'applied' }, kind: 'shieldingTransfer', blockHeight: 200 };

type Setup = {
  /** block_results of block 300 by node (B300 when a node is not named). */
  b300?: Record<string, unknown>;
  /** Whether flows holds block 300's shield (else no record names height 300). */
  flow300?: boolean;
  /** A block 300 cached by an earlier run. */
  cached300?: unknown;
};

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as any).__backfillWrangler;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Runs `backfill-history.ts masp` on a copy and returns what it wrote. */
async function runMasp(setup: Setup) {
  const dir = mkdtempSync(join(tmpdir(), 'backfill-masp-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'scripts'));
  const IMPORT_CP = "import { execFileSync } from 'node:child_process';";
  const IMPORT_CONFIG = "'../worker/src/config.ts'";
  const src = readFileSync(join(ROOT, 'scripts', 'backfill-history.ts'), 'utf8');
  // The copy has no child_process at all, so no read can reach wrangler whatever the mocks do.
  expect(src).toContain(IMPORT_CP);
  expect(src).toContain(IMPORT_CONFIG);
  writeFileSync(
    join(dir, 'scripts', 'backfill-history.ts'),
    src.replace(IMPORT_CP, 'const execFileSync = (globalThis as any).__backfillWrangler;').replace(IMPORT_CONFIG, `'${join(ROOT, 'worker', 'src', 'config.ts')}'`),
  );
  copyFileSync(join(ROOT, 'scripts', 'chain-agree.ts'), join(dir, 'scripts', 'chain-agree.ts'));
  const out = join(dir, 'scripts', 'out', 'history');
  if (setup.cached300) {
    mkdirSync(join(out, 'masp_blocks'), { recursive: true });
    writeFileSync(join(out, 'masp_blocks', '300.json'), JSON.stringify(setup.cached300));
  }

  const sql: string[] = [];
  (globalThis as any).__backfillWrangler = (cmd: string, args: string[]) => {
    expect([cmd, ...args.slice(0, 3)]).toEqual(['npx', 'wrangler', 'd1', 'execute']);
    const s = args[args.length - 1];
    sql.push(s);
    expect(s).toMatch(/^\s*SELECT\b/);
    const rows = s.includes('supply.masp_shielded') ? [{ value: 1500, ts: NOW_METRIC }] : s.includes('FROM flows') ? (setup.flow300 === false ? [] : [FLOW_300]) : [];
    return JSON.stringify([{ results: rows }]);
  };
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
    const url = String(u);
    asked.push(url);
    let a: unknown = null;
    if (url.startsWith('https://indexer.namada.net/')) a = { pagination: { totalPages: 1, totalItems: 1 }, results: [HIST_200] };
    else if (url.endsWith('/blockchain?minHeight=200&maxHeight=200')) a = metas(200, '2026-10-01T00:00:00Z');
    else if (url.endsWith('/blockchain?minHeight=300&maxHeight=300')) a = metas(300, '2026-10-01T12:00:00Z');
    else if (url.endsWith('/block_results?height=200')) a = B200;
    else if (url.endsWith('/block_results?height=300')) a = setup.b300?.[url.split('/block_results')[0]] ?? B300;
    if (a == null) throw new Error(`unexpected read ${url}`);
    return new Response(JSON.stringify(a), { status: 200 });
  }));
  let exit: number | undefined;
  const logs: string[] = [];
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { exit = c ?? 0; }) as any);
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  const argv = process.argv[2];
  process.argv[2] = 'masp';
  try {
    await import(join(dir, 'scripts', 'backfill-history.ts'));
    await vi.waitFor(() => {
      if (exit === undefined && !logs.some((l) => /04_masp_daily: \d+ statements|NOT written/.test(l))) throw new Error('running');
    }, { timeout: 20000, interval: 20 });
  } finally {
    process.argv[2] = argv;
  }
  expect(exit, logs.join('\n')).toBeUndefined();
  const file = (prefix: string) => { const f = join(out, `${prefix}_000.sql`); return existsSync(f) ? readFileSync(f, 'utf8') : null; };
  const daily = file('04_masp_daily')?.split('\n').filter((l) => l.includes("'supply.masp_shielded.daily'")) ?? null;
  return {
    sql,
    logs,
    daily,
    flows: file('04_masp_flows'),
    written: readdirSync(out).filter((f) => f.startsWith('04_')),
    report: JSON.parse(readFileSync(join(out, 'masp_report.json'), 'utf8')),
    block300: existsSync(join(out, 'masp_blocks', '300.json')) ? JSON.parse(readFileSync(join(out, 'masp_blocks', '300.json'), 'utf8')) : null,
    reads300: asked.filter((u) => u.endsWith('/block_results?height=300')).map((u) => u.split('/block_results')[0]),
  };
}

const inners = (b: { events: { attrs: Record<string, string> }[] } | null) => b?.events.map((e) => e.attrs['inner-tx-hash']);

describe('the masp step and a node that leaves a transfer out of a block', () => {
  it('with every node honest, the series ends at the live balance and the missing shield is written', async () => {
    const r = await runMasp({});
    expect(r.daily).toEqual([`INSERT OR REPLACE INTO metrics (ts,key,value) VALUES (${Date.parse('2026-10-01T00:00:00Z')},'supply.masp_shielded.daily',1500);`]);
    expect(r.flows).toContain("'namada:AAAA:c0','namada',200,");
    expect(r.flows).toContain(`"blockBy":["${FIVE}","${PAPA}"]`);
    expect(r.block300.agreedBy).toEqual([FIVE, PAPA]);
    expect(r.report).toMatchObject({ lastBalance: 1500, liveBalance: 1500, written: true });
    expect(r.sql.every((s) => /^\s*SELECT\b/.test(s))).toBe(true);
  }, 30000);

  it('a node asked second that leaves the shield out is outvoted, not taken alone', async () => {
    const r = await runMasp({ b300: { [PAPA]: B300_OMIT } });
    expect(r.reads300).toEqual([FIVE, PAPA, POLK]);
    expect(r.block300.agreedBy).toEqual([FIVE, POLK]);
    expect(inners(r.block300)).toEqual(['CCCC']);
    expect(r.daily).toEqual([expect.stringContaining(",'supply.masp_shielded.daily',1500);")]);
  }, 30000);

  it('the first node that leaves the shield out of a height flows names is not taken alone', async () => {
    const r = await runMasp({ b300: { [FIVE]: B300_OMIT } });
    expect(r.reads300).toEqual([FIVE, PAPA, POLK]);
    expect(r.block300.agreedBy).toEqual([PAPA, POLK]);
    expect(inners(r.block300)).toEqual(['CCCC']);
    expect(r.daily).toEqual([expect.stringContaining(",'supply.masp_shielded.daily',1500);")]);
  }, 30000);

  it('a block cached from one node without the shield, at a height flows names, is asked of the others', async () => {
    const r = await runMasp({ b300: { [FIVE]: B300_OMIT }, cached300: { height: 300, rpc: FIVE, ...maspEvents(B300_OMIT)! } });
    expect(r.reads300).toEqual([PAPA, POLK]);
    expect(r.block300.agreedBy).toEqual([PAPA, POLK]);
    expect(inners(r.block300)).toEqual(['CCCC']);
    expect(r.daily).toEqual([expect.stringContaining(",'supply.masp_shielded.daily',1500);")]);
  }, 30000);

  it('a shield no record names leaves the ledger 500 NAM short of the live balance: nothing is written', async () => {
    const r = await runMasp({ flow300: false });
    expect(r.reads300).toEqual([]);
    expect(r.written).toEqual([]);
    expect(r.report).toMatchObject({ lastBalance: 1000, liveBalance: 1500, endGap: -500, unexplained: 0, written: false });
    expect(r.logs.some((l) => l.includes('-500 NAM off the live metric'))).toBe(true);
  }, 30000);
});
