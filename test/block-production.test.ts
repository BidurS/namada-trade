// Whether Namada is making blocks (shared/block-production.ts), judged from the stored node and indexer cross-checks
// as the cron writes them. The reading of 10 Nov 2026 is the shape the check held while the network stood still:
// two nodes not answering, one at the halt block, the indexer at the same block.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { blockProduction, blocksSentence, blocksWho, BLOCKS_STOPPED_AFTER_MS, BLOCKS_READING_MAX_AGE_MS } from '../shared/block-production';
import { NAMADA_CHAIN_ID } from '../shared/config';
import { NAMADA } from '../worker/src/config';
import { statusFacts } from '../worker/src/seo';
import { app } from '../worker/src/api';
import { testD1 } from './d1-sqlite';
import type { Overview } from '../shared/types';

afterEach(() => { vi.useRealTimers(); });

const readAt = Date.UTC(2026, 10, 10, 23, 59);
const haltBlock = { provider: 'StakeAndRelax', network: NAMADA_CHAIN_ID, height: 8517986, time: Date.UTC(2026, 10, 2, 22, 49, 36), catchingUp: false, earliest: 1 };
const down = (provider: string) => ({ provider, error: `Error: HTTP 502 for https://${provider.toLowerCase()}.example/status` });
const rpc = (statuses: unknown[], at = readAt) => ({ key: 'rpc_consensus', detail: { statuses, heightDiff: null }, checkedAt: at });
const idx = (indexerHeight: number, at = readAt) => ({ key: 'indexer_lag', detail: { indexerHeight, rpcHeight: indexerHeight, lagBlocks: 0 }, checkedAt: at });

describe('whether Namada is making blocks', () => {
  it('reads the chain this site reads', () => {
    expect(NAMADA.chainId).toBe(NAMADA_CHAIN_ID);
  });

  it('while the network stands still: no block since the halt block, said with how many nodes answered and the indexer', () => {
    const b = blockProduction([rpc([down('5ElementsNodes'), down('Papadritta'), haltBlock]), idx(8517986)], readAt + 30_000);
    expect(b).toMatchObject({ state: 'stopped', height: 8517986, blockAt: haltBlock.time, readAt, asked: 3, answered: 1, silent: 2, catching: 0, unusable: 0, indexerHeight: 8517986, oldReading: false, why: null });
    expect(blocksSentence(b)).toBe('At the last reading Namada had made no block since block 8,517,986, made at 2 Nov 2026, 22:49 UTC: 8 days earlier.');
    expect(blocksWho(b)).toBe('Of 3 Namada nodes asked, 1 gave its newest block and 2 did not answer; the network indexer\'s newest block is the same.');
  });

  it('while blocks are made: the newest, from the node furthest ahead', () => {
    const fresh = (provider: string, height: number, ago: number) => ({ provider, network: NAMADA_CHAIN_ID, height, time: readAt - ago, catchingUp: false });
    const b = blockProduction([rpc([fresh('A', 9_000_010, 7_000), fresh('B', 9_000_012, 2_000), down('C')]), idx(9_000_011)], readAt);
    expect(b).toMatchObject({ state: 'making', height: 9_000_012, answered: 2, asked: 3 });
    expect(blocksSentence(b)).toBe('At the last reading Namada was making blocks: the newest, block 9,000,012, was made at 10 Nov 2026, 23:58 UTC.');
    expect(blocksWho(b)).toBe('Of 3 Namada nodes asked, 2 gave their newest block and 1 did not answer; the network indexer\'s newest block is 9,000,011.');
    // the bound: a block exactly that old is still made in time, a moment older is not
    const at = (age: number) => blockProduction([rpc([fresh('A', 5, age), fresh('B', 5, age)])], readAt).state;
    expect(at(BLOCKS_STOPPED_AFTER_MS)).toBe('making');
    expect(at(BLOCKS_STOPPED_AFTER_MS + 1)).toBe('stopped');
  });

  it('cannot tell when no node answered, or when the node that answered is behind the indexer', () => {
    const none = blockProduction([rpc([down('A'), down('B')]), idx(8517986)], readAt);
    expect(none).toMatchObject({ state: 'unknown', answered: 0, asked: 2, height: null });
    expect(blocksSentence(none)).toBe('No Namada node answered at the last reading.');
    const behind = blockProduction([rpc([haltBlock]), idx(8517990)], readAt);
    expect(behind.state).toBe('unknown');
    expect(blocksSentence(behind)).toBe('The Namada node that gave its newest block was behind the network indexer, so the reading cannot tell whether blocks are being made.');
    // one node's old block with nothing to confirm it: a node that stopped looks the same as a network that did
    const alone = blockProduction([rpc([down('A'), haltBlock])], readAt);
    expect(alone.state).toBe('unknown');
    expect(blocksSentence(alone)).toBe('Only one Namada node gave its newest block, and nothing else confirmed it, so the reading cannot tell whether blocks are being made.');
    // two nodes at the same old block confirm each other; two at different old blocks do not, and say so
    expect(blockProduction([rpc([haltBlock, { ...haltBlock, provider: 'B' }])], readAt).state).toBe('stopped');
    const apart = blockProduction([rpc([haltBlock, { ...haltBlock, provider: 'B', height: 8517900 }])], readAt);
    expect(apart.state).toBe('unknown');
    expect(blocksSentence(apart)).toBe('The Namada nodes that gave their newest block gave different ones, and the newest was not confirmed by another node or the indexer, so the reading cannot tell whether blocks are being made.');
    // nodes that answered but were catching up are said as such, not as silent
    const catching = blockProduction([rpc([{ ...haltBlock, catchingUp: true }, { ...haltBlock, provider: 'B', catchingUp: true }, down('C')])], readAt);
    expect(catching).toMatchObject({ state: 'unknown', answered: 0, catching: 2, silent: 1 });
    expect(blocksSentence(catching)).toBe('The Namada nodes that answered were still catching up, so the reading cannot tell whether blocks are being made.');
    expect(blocksWho(catching)).toBe('Of 3 Namada nodes asked, 2 were still catching up and 1 did not answer.');
  });

  it('a node whose clock is ahead is not used, and any recent block shows blocks are being made', () => {
    const ahead = { ...haltBlock, provider: 'B', height: 8517990, time: readAt + 10 * 60_000 };
    const b = blockProduction([rpc([haltBlock, ahead]), idx(8517986)], readAt);
    expect(b).toMatchObject({ state: 'stopped', height: 8517986, unusable: 1 });
    // a stuck node far ahead in height does not hide another node's recent block
    const stuckHigh = { ...haltBlock, provider: 'A', height: 9_000_100, time: readAt - 3_600_000 };
    const fresh = { ...haltBlock, provider: 'B', height: 9_000_050, time: readAt - 5_000 };
    expect(blockProduction([rpc([stuckHigh, fresh])], readAt)).toMatchObject({ state: 'making', height: 9_000_050 });
  });

  it('counts a node on another chain as unusable, and an answer with no newest block as giving none', () => {
    const other = { ...haltBlock, network: 'another-chain', height: 9_999_999, time: readAt };
    const odd = [{ ...haltBlock, height: 'x' }, { ...haltBlock, time: null }, null, 'text', { ...haltBlock, height: 0 }];
    const b = blockProduction([rpc([other, ...odd, haltBlock]), idx(8517986)], readAt);
    expect(b).toMatchObject({ state: 'stopped', height: 8517986, answered: 1, unusable: 1, silent: 5, asked: 7 });
    // a node that names no chain is this chain's, as the cron counts it
    expect(blockProduction([rpc([{ ...haltBlock, network: '' }]), idx(8517986)], readAt)).toMatchObject({ state: 'stopped', answered: 1, unusable: 0 });
  });

  it('at the restart: a node still catching up on new blocks shows blocks are being made, and never lets "stopped" stand', () => {
    // one node still at the halt block (old binary), one syncing the new blocks, one down, the indexer still at the halt
    const syncing = { ...haltBlock, provider: '5ElementsNodes', catchingUp: true, height: 8518026, time: readAt - 60_000 };
    const r1 = blockProduction([rpc([haltBlock, syncing, down('Papadritta')]), idx(8517986)], readAt);
    expect(r1).toMatchObject({ state: 'making', height: 8518026, answered: 1, catching: 1, silent: 1 });
    // syncing far behind (an old block), but past the halt block the others give: the chain has moved, so it cannot tell
    const behind = { ...syncing, height: 8517990, time: haltBlock.time + 60_000 };
    const r2 = blockProduction([rpc([haltBlock, { ...haltBlock, provider: 'B' }, behind])], readAt);
    expect(r2.state).toBe('unknown');
    expect(blocksSentence(r2)).toBe('The Namada nodes that gave their newest block were behind a node still catching up, so the reading cannot tell whether blocks are being made.');
    // a node starting a state sync answers with no block yet: catching up, not silent
    const starting = { provider: 'C', network: NAMADA_CHAIN_ID, catchingUp: true, height: 0, time: 0 };
    const one = blockProduction([rpc([starting, down('A')])], readAt);
    expect(one).toMatchObject({ state: 'unknown', catching: 1, silent: 1 });
    expect(blocksSentence(one)).toBe('The Namada node that answered was still catching up, so the reading cannot tell whether blocks are being made.');
  });

  it('takes the indexer only from the same reading, says an old reading is old, and reads a row whose detail is text', () => {
    expect(blockProduction([rpc([haltBlock]), idx(8517999, readAt - 10 * 60_000)], readAt).indexerHeight).toBeNull();
    expect(blockProduction([rpc([haltBlock])], readAt + BLOCKS_READING_MAX_AGE_MS + 1).oldReading).toBe(true);
    const text = blockProduction([{ key: 'rpc_consensus', detail: JSON.stringify({ statuses: [haltBlock, { ...haltBlock, provider: 'B' }] }), checkedAt: readAt }], readAt);
    expect(text.state).toBe('stopped');
    expect(blockProduction([{ key: 'rpc_consensus', detail: '{not json', checkedAt: readAt }], readAt).state).toBe('unknown');
  });

  it('before the nodes were ever asked, says nothing as a figure', () => {
    const b = blockProduction([], readAt);
    expect(b).toMatchObject({ state: 'unknown', readAt: null });
    expect(blocksSentence(b)).toBeNull();
    expect(blocksWho(b)).toBeNull();
    expect(blockProduction(null, readAt).readAt).toBeNull();
  });

  it('the served status page states it as a figure with its source and the time of the reading', () => {
    const rows = [
      { key: 'rpc_consensus', status: 'warn', detail: JSON.stringify({ statuses: [down('A'), down('B'), haltBlock] }), checked_at: readAt },
      { key: 'indexer_lag', status: 'ok', detail: JSON.stringify({ indexerHeight: 8517986 }), checked_at: readAt },
    ];
    const f = statusFacts(rows, readAt, readAt + 1_000);
    expect(f.blocks).toEqual({
      text: 'At the last reading Namada had made no block since block 8,517,986, made at 2 Nov 2026, 22:49 UTC: 8 days earlier. Of 3 Namada nodes asked, 1 gave its newest block and 2 did not answer; the network indexer\'s newest block is the same.',
      at: readAt,
      source: 'Namada nodes and the network indexer',
    });
    expect(statusFacts([], null, readAt).blocks).toBeUndefined();
  });

  it('the overview dates Namada\'s newest block by its own time while no block is made, and by the reading while blocks are made', async () => {
    const db = testD1();
    const put = (key: string, detail: unknown) => db.raw.prepare('INSERT OR REPLACE INTO checks (key, status, title, detail, checked_at) VALUES (?, ?, ?, ?, ?)').run(key, 'warn', key, JSON.stringify(detail), readAt);
    put('rpc_consensus', { statuses: [down('A'), down('B'), haltBlock], heightDiff: null });
    put('indexer_lag', { indexerHeight: 8517986, rpcHeight: 8517986, lagBlocks: 0 });
    vi.useFakeTimers({ now: readAt + 20_000, toFake: ['Date'] });
    const still = ((await (await app.request('/api/overview', {}, { DB: db } as any)).json()) as Overview).heads.namada;
    expect(still.value).toBe(8517986);
    expect(still.prov).toMatchObject({ source: 'Namada RPC status', at: haltBlock.time, height: 8517986, status: 'stale' });
    expect(still.prov.note).toContain('At the last reading Namada had made no block since block 8,517,986');
    put('rpc_consensus', { statuses: [{ ...haltBlock, height: 8600000, time: readAt - 6_000 }], heightDiff: null });
    const moving = ((await (await app.request('/api/overview', {}, { DB: db } as any)).json()) as Overview).heads.namada;
    expect(moving.prov).toMatchObject({ at: readAt, status: 'live' });
    // the reading cannot tell (the indexer missed this reading), yet the block shown is old: still dated by the block
    put('rpc_consensus', { statuses: [down('A'), down('B'), haltBlock], heightDiff: null });
    db.raw.prepare('UPDATE checks SET checked_at = ? WHERE key = ?').run(readAt - 3 * 60_000, 'indexer_lag');
    const unsure = ((await (await app.request('/api/overview', {}, { DB: db } as any)).json()) as Overview).heads.namada;
    expect(unsure.prov).toMatchObject({ at: haltBlock.time, status: 'stale' });
    expect(unsure.prov.note).toContain('Only one Namada node gave its newest block');
    // a node on another chain, far ahead, is not the head shown
    put('rpc_consensus', { statuses: [haltBlock, { ...haltBlock, provider: 'B' }, { ...haltBlock, provider: 'X', network: 'other-1', height: 9_999_999, time: readAt }], heightDiff: null });
    const elsewhere = ((await (await app.request('/api/overview', {}, { DB: db } as any)).json()) as Overview).heads.namada;
    expect(elsewhere).toMatchObject({ value: 8517986, prov: { at: haltBlock.time, status: 'stale' } });
    // at the restart, only a node still catching up shows new blocks: making, so the head is live, not old without a reason
    put('rpc_consensus', { statuses: [down('A'), down('B'), { ...haltBlock, catchingUp: true, height: 8518086, time: readAt - 30_000 }], heightDiff: null });
    const syncing = ((await (await app.request('/api/overview', {}, { DB: db } as any)).json()) as Overview).heads.namada;
    expect(syncing).toMatchObject({ value: 8518086, prov: { at: readAt, status: 'live' } });
    // a node still catching up, at a block above the halt but old, is the head shown: stamped old with the reason, never live
    put('rpc_consensus', { statuses: [haltBlock, { ...haltBlock, provider: 'B' }, { ...haltBlock, catchingUp: true, height: 8518036, time: readAt - 20 * 60_000 }], heightDiff: null });
    const behind = ((await (await app.request('/api/overview', {}, { DB: db } as any)).json()) as Overview).heads.namada;
    expect(behind.value).toBe(8518036);
    expect(behind.prov).toMatchObject({ status: 'stale' });
    expect(behind.prov.note).toContain('behind a node still catching up');
    // no node answered: the reading happened, but it is not a live reading of the head
    put('rpc_consensus', { statuses: [down('A'), down('B'), down('C')], heightDiff: null });
    const silent = ((await (await app.request('/api/overview', {}, { DB: db } as any)).json()) as Overview).heads.namada;
    expect(silent.prov).toMatchObject({ at: readAt, status: 'stale', note: 'No Namada node answered at the last reading.' });
  });
});
