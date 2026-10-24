// Daily digest (2026-10-23): the stand-in network and cron tick the digest's delivery tests share. Discord answers
// every post (204 unless a test answers otherwise), and each post is kept as it was sent: its link, its JSON (the
// form's payload_json for a post with files) and its files; every other host answers 503, so a cron tick reads
// nothing from outside. fetch is stubbed before anything runs that could post: nothing reaches Discord.
import { expect, vi } from 'vitest';
import { runCron } from '../worker/src/cron';
import type { TestD1 } from './d1-sqlite';

export interface SentFile { field: string; name: string; type: string; size: number }
export interface SentPost { url: string; json: any; files: SentFile[]; form: boolean; at: number }

export const sent: SentPost[] = [];

/** Stubs fetch: Discord's answer is `answer`'s (204 by default), every other host's 503. */
export function stubDiscord(answer?: (p: SentPost, i: number) => Response | Promise<Response>) {
  sent.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
    const url = String(u);
    if (!url.startsWith('https://discord.com/')) return new Response('down', { status: 503 });
    const body = init?.body;
    let p: SentPost;
    if (body instanceof FormData) {
      const files: SentFile[] = [];
      for (const [field, v] of body.entries()) if (field !== 'payload_json') files.push({ field, name: (v as File).name, type: (v as File).type, size: (v as File).size });
      p = { url, json: JSON.parse(String(body.get('payload_json'))), files, form: true, at: Date.now() };
    } else p = { url, json: JSON.parse(String(body)), files: [], form: false, at: Date.now() };
    sent.push(p);
    return answer ? answer(p, sent.length - 1) : new Response(null, { status: 204 });
  }));
}

/** One cron tick under fake timers from `start`, as the scheduled entry runs it. */
export async function tick(env: any, start: number) {
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false;
  runCron(env).catch(() => {}).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  expect(done).toBe(true);
}

export const kvJson = (db: TestD1, key: string): any => {
  const v = (db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any)?.value;
  return v ? JSON.parse(v) : null;
};
export const kvKeys = (db: TestD1, like: string): string[] => (db.raw.prepare('SELECT key FROM kv WHERE key LIKE ? ORDER BY key').all(like) as any[]).map((r) => r.key);
/** Every word a post's embeds carry. */
export const textOf = (p: SentPost): string => JSON.stringify(p.json.embeds);
export const titlesOf = (p: SentPost): string[] => (p.json.embeds as any[]).map((e) => e.title ?? '');
