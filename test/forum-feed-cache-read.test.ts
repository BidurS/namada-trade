// Security review (2026-10-22), the forum feed: when the forum's posts could not be read on a tick whose read of the
// stored copy (intel.cache) failed too (a transient D1 error), the cron wrote the copy with no posts under a note saying
// the cached posts were kept, and every later tick while the posts read kept failing read that empty list back. A
// failed read of the stored copy is now told apart from a missing one: nothing is written over it that tick.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FETCH_TEXT_MAX_BYTES } from '../worker/src/util';
import { runCron, FORUM_POSTS_HEALTH } from '../worker/src/cron';
import { testD1, insert, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const TOPICS = { topic_list: { topics: [{ id: 100, title: 'Governance', slug: 'gov', category_id: 4, created_at: '2026-10-01T00:00:00Z', last_posted_at: '2026-10-01T00:00:00Z' }] } };
const tooLarge = () => new Response('{"latest_posts":[]}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(FETCH_TEXT_MAX_BYTES + 1) } });
const PLAIN = Date.parse('2026-10-17T22:41:05Z');
const CACHED = [{ id: 4999, topicId: 1, topicTitle: 'Governance', topicSlug: 'gov', postNumber: 2, url: 'https://forum.namada.net/t/gov/1/2', username: 'u', displayName: null, avatarUrl: null, createdAt: '2026-10-01T00:00:00Z', excerpt: 'cached', isNewTopic: false }];

function network() {
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
    const url = String(u);
    if (url.endsWith('/posts.json')) return tooLarge();
    if (url.endsWith('/latest.json')) return json(TOPICS);
    return new Response('down', { status: 503 });
  }));
}
/** `db` with the first read of intel.cache failing (D1_ERROR), every other call as is. */
function flakyCacheRead(db: TestD1) {
  let missed = false;
  return {
    ...db,
    prepare(sql: string) {
      const s: any = db.prepare(sql);
      if (sql !== 'SELECT value FROM kv WHERE key=?') return s;
      return { bind: (...p: unknown[]) => {
        const b: any = s.bind(...p);
        if (!missed && p[0] === 'intel.cache') { missed = true; return { first: () => Promise.reject(new Error('D1_ERROR: Network connection lost.')) }; }
        return b;
      } };
    },
    batch: (stmts: any[]) => db.batch(stmts),
  };
}
async function tick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false;
  runCron(env).catch(() => {}).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  expect(done).toBe(true);
}
const kvValue = (db: TestD1, key: string) => (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any)?.value;

describe('a failed posts read on a tick whose intel.cache read failed too', () => {
  it('keeps the cached posts (or writes nothing), never an empty list under a note saying the cache was kept', async () => {
    const db = testD1();
    insert(db, 'kv', [
      { key: 'intel.cache', value: JSON.stringify({ topics: [], latestPosts: CACHED, proposals: [], validators: [], indexerEpoch: null, fetchedAt: PLAIN - 60000 }), updated_at: PLAIN - 60000 },
      { key: 'forum.last_post_id', value: '4999', updated_at: PLAIN - 60000 },
    ]);
    network();
    await tick({ DB: flakyCacheRead(db), KEPLR_KEY: 'k' }, PLAIN);
    const row = JSON.parse(kvValue(db, 'source.health'))[FORUM_POSTS_HEALTH];
    const after = JSON.parse(kvValue(db, 'intel.cache'));
    console.log('row:', row.note, '| cached posts after the tick:', after.latestPosts.length);
    // the next tick (posts still refused, D1 fine) reads what this tick wrote
    await tick({ DB: db, KEPLR_KEY: 'k' }, PLAIN + 60000);
    const later = JSON.parse(kvValue(db, 'intel.cache'));
    console.log('cached posts after the next tick:', later.latestPosts.length);
    expect(after.latestPosts).toEqual(CACHED);
    expect(later.latestPosts).toEqual(CACHED);
  });
});
