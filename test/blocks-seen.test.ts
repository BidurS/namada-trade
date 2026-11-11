// One line to the operator the first time, while the alerts are paused, that a tick sees Namada making blocks
// (worker/src/blocks-seen.ts). It goes around the pause, to the operator's two places only, once for a pause. What is
// pinned: who counts as a witness (a node with a block from the last minutes; the indexer only once past the height
// the nodes stood at), that two are needed, that the line is posted once whatever the ticks, that only a try every
// place proved it refused is made again, spaced and a few times at most, that a try whose outcome is unknown (an
// answer that may have posted, or a record not written after one did) is never made again, and what the line says.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BLOCKS_SEEN_RETRY_MS, BLOCKS_SEEN_TRIES, blocksSeenKv, blocksSeenLine, noteBlocksSeen, nodesOf, resetBlocksSeenMemory, stoodAt, witnessesOf, type StatusLike,
} from '../worker/src/blocks-seen';
import { HEAD_AGREE_BLOCKS, HEAD_MAX_AGE_MS, MAX_HEAD_HEIGHT } from '../worker/src/sources/namada';
import { NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.unstubAllGlobals(); resetBlocksSeenMemory(); });

const NOW = Date.UTC(2026, 5, 20, 12, 0);
const MIN = 60_000;
const OLD = 8_000_000;
const HOOK = 'https://discord.com/api/webhooks/7/operator';
const PAUSE = 'a pause';
const env = (db: TestD1, over: object = {}) => ({ DB: db, SEND_ALERTS: 'yes', ALERTS_PAUSED: PAUSE, DISCORD_WEBHOOK_URL: HOOK, TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_OWNER_CHAT: '4242', ...over }) as any;
const record = (db: TestD1, pause = PAUSE) => { const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(blocksSeenKv(pause)) as any; return r ? JSON.parse(r.value) : null; };
const node = (height: number, time: number, over: Partial<StatusLike> = {}): StatusLike => ({ height, time, catchingUp: false, network: NAMADA.chainId, ...over });
/** Every node at the old block, made days ago: the ticks while no block is made. */
const STOOD = (at = NOW) => [node(OLD, at - 3 * 86_400_000), node(OLD, at - 3 * 86_400_000)];
/** Two nodes at new blocks: two witnesses, whatever the indexer says. */
const TWO = (at = NOW) => [node(OLD + 50, at - 20_000), node(OLD + 52, at - 10_000)];
const LINE = 'Namada nodes report new blocks: block 8,000,050, made 2026-06-20 11:59 UTC, read on 2 nodes. The halt bar and the alert pause on this site are still on.';

/** Every request made, with its body; Discord and Telegram answer with the statuses given (0: no answer). */
function places(status: { discord: number; telegram: number } = { discord: 204, telegram: 200 }) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const st = url === HOOK ? status.discord : url.startsWith('https://api.telegram.org/') ? status.telegram : 404;
    if (st === 0) throw new Error('no answer');
    if (url.startsWith('https://api.telegram.org/')) return new Response(JSON.stringify(st === 200 ? { ok: true, result: {} } : { ok: false, error_code: st, description: 'no' }), { status: st, headers: { 'content-type': 'application/json' } });
    return new Response(null, { status: st });
  }));
  return calls;
}
const hookCalls = (calls: { url: string }[]) => calls.filter((c) => c.url === HOOK).length;

describe('the line', () => {
  it('says the block, its time and who gave it, and which of the site\'s switches are on; nothing about why', () => {
    expect(blocksSeenLine({ height: OLD + 50, blockAt: NOW - 20_000, nodes: 2, indexer: false }, true)).toBe(LINE);
    expect(blocksSeenLine({ height: 12, blockAt: null, nodes: 1, indexer: true }, true)).toBe('A Namada node reports new blocks: block 12, read on 1 node and the network indexer. The halt bar and the alert pause on this site are still on.');
    // the halt bar read as it is: off, the line does not say it is on
    expect(blocksSeenLine({ height: 12, blockAt: null, nodes: 2, indexer: true }, false)).toBe('Namada nodes report new blocks: block 12, read on 2 nodes and the network indexer. The alert pause on this site is still on.');
  });
});

describe('the witnesses', () => {
  const seen = (height: number, time: number) => ({ height, time, fresh: time > NOW - HEAD_MAX_AGE_MS });

  it('a node on this chain, not catching up, with a height and a block time not ahead of the reading, is read; any other answer is not', () => {
    const r = nodesOf([
      node(OLD + 9, NOW - 10_000),
      node(OLD, NOW - HEAD_MAX_AGE_MS - 1),
      node(OLD + 7, NOW - 10_000, { catchingUp: true }),
      node(OLD + 8, NOW - 10_000, { network: 'another-chain' }),
      node(OLD + 6, NOW - 10_000, { network: undefined }),
      { error: 'down' },
      node(OLD + 5, NOW + 10 * MIN),
      node(Number.NaN, NOW - 10_000),
      node(MAX_HEAD_HEIGHT + 1, NOW - 86_400_000),
    ], NOW);
    expect(r).toEqual([{ height: OLD + 9, time: NOW - 10_000, fresh: true }, { height: OLD, time: NOW - HEAD_MAX_AGE_MS - 1, fresh: false }]);
  });

  it('the height the nodes stand at is the highest two of them agree on, when none has a recent block: one node alone, whatever it says, sets nothing', () => {
    expect(stoodAt([seen(OLD, NOW - 86_400_000), seen(OLD, NOW - 86_400_000)])).toBe(OLD);
    // a node that synced part of the way agrees within the span: the higher height stands
    expect(stoodAt([seen(OLD - 40, NOW - 86_400_000), seen(OLD, NOW - 86_400_000)])).toBe(OLD);
    // one node far above the others is not agreed with
    expect(stoodAt([seen(OLD, NOW - 86_400_000), seen(OLD, NOW - 86_400_000), seen(900_000_000, NOW - 86_400_000)])).toBe(OLD);
    expect(stoodAt([seen(OLD, NOW - 86_400_000)])).toBeNull();
    // a node at a recent block: the nodes are not standing
    expect(stoodAt([seen(OLD, NOW - 86_400_000), seen(OLD, NOW - 86_400_000), seen(OLD + 5, NOW - 10_000)])).toBeNull();
  });

  it('two nodes past the height the nodes stood at, near each other, are two witnesses: at recent blocks, or at older ones (blocks were made and stopped)', () => {
    expect(witnessesOf([seen(OLD + 50, NOW - 20_000), seen(OLD + 52, NOW - 10_000)], null, OLD)).toEqual({ height: OLD + 50, blockAt: NOW - 20_000, nodes: 2, indexer: false });
    expect(witnessesOf([seen(OLD + 40, NOW - 9 * MIN), seen(OLD + 40, NOW - 9 * MIN)], OLD, OLD)).toEqual({ height: OLD + 40, blockAt: NOW - 9 * MIN, nodes: 2, indexer: false });
    // far apart: not two witnesses
    expect(witnessesOf([seen(OLD + 50, NOW), seen(OLD + 51 + HEAD_AGREE_BLOCKS, NOW)], null, OLD)).toBeNull();
    // with no height recorded, only recent blocks witness a new block
    expect(witnessesOf([seen(OLD + 50, NOW - 20_000), seen(OLD + 52, NOW - 10_000)], null, null)).toMatchObject({ nodes: 2 });
    expect(witnessesOf([seen(OLD + 50, NOW - 9 * MIN), seen(OLD + 50, NOW - 9 * MIN)], null, null)).toBeNull();
  });

  it('one node past it needs the indexer past it too; the indexer at the old height, or no height recorded, is no witness', () => {
    const one = [seen(OLD + 60, NOW - 10_000), seen(OLD, NOW - 86_400_000)];
    expect(witnessesOf(one, OLD + 1, OLD)).toEqual({ height: OLD + 60, blockAt: NOW - 10_000, nodes: 1, indexer: true });
    expect(witnessesOf(one, OLD, OLD)).toBeNull();
    expect(witnessesOf(one, OLD + 500, null)).toBeNull();
    // a node whose block is recent but not past where the nodes stood is no witness of a new block
    expect(witnessesOf([seen(OLD, NOW)], OLD + 1, OLD)).toBeNull();
  });
});

describe('noteBlocksSeen', () => {
  it('a Worker that is not paused sends nothing and records nothing, whatever it sees', async () => {
    const calls = places();
    for (const over of [{ ALERTS_PAUSED: undefined }, { SEND_ALERTS: undefined }, { ALERTS_PAUSED: '' }]) {
      const db = testD1();
      expect(await noteBlocksSeen(env(db, over), TWO(), OLD + 50, NOW)).toBe('not paused');
      expect(record(db)).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it('paused, every node at the old block: nothing is sent; the height they stand at is recorded once, and an isolate that knows it asks nothing more', async () => {
    const calls = places();
    const db = testD1();
    expect(await noteBlocksSeen(env(db), STOOD(), OLD, NOW)).toBe('no new block');
    expect(record(db)).toEqual({ before: OLD });
    const q = db.queries;
    for (let i = 1; i <= 5; i++) expect(await noteBlocksSeen(env(db), STOOD(NOW + i * MIN), OLD, NOW + i * MIN)).toBe('no new block');
    expect(db.queries).toBe(q);
    // another isolate reads the record once, and is quiet after
    resetBlocksSeenMemory();
    await noteBlocksSeen(env(db), STOOD(), OLD, NOW + 6 * MIN);
    expect(db.queries).toBe(q + 1);
    await noteBlocksSeen(env(db), STOOD(), OLD, NOW + 7 * MIN);
    expect(db.queries).toBe(q + 1);
    expect(calls).toEqual([]);
  });

  it('one node giving a far-too-high height, or a node lagging, cannot set or move the recorded height, so the line still comes', async () => {
    const calls = places();
    const db = testD1();
    expect(await noteBlocksSeen(env(db), [...STOOD(), node(MAX_HEAD_HEIGHT - 1, NOW - 86_400_000)], OLD, NOW)).toBe('no new block');
    expect(record(db)).toEqual({ before: OLD });
    // the recorded height is never moved: a later tick with the nodes at another height does not change it
    resetBlocksSeenMemory();
    await noteBlocksSeen(env(db), [node(OLD - 30, NOW - 86_400_000), node(OLD - 30, NOW - 86_400_000)], OLD, NOW + MIN);
    expect(record(db)).toEqual({ before: OLD });
    // blocks made: one node at a recent block, one lagging six minutes, the indexer behind both but past the old block
    expect(await noteBlocksSeen(env(db), [node(OLD + 70, NOW + 2 * MIN - 10_000), node(OLD + 40, NOW + 2 * MIN - 6 * MIN)], OLD + 20, NOW + 2 * MIN)).toBe('told');
    expect(calls[0].body.content).toContain('Namada nodes report new blocks: block 8,000,040');
  });

  it('a run of blocks that ended before any tick saw two witnesses at once: two nodes past the recorded height are told, with the block\'s own time', async () => {
    const calls = places();
    const db = testD1();
    await noteBlocksSeen(env(db), STOOD(), OLD, NOW);
    expect(await noteBlocksSeen(env(db), [node(OLD + 40, NOW - 9 * MIN), node(OLD + 40, NOW - 9 * MIN)], OLD + 40, NOW + 10 * MIN)).toBe('told');
    expect(calls[0].body.content).toBe('Namada nodes report new blocks: block 8,000,040, made 2026-06-20 11:51 UTC, read on 2 nodes and the network indexer. The halt bar and the alert pause on this site are still on.');
  });

  it('one fresh node and the indexer still at the old height: one witness, nothing sent; the indexer past it: the line', async () => {
    const calls = places();
    const db = testD1();
    await noteBlocksSeen(env(db), STOOD(NOW - MIN), OLD, NOW - MIN);
    expect(await noteBlocksSeen(env(db), [node(OLD + 60, NOW - 10_000), node(OLD, NOW - 86_400_000)], OLD, NOW)).toBe('one witness');
    expect(calls).toEqual([]);
    expect(await noteBlocksSeen(env(db), [node(OLD + 70, NOW + MIN - 10_000)], OLD + 2, NOW + MIN)).toBe('told');
    expect(calls[0].body.content).toBe('A Namada node reports new blocks: block 8,000,070, made 2026-06-20 12:00 UTC, read on 1 node and the network indexer. The halt bar and the alert pause on this site are still on.');
  });

  it('two witnesses: the line goes once to the operator\'s webhook and the owner\'s chat, and to nowhere else; later ticks send nothing', async () => {
    const calls = places();
    const db = testD1();
    expect(await noteBlocksSeen(env(db), TWO(), null, NOW)).toBe('told');
    // an isolate that knows the line was told asks nothing more
    resetBlocksSeenMemory();
    expect(await noteBlocksSeen(env(db), TWO(NOW + MIN), null, NOW + MIN)).toBe('told before');
    const q = db.queries;
    expect(await noteBlocksSeen(env(db), TWO(NOW + 2 * MIN), null, NOW + 2 * MIN)).toBe('told before');
    expect(db.queries).toBe(q);
    expect(calls.map((c) => c.url)).toEqual([HOOK, 'https://api.telegram.org/botbot-token/sendMessage']);
    // Discord: plain text, no mention can fire, the site's own sender name
    expect(calls[0].body).toMatchObject({ content: LINE, allowed_mentions: { parse: [] } });
    expect(Object.keys(calls[0].body).sort()).toEqual(['allowed_mentions', 'avatar_url', 'content', 'username']);
    // Telegram: the owner's chat, the same words
    expect(calls[1].body.chat_id).toBe('4242');
    expect(calls[1].body.text).toBe(LINE);
    expect(record(db)).toMatchObject({ height: OLD + 50, tries: 1, pendingAt: NOW, toldAt: NOW });
    for (const at of [NOW + MIN, NOW + 2 * MIN, NOW + 24 * 60 * MIN]) expect(await noteBlocksSeen(env(db), TWO(at), null, at)).toBe('told before');
    expect(calls).toHaveLength(2);
  });

  it('one place taking it is enough', async () => {
    places({ discord: 503, telegram: 200 });
    const db = testD1();
    expect(await noteBlocksSeen(env(db), TWO(), null, NOW)).toBe('told');
    expect(record(db).toldAt).toBe(NOW);
  });

  it('every place proved it refused: tried again no sooner than BLOCKS_SEEN_RETRY_MS, BLOCKS_SEEN_TRIES in all, then no more', async () => {
    const calls = places({ discord: 503, telegram: 429 });
    const db = testD1();
    const did: string[] = [];
    let at = NOW;
    expect(await noteBlocksSeen(env(db), TWO(at), null, at)).toBe('not taken');
    for (let i = 1; i < BLOCKS_SEEN_TRIES; i++) {
      expect(await noteBlocksSeen(env(db), TWO(at + MIN), null, at + MIN)).toBe('waiting');
      at += BLOCKS_SEEN_RETRY_MS;
      did.push(await noteBlocksSeen(env(db), TWO(at), null, at));
    }
    expect(did).toEqual(Array(BLOCKS_SEEN_TRIES - 1).fill('not taken'));
    at += BLOCKS_SEEN_RETRY_MS;
    expect(await noteBlocksSeen(env(db), TWO(at), null, at)).toBe('tries used');
    expect(hookCalls(calls)).toBe(BLOCKS_SEEN_TRIES);

    // a later try that is taken: told, and nothing after it
    const later = testD1();
    places({ discord: 502, telegram: 503 });
    expect(await noteBlocksSeen(env(later), TWO(), null, NOW)).toBe('not taken');
    const ok = places();
    expect(await noteBlocksSeen(env(later), TWO(NOW + BLOCKS_SEEN_RETRY_MS), null, NOW + BLOCKS_SEEN_RETRY_MS)).toBe('told');
    expect(await noteBlocksSeen(env(later), TWO(NOW + BLOCKS_SEEN_RETRY_MS + MIN), null, NOW + BLOCKS_SEEN_RETRY_MS + MIN)).toBe('told before');
    expect(hookCalls(ok)).toBe(1);
  });

  it('an answer that may have posted (no answer, or a 500), from either place: never tried again', async () => {
    for (const st of [{ discord: 0, telegram: 503 }, { discord: 500, telegram: 503 }, { discord: 503, telegram: 0 }]) {
      const calls = places(st);
      const db = testD1();
      expect(await noteBlocksSeen(env(db), TWO(), null, NOW), JSON.stringify(st)).toBe('outcome unknown');
      expect(await noteBlocksSeen(env(db), TWO(NOW + 2 * BLOCKS_SEEN_RETRY_MS), null, NOW + 2 * BLOCKS_SEEN_RETRY_MS)).toBe('outcome unknown');
      expect(hookCalls(calls)).toBe(1);
    }
  });

  it('a post that was taken and whose record was not written after it: never posted again', async () => {
    const calls = places();
    const db = testD1();
    const real = db.prepare.bind(db);
    // the write of the outcome fails; the write before the try lands
    (db as any).prepare = (sql: string) => (sql === 'UPDATE kv SET value = ?, updated_at = ? WHERE key = ?'
      ? { bind: () => ({ run: async () => { throw new Error('D1_ERROR: simulated'); } }) }
      : real(sql));
    expect(await noteBlocksSeen(env(db), TWO(), null, NOW)).toBe('told');
    (db as any).prepare = real;
    expect(record(db)).toMatchObject({ tries: 1, pendingAt: NOW, toldAt: null });
    for (const at of [NOW + MIN, NOW + 2 * BLOCKS_SEEN_RETRY_MS]) expect(await noteBlocksSeen(env(db), TWO(at), null, at)).toBe('outcome unknown');
    expect(hookCalls(calls)).toBe(1);
  });

  it('no place set: nothing sent; a record that cannot be read is taken as told; another pause has a line of its own', async () => {
    const calls = places();
    const db = testD1();
    expect(await noteBlocksSeen(env(db, { DISCORD_WEBHOOK_URL: undefined, TELEGRAM_OWNER_CHAT: undefined }), TWO(), null, NOW)).toBe('no place');
    db.raw.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run(blocksSeenKv(PAUSE), 'not json');
    expect(await noteBlocksSeen(env(db), TWO(), null, NOW)).toBe('told before');
    expect(calls).toEqual([]);
    expect(await noteBlocksSeen(env(db, { ALERTS_PAUSED: 'another pause' }), TWO(), null, NOW)).toBe('told');
    expect(hookCalls(calls)).toBe(1);
  });

  it('two nodes at the first block after a stretch whose header carries the time the last block was agreed on: the line says when it was read, not that time', async () => {
    const calls = places();
    const db = testD1();
    // the nodes standing at the last block of the current stretch, then at the block after it (its header: 2 November)
    const AT = Date.UTC(2026, 10, 11, 14, 0);
    const last = Date.UTC(2026, 10, 2, 22, 49, 36, 642), agreed = Date.UTC(2026, 10, 2, 22, 49, 51, 200);
    await noteBlocksSeen(env(db), [node(8_517_986, last), node(8_517_986, last)], 8_517_986, AT - MIN);
    expect(await noteBlocksSeen(env(db), [node(8_517_987, agreed), node(8_517_987, agreed)], 8_517_986, AT)).toBe('told');
    expect(calls[0].body.content).toMatch(/^Namada nodes report new blocks: block 8,517,987, read 2026-11-11 14:00 UTC, read on 2 nodes\. /);
  });

  it('two runs at once: one posts', async () => {
    const calls = places();
    const db = testD1();
    const r = await Promise.all([noteBlocksSeen(env(db), TWO(), null, NOW), noteBlocksSeen(env(db), TWO(), null, NOW)]);
    expect(r.sort()).toEqual(['another run', 'told']);
    expect(hookCalls(calls)).toBe(1);
  });
});
