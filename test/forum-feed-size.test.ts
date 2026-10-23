// Security review (2026-10-22), forum feed size: the forum's two reads took fetchJson's 2 MiB default cap, and a
// refused read turned into an empty list with no health row. The forum allows 32,000 characters a post and no limit on
// emoji (forum.namada.net site settings, 2026-10-22), so any forum account could post twice and push posts.json past
// the cap: the cron then cached no posts, the feed went empty and the forum alerts stopped, silently, until 48 newer
// posts pushed the two out. Now both reads take the streamed-answer cap (util.ts FETCH_TEXT_MAX_BYTES), a posts read
// that still fails keeps the cached posts and sends no forum alert from them, and the Sources sheet has a row for it.
// fetchForumData directly, and the real runCron over the sqlite D1 stand-in with a stubbed network.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchForumData } from '../worker/src/sources/intel';
import { FETCH_JSON_MAX_BYTES, FETCH_TEXT_MAX_BYTES } from '../worker/src/util';
import { runCron, FORUM_POSTS_HEALTH } from '../worker/src/cron';
import { testD1, insert, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const emoji = '<img src="https://emoji.discourse-cdn.com/twitter/+1.png?v=15" title=":+1:" class="emoji" alt=":+1:" loading="lazy" width="20" height="20">';
const post = (id: number, big: boolean) => ({
  id, username: `u${id}`, name: null, avatar_template: '/user_avatar/forum.namada.net/u/{size}/1_2.png', created_at: new Date(Date.UTC(2026, 9, 1) + id * 60_000).toISOString(),
  cooked: big ? `<p>${emoji.repeat(8000)}</p>` : '<p>a normal reply about the proposal</p>', post_number: 2, topic_id: 100 + id, topic_slug: 'gov', topic_title: 'Governance',
  raw: big ? ':+1:'.repeat(8000) : 'a normal reply about the proposal',
});
const TOPICS = { topic_list: { topics: [{ id: 100, title: 'Governance', slug: 'gov', category_id: 4, created_at: '2026-10-01T00:00:00Z', last_posted_at: '2026-10-01T00:00:00Z' }] } };
/** posts.json past the cap, announced by its length (the read is refused before the body is read). */
const tooLarge = () => new Response('{"latest_posts":[]}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(FETCH_TEXT_MAX_BYTES + 1) } });

function forum(posts: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
    const url = String(u);
    if (url.endsWith('/posts.json')) return posts();
    if (url.endsWith('/latest.json')) return json(TOPICS);
    throw new Error('offline');
  }));
}

describe('the forum reads', () => {
  it('two posts of 8,000 emoji among the latest 50 (about 2.5 MB) no longer empty the feed', async () => {
    const body = JSON.stringify({ latest_posts: Array.from({ length: 50 }, (_, i) => post(5000 - i, i === 10 || i === 20)) });
    expect(body.length).toBeGreaterThan(FETCH_JSON_MAX_BYTES);
    forum(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
    const { topics, latestPosts, postsError } = await fetchForumData();
    expect(topics).toHaveLength(1);
    expect(latestPosts).toHaveLength(25);
    expect(postsError).toBeNull();
  });

  it('an answer past the streamed-answer cap is still refused, and says so', async () => {
    forum(tooLarge);
    const { topics, latestPosts, postsError } = await fetchForumData();
    expect(topics).toHaveLength(1);
    expect(latestPosts).toEqual([]);
    expect(postsError).toMatch(/^response too large \(16\.8 MB announced, 16\.8 MB allowed\) for https:\/\/forum\.namada\.net\/posts\.json$/);
  });

  it('an answer without a list of posts is a failed read too', async () => {
    forum(() => json({ errors: ['rate limited'] }));
    expect((await fetchForumData()).postsError).toBe('the answer has no latest_posts list');
  });
});

// ---------------------------------------------------------------- the cron tick

const PLAIN = Date.parse('2026-10-17T22:41:05Z');
const CACHED = [{ id: 4999, topicId: 1, topicTitle: 'Governance', topicSlug: 'gov', postNumber: 2, url: 'https://forum.namada.net/t/gov/1/2', username: 'u', displayName: null, avatarUrl: null, createdAt: '2026-10-01T00:00:00Z', excerpt: 'cached', isNewTopic: false }];
/** Every other producer is down: the forum answers its topics, and its posts as `posts` gives. */
function network(posts: () => Response) {
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL) => {
    const url = String(u);
    if (url.endsWith('/posts.json')) return posts();
    if (url.endsWith('/latest.json')) return json(TOPICS);
    return new Response('down', { status: 503 });
  }));
}
async function tick(db: TestD1, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false; let err: unknown = null;
  runCron({ DB: db, KEPLR_KEY: 'k' } as any).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}
function seeded() {
  const db = testD1();
  insert(db, 'kv', [
    { key: 'intel.cache', value: JSON.stringify({ topics: [], latestPosts: CACHED, proposals: [], validators: [], indexerEpoch: null, fetchedAt: PLAIN - 60000 }), updated_at: PLAIN - 60000 },
    { key: 'forum.last_post_id', value: '4999', updated_at: PLAIN - 60000 },
  ]);
  return db;
}
const kvValue = (db: TestD1, key: string) => db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value;
const healthOf = (db: TestD1) => JSON.parse(kvValue(db, 'source.health'));

describe('the cron tick', () => {
  it('a posts read refused for its size keeps the cached posts, alerts nothing, and the Sources sheet says why', async () => {
    const db = seeded();
    network(tooLarge);
    await tick(db, PLAIN);
    const cache = JSON.parse(kvValue(db, 'intel.cache'));
    expect(cache.topics).toHaveLength(1);
    expect(cache.latestPosts).toEqual(CACHED);
    expect(kvValue(db, 'forum.last_post_id')).toBe('4999');
    const row = healthOf(db)[FORUM_POSTS_HEALTH];
    expect(row).toMatchObject({ name: 'Namada forum (latest posts)', ok: false });
    expect(row.note).toMatch(/^The forum's latest posts could not be read, so the ones cached are kept: response too large/);
  });

  it('a good read replaces the cached posts and the row says so', async () => {
    const db = seeded();
    network(() => json({ latest_posts: [post(5001, false), post(5000, false)] }));
    await tick(db, PLAIN);
    const cache = JSON.parse(kvValue(db, 'intel.cache'));
    expect(cache.latestPosts.map((p: { id: number }) => p.id)).toEqual([5001, 5000]);
    expect(kvValue(db, 'forum.last_post_id')).toBe('5001');
    expect(healthOf(db)[FORUM_POSTS_HEALTH]).toMatchObject({ ok: true, note: '2 latest posts read' });
  });
});
