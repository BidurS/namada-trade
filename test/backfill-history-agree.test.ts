// Security review (2026-10-22), the history backfill's producers: scripts/backfill-history.ts stored block times and a
// block's MASP events from the first node that answered, three of them outside the Worker's nodes, with no check of
// the heights, the chain or the times, and labelled the result exact (tsSource 'block', source
// 'namada-rpc-block-results') in SQL for production. A node that lied (a forged Osmosis block time, a 5,000,000 NAM
// shield that never happened) was written as chain data. Now a node's answer is checked on its own (the chain and
// heights asked, times that are dates, not in the future and rising with height) and is taken only when a second node
// gives the same answer (scripts/chain-agree.ts); a block cached from one node before is asked of another once.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agreed, agreedBlock, metaTimes, maspEvents } from '../scripts/chain-agree';

const OSMO = 'osmosis-1';
const NAM = 'tnam1q9gr66cvu4hrzm0sd5kmlnjje82gs3xlfg3v6nu7';
const MASP = 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah';
const NOW = Date.parse('2026-10-22T00:00:00Z');

const meta = (h: number, time: string, chain = OSMO) => ({ header: { height: String(h), time, chain_id: chain }, num_txs: '0' });
const answer = (...metas: unknown[]) => ({ result: { block_metas: metas } });

describe('one node\'s block metas', () => {
  it('a window of the chain and heights asked, rising in time, is an answer', () => {
    expect(metaTimes(answer(meta(101, '2026-10-01T00:00:01.5Z'), meta(100, '2026-10-01T00:00:00Z')), 100, 101, OSMO, NOW))
      .toEqual([[100, Date.parse('2026-10-01T00:00:00Z')], [101, Date.parse('2026-10-01T00:00:01.5Z')]]);
  });
  it('anything else is no answer', () => {
    const ok = meta(100, '2026-10-01T00:00:00Z');
    expect(metaTimes({ result: {} }, 100, 100, OSMO, NOW)).toBeNull();
    expect(metaTimes(answer(meta(100, '2026-10-01T00:00:00Z', 'osmo-test-5')), 100, 100, OSMO, NOW)).toBeNull(); // another chain
    expect(metaTimes(answer(meta(99, '2026-10-01T00:00:00Z')), 100, 100, OSMO, NOW)).toBeNull(); // a height not asked
    expect(metaTimes(answer(ok), 100, 101, OSMO, NOW)).toBeNull(); // a height missing
    expect(metaTimes(answer(ok, ok), 100, 101, OSMO, NOW)).toBeNull(); // a height twice
    expect(metaTimes(answer(meta(100, 'yesterday')), 100, 100, OSMO, NOW)).toBeNull(); // not a date
    expect(metaTimes(answer(meta(100, '2027-01-01T00:00:00Z')), 100, 100, OSMO, NOW)).toBeNull(); // in the future
    expect(metaTimes(answer(meta(100, '2026-10-01T00:00:05Z'), meta(101, '2026-10-01T00:00:05Z')), 100, 101, OSMO, NOW)).toBeNull(); // not rising
  });
});

describe('block times', () => {
  const read = (by: Record<string, unknown>, asked: string[]) => async (node: string) => {
    asked.push(node);
    if (!(node in by)) throw new Error('HTTP 500');
    return metaTimes(by[node], 100, 100, OSMO, NOW);
  };
  const forged = answer(meta(100, '2001-01-01T00:00:00Z'));
  const real = answer(meta(100, '2026-10-01T00:00:00Z'));

  it('a time one node gives alone, the first asked, is not taken', async () => {
    const asked: string[] = [];
    expect(await agreed(['ecostake', 'polkachu', 'publicnode'], read({ ecostake: forged }, asked))).toBeNull();
    expect(asked).toEqual(['ecostake', 'polkachu', 'publicnode']);
  });
  it('the time two nodes agree on is taken, with those two named, past a first node that lies', async () => {
    const a = await agreed(['ecostake', 'polkachu', 'publicnode'], read({ ecostake: forged, polkachu: real, publicnode: real }, []));
    expect(a).toEqual({ value: [[100, Date.parse('2026-10-01T00:00:00Z')]], by: ['polkachu', 'publicnode'] });
  });
  it('two nodes that agree are enough: the third is not asked', async () => {
    const asked: string[] = [];
    await agreed(['a', 'b', 'c'], read({ a: real, b: real, c: real }, asked));
    expect(asked).toEqual(['a', 'b']);
  });
  it('a node named twice is asked once and counts once', async () => {
    expect(await agreed(['ecostake', 'ecostake'], read({ ecostake: forged }, []))).toBeNull();
  });
});

// Security review (2026-10-22), lone answers: an answer that `alone` accepts (a block with nothing to store) was taken
// from one node even after another node had answered differently, so the node that left a transfer out won over the
// node that gave it, and the nodes that would have agreed with the first were never asked.
describe('an answer one node may give alone', () => {
  const answers = (by: Record<string, string | null>, asked: string[]) => async (node: string) => {
    asked.push(node);
    if (by[node] === undefined) throw new Error('HTTP 500');
    return by[node];
  };
  const alone = (v: string) => v === 'nothing';

  it('is taken as the first answer, past nodes that fail or have nothing', async () => {
    const asked: string[] = [];
    expect(await agreed(['a', 'b', 'c'], answers({ b: null, c: 'nothing' }, asked), undefined, undefined, alone)).toEqual({ value: 'nothing', by: ['c'] });
    expect(asked).toEqual(['a', 'b', 'c']);
  });
  it('is not taken once another node has answered differently: two must agree', async () => {
    const asked: string[] = [];
    const a = await agreed(['a', 'b', 'c', 'd'], answers({ a: 'shield', b: 'nothing', c: 'shield', d: 'nothing' }, asked), undefined, undefined, alone);
    expect(a).toEqual({ value: 'shield', by: ['a', 'c'] });
    expect(asked).toEqual(['a', 'b', 'c']);
    expect(await agreed(['a', 'b', 'c', 'd'], answers({ a: 'shield', b: 'nothing', c: 'nothing' }, []), undefined, undefined, alone)).toEqual({ value: 'nothing', by: ['b', 'c'] });
    expect(await agreed(['a', 'b'], answers({ a: 'shield', b: 'nothing' }, []), undefined, undefined, alone)).toBeNull();
  });
  it('is not taken against a held answer', async () => {
    expect(await agreed(['a', 'b'], answers({ b: 'nothing' }, []), undefined, { value: 'shield', by: ['a'] }, alone)).toBeNull();
  });
});

describe("a block's MASP events", () => {
  const transfer = (inner: string, from: string, amount: string, post: string, reversed = false) => {
    const attributes = [
      { key: 'source-accounts', value: JSON.stringify([[[from, NAM], amount]]) },
      { key: 'target-accounts', value: JSON.stringify([[[MASP, NAM], amount]]) },
      { key: 'post-balances', value: JSON.stringify([[[MASP, NAM], post]]) },
      { key: 'inner-tx-hash', value: inner },
    ];
    return { result: { finalize_block_events: [{ type: 'token/transfer', attributes: reversed ? attributes.reverse() : attributes }] } };
  };
  const forged = transfer('BEEF', 'tnam1forged', '5000000000000', '1000000000');
  const real = transfer('AAAA', 'tnam1x', '1000000', '1000000000');
  const nodes = ['5elements', 'papadritta', 'polkachu', 'stakeandrelax'];
  const get = (by: Record<string, unknown>, asked: string[] = []) => async (url: string) => {
    const node = url.split('/block_results')[0];
    asked.push(node);
    if (!(node in by)) throw new Error('HTTP 500');
    return by[node];
  };
  const inner = (b: { value: { events: { attrs: Record<string, string> }[] } } | null) => b?.value.events[0].attrs['inner-tx-hash'];

  it("a block one node gives alone is not taken when the others fail (the Worker's two nodes down, polkachu forging)", async () => {
    await expect(agreedBlock(200, nodes, get({ polkachu: forged }))).rejects.toThrow(/no 2 nodes gave the same events/);
  });
  it('the block two nodes agree on is taken, past a Worker node that lies', async () => {
    const b = await agreedBlock(200, nodes, get({ '5elements': forged, papadritta: real, polkachu: transfer('AAAA', 'tnam1x', '1000000', '1000000000', true) }));
    expect(inner(b)).toBe('AAAA');
    expect(b!.by).toEqual(['papadritta', 'polkachu']); // the attribute order of an event is not part of the answer
  });
  it('a block cached from one node is asked of the others: confirmed by one more, replaced when two others agree', async () => {
    const held = (from: unknown, node: string) => ({ value: maspEvents(from)!, by: [node] });
    const asked: string[] = [];
    const kept = await agreedBlock(200, nodes, get({ '5elements': real, papadritta: real }, asked), held(real, '5elements'));
    expect(kept!.by).toEqual(['5elements', 'papadritta']);
    expect(asked).toEqual(['papadritta']);
    const replaced = await agreedBlock(200, nodes, get({ '5elements': real, papadritta: real }), held(forged, 'polkachu'));
    expect(inner(replaced)).toBe('AAAA');
    expect(replaced!.by).toEqual(['5elements', 'papadritta']);
    await expect(agreedBlock(200, nodes, get({}), held(forged, 'polkachu'))).rejects.toThrow();
  });
  it('a block with no MASP NAM transfer may come from one node, and every node without the block is null', async () => {
    const empty = { result: { finalize_block_events: [{ type: 'tx/applied', attributes: [] }] } };
    const noMasp = (b: { events: unknown[] }) => b.events.length === 0;
    expect((await agreedBlock(200, nodes, get({ '5elements': empty }), undefined, noMasp))!.by).toEqual(['5elements']);
    await expect(agreedBlock(200, nodes, get({ '5elements': forged }), undefined, noMasp)).rejects.toThrow();
    expect(await agreedBlock(200, nodes, get(Object.fromEntries(nodes.map((n) => [n, { result: {} }]))))).toBeNull();
  });
});

describe('the backfill reads its chain data through these checks', () => {
  const src = readFileSync(join(__dirname, '..', 'scripts', 'backfill-history.ts'), 'utf8');
  it('block times through metaTimes and agreement, block_results only through agreedBlock', () => {
    expect(src).toMatch(/agreed\(rpcs, async \(rpc\) => metaTimes\(/);
    expect(src).toMatch(/agreedBlock\(h, rpcs,/);
    expect(src).not.toMatch(/block_results\?height=/);
  });
});
