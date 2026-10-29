import { NAM, UA } from './config';
import { bech32, bech32m } from '@scure/base';

export interface Env {
  DB: D1Database;
  LIVE: DurableObjectNamespace;
  ASSETS: Fetcher;
  KEPLR_KEY: string;
  DISCORD_WEBHOOK_URL?: string;
  /** 'yes' in production only (a secret): any other run posts no alert (sources/discord.ts sendsAlerts) */
  SEND_ALERTS?: string;
  ACCESS_AUD?: string;
  /** 32 bytes base64; encrypts per-user settings at rest */
  SETTINGS_KEY?: string;
  /** The Telegram bot's token (@BotFather), a secret: without it nothing is sent to Telegram (sources/telegram.ts) */
  TELEGRAM_BOT_TOKEN?: string;
  /** The secret Telegram sends with each update to the webhook (setWebhook secret_token; telegram-bot.ts) */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** The public channel of the site's own alerts ("@name" or its id), the bot an admin there; unset: none */
  TELEGRAM_CHANNEL?: string;
  WHALE_OSMOSIS_NAM?: string;
  WHALE_NAMADA_NAM?: string;
  /** Workers rate limiting (wrangler.jsonc `ratelimits`) for the requests that read many rows or write for anyone (worker/src/http.ts) */
  HEAVY_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** The same for rewound reads and metric histories, which miss the edge cache by design (worker/src/http.ts) */
  REPLAY_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** The search and the lists searched by text, 120 a minute (worker/src/http.ts limiterFor; wrangler.jsonc SEARCH_LIMITER) */
  SEARCH_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** /ws upgrade attempts, 60 a minute per client address (worker/src/index.ts, http.ts wsLimited; wrangler.jsonc WS_LIMITER) */
  WS_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** The Osmosis quote service calls all visitors' quotes may make, 10 per 10 s per location (worker/src/api.ts quoteBudget) */
  QUOTE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

export class HttpError extends Error {
  /** The URL with any key redacted: the whole error may be logged or serialised, not only its message. */
  readonly url: string;
  constructor(public status: number, url: string, body: string) {
    super(`HTTP ${status} for ${redact(url)}: ${body.slice(0, 200)}`);
    this.url = redact(url);
  }
}

/** Never leak the Keplr key into logs or API responses. */
export function redact(s: string): string {
  return s.replace(/keplr_[A-Za-z0-9_-]+/g, 'keplr_***');
}

/**
 * The most a fetchJson answer may be unless its caller allows more (`maxBytes`): about ten times the largest answer a
 * read with this default gets (the forum's posts.json, 215 KB on 2026-10-22; the indexer's validator list, 108 KB; a
 * Namada /status, 1 KB), and small enough that six at once (the connections a Worker opens at a time) stay well
 * inside the 128 MB isolate. The block and transaction-search reads, which can be megabytes, pass
 * FETCH_TEXT_MAX_BYTES.
 */
export const FETCH_JSON_MAX_BYTES = 2 * 1024 * 1024;
/** An error answer is kept for its first 200 characters (HttpError), so no more than this much of it is read. */
const ERROR_BODY_MAX_BYTES = 4096;

/** An answer past its read's byte cap: refused before it is all read, and not asked for again (the same URL would send it again). */
export class ResponseTooLargeError extends Error {}

/**
 * Bytes several reads share (fetchJson's `budget`): each answer is read only while it fits in what is `left`, and
 * what it took is subtracted once it is read whole. A caller that lets an answer go may give its bytes back.
 */
export interface ReadBudget { left: number }
/** An answer past what is left of the budget its reads share: refused as one past the cap is, and not retried. */
export class ReadBudgetError extends Error {}

/**
 * The whole body, counted as it arrives: an answer announced or streamed past `maxBytes` is cancelled there and
 * refused, so one producer's answer can never fill the isolate (the runtime would end it before any catch or
 * finally ran, and the next node would never be asked). With a `budget`, the answer must also fit in what is left of
 * it, and its bytes are taken from it.
 */
async function cappedBytes(res: Response, maxBytes: number, url: string, budget?: ReadBudget): Promise<Uint8Array> {
  const limit = budget ? Math.max(0, Math.min(maxBytes, budget.left)) : maxBytes;
  const spent = (what: string) => new ReadBudgetError(`response ${what}: past the ${mbOf(limit)} left of its reads' budget, for ${redact(url)}`);
  const cl = Number(res.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > limit) {
    await res.body?.cancel().catch(() => {});
    throw cl > maxBytes
      ? new ResponseTooLargeError(`response too large (${mbOf(cl)} announced, ${mbOf(maxBytes)} allowed) for ${redact(url)}`)
      : spent(`of ${mbOf(cl)} announced`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      await reader.cancel().catch(() => {});
      throw limit < maxBytes ? spent(`over ${mbOf(limit)}`) : new ResponseTooLargeError(`response too large (over ${mbOf(maxBytes)}) for ${redact(url)}`);
    }
    parts.push(value);
  }
  if (budget) budget.left -= bytes;
  if (parts.length === 1) return parts[0];
  const all = new Uint8Array(bytes);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  parts.length = 0;
  return all;
}

/** The first ERROR_BODY_MAX_BYTES of an error answer as text; the rest is cancelled, never read. */
async function errorBody(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < ERROR_BODY_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      bytes += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(bytes, ERROR_BODY_MAX_BYTES));
  let o = 0;
  for (const p of parts) {
    if (o >= all.length) break;
    const part = p.subarray(0, all.length - o);
    all.set(part, o);
    o += part.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * GET `url` as JSON. `maxBytes`: the most the answer may be (cappedBytes). `budget`: bytes this read shares with
 * others (one catch-up search's pages, live-hub.ts sweepOsmosis): the answer must also fit in what is left of it.
 */
export async function fetchJson<T = any>(
  url: string,
  opts: { timeoutMs?: number; retries?: number; init?: RequestInit; signal?: AbortSignal; maxBytes?: number; budget?: ReadBudget } = {},
): Promise<T> {
  const { timeoutMs = 15000, retries = 2, init, signal, maxBytes = FETCH_JSON_MAX_BYTES, budget } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // A caller's deadline (`signal`) ends the request and every retry, as the per-attempt timeout ends one attempt.
    if (signal?.aborted) throw new Error(`deadline passed before ${redact(url)}`);
    if (budget && budget.left <= 0) throw new ReadBudgetError(`no bytes left of its reads' budget for ${redact(url)}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
    const onAbort = () => ctrl.abort('deadline');
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers || {}) },
      });
      if (!res.ok) {
        const body = await errorBody(res);
        // 4xx (except 429) are not retryable
        if (res.status < 500 && res.status !== 429) throw new HttpError(res.status, url, body);
        lastErr = new HttpError(res.status, url, body);
      } else {
        // Counted as it arrives (cappedBytes), then decoded and parsed as res.json() would.
        return JSON.parse(new TextDecoder().decode(await cappedBytes(res, maxBytes, url, budget))) as T;
      }
    } catch (e) {
      if (e instanceof ResponseTooLargeError || e instanceof ReadBudgetError) throw e;
      lastErr = e;
      if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) break;
    if (attempt < retries) await sleep(300 * 2 ** attempt);
  }
  throw lastErr instanceof Error ? new Error(redact(lastErr.message)) : new Error(`fetch failed: ${redact(url)}`);
}

/** A body read that ended early: how much arrived, of how much (the Content-Length, when sent), in how long. */
export class ReadCutError extends Error {
  readonly bytes: number;
  readonly total: number | null;
  readonly ms: number;
  readonly firstByteMs: number | null;
  constructor(message: string, bytes: number, total: number | null, ms: number, firstByteMs: number | null) {
    super(message);
    this.bytes = bytes; this.total = total; this.ms = ms; this.firstByteMs = firstByteMs;
  }
}

const mbOf = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const secOf = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/**
 * The most a streamed answer may be: 16 MB, over the 12 MB balance listing. The cap is what protects the isolate:
 * a 32 MB answer measured about 130 MB of V8 heap (the chunks, the joined bytes, the decoded string, the parsed
 * JSON), past the Worker's 128 MB.
 */
export const FETCH_TEXT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * GET `url` and read the whole body, counting what arrives: for the multi-megabyte chain listings, whose answer a
 * public node can stream slowly. One attempt; `timeoutMs` covers the whole read, and the caller's `signal` ends it
 * too. A read cut short (the timeout, the deadline, the connection, an answer past `maxBytes`) throws a
 * ReadCutError whose message says what happened ("timeout: 4.2 MB of 12.0 MB arrived in 180 s (first byte after
 * 5.8 s)"), so the Sources sheet can say it; a 4xx/5xx answer throws an HttpError as fetchJson does. The chunks
 * are let go as soon as they are joined, so the isolate holds one copy of the answer, not two.
 */
export async function fetchText(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; init?: RequestInit; signal?: AbortSignal } = {},
): Promise<{ text: string; bytes: number; total: number | null; ms: number; firstByteMs: number }> {
  const { timeoutMs = 15000, maxBytes = FETCH_TEXT_MAX_BYTES, init, signal } = opts;
  if (signal?.aborted) throw new Error(`deadline passed before ${redact(url)}`);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs);
  const onAbort = () => ctrl.abort('deadline');
  signal?.addEventListener('abort', onAbort);
  let bytes = 0, total: number | null = null, firstByteMs: number | null = null;
  const parts: Uint8Array[] = [];
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers || {}) } });
    if (!res.ok) throw new HttpError(res.status, url, await errorBody(res));
    const cl = Number(res.headers.get('content-length'));
    total = Number.isFinite(cl) && cl > 0 ? cl : null;
    firstByteMs = Date.now() - t0;
    if (total != null && total > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`response too large (${mbOf(total)} announced, ${mbOf(maxBytes)} allowed)`);
    }
    if (!res.body) {
      const text = await res.text();
      if (text.length > maxBytes) throw new Error(`response too large (${mbOf(text.length)}, ${mbOf(maxBytes)} allowed)`);
      return { text, bytes: text.length, total, ms: Date.now() - t0, firstByteMs };
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`response too large (over ${mbOf(maxBytes)})`);
      }
      parts.push(value);
    }
    const all = new Uint8Array(bytes);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    parts.length = 0;
    return { text: new TextDecoder().decode(all), bytes, total, ms: Date.now() - t0, firstByteMs };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const ms = Date.now() - t0;
    const why = ctrl.signal.aborted ? String(ctrl.signal.reason) : redact(String(e instanceof Error ? e.message : e)).slice(0, 80);
    throw new ReadCutError(`${why}: ${mbOf(bytes)}${total ? ` of ${mbOf(total)}` : ''} arrived in ${secOf(ms)}${firstByteMs != null ? ` (first byte after ${secOf(firstByteMs)})` : ''}`, bytes, total, ms, firstByteMs);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Try each base URL in order, return the first success along with the provider used. */
export async function withFailover<T>(
  bases: readonly { provider: string; url: string }[],
  fn: (base: string) => Promise<T>,
): Promise<{ value: T; provider: string }> {
  let lastErr: unknown;
  for (const b of bases) {
    try {
      return { value: await fn(b.url), provider: b.provider };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('all providers failed');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SCALE = 10 ** NAM.decimals;

/** Base units (string/bigint) -> NAM float */
export function toNam(base: string | bigint | number): number {
  if (typeof base === 'number') return base / SCALE;
  const b = typeof base === 'bigint' ? base : BigInt(base || '0');
  const whole = b / BigInt(SCALE);
  const frac = b % BigInt(SCALE);
  return Number(whole) + Number(frac) / SCALE;
}

/** Parse Cosmos coin strings like "123ibc/ABC,45uosmo" */
export function parseCoins(s: string | undefined | null): { amount: string; denom: string }[] {
  if (!s) return [];
  const out: { amount: string; denom: string }[] = [];
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d+)(.+)$/);
    if (m) out.push({ amount: m[1], denom: m[2] });
  }
  return out;
}

export function namFromCoins(s: string | undefined | null): number {
  return parseCoins(s)
    .filter((c) => c.denom === NAM.osmoDenom)
    .reduce((a, c) => a + toNam(c.amount), 0);
}

/** Decode a little-endian U256 (Namada Amount, borsh) from base64 */
export function decodeU256LE(b64: string | null | undefined): bigint {
  if (!b64) return 0n;
  const bin = atob(b64);
  let v = 0n;
  for (let i = bin.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bin.charCodeAt(i));
  return v;
}

export function decodeU64LE(b64: string | null | undefined): number {
  if (!b64) return 0;
  const bin = atob(b64);
  let v = 0n;
  for (let i = Math.min(8, bin.length) - 1; i >= 0; i--) v = (v << 8n) | BigInt(bin.charCodeAt(i));
  return Number(v);
}

export function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** The shape of an address (bech32 charset, bounded length: 43 and 45 characters for accounts, up to 63 for contracts). */
export function chainOf(address: string): 'osmosis' | 'namada' | null {
  if (/^osmo1[02-9ac-hj-np-z]{38,80}$/.test(address)) return 'osmosis';
  if (/^tnam1[02-9ac-hj-np-z]{40,80}$/.test(address)) return 'namada';
  return null;
}

/**
 * chainOf, and the checksum too: a string an outsider typed (an IBC packet's receiver is free text the sender chose)
 * that only looks like an address is not one, and must never link two accounts.
 */
export function isRealAddress(address: string | null | undefined): 'osmosis' | 'namada' | null {
  if (!address) return null;
  const chain = chainOf(address);
  if (!chain) return null;
  try {
    if (chain === 'namada') bech32m.decode(address as `${string}1${string}`, 100);
    else bech32.decode(address as `${string}1${string}`, 90);
    return chain;
  } catch {
    return null;
  }
}

/**
 * The most of a flow's address a row keeps, in UTF-16 units. An IBC packet's receiver and sender are text the sending
 * chain's user chose: ibc-go takes a receiver of 2,048 bytes, and Namada bounds neither below its transaction size.
 * The longest address stored on 2026-10-22 was 63 characters (a 32-byte Osmosis account), and chainOf takes at most
 * 85, so text cut here names no account.
 */
export const FLOW_ADDRESS_MAX = 128;
/**
 * The most of an IBC memo a row keeps, in UTF-16 units (ibc-go takes 32 KiB). JSON writes a control character as six,
 * so a stored memo is at most 1,536 bytes. Namadillo's shielding memos (about 2,400 characters of a MASP transaction)
 * are cut too: no page or check of this site reads a memo, and the transaction itself is on the chain.
 */
export const FLOW_MEMO_MAX = 256;

/** `s` cut to `max` UTF-16 units, the last of them '…', never inside a surrogate pair; shorter text as it is. */
export function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${s.slice(0, end)}…`;
}

/**
 * A flow with its senders' text bounded, as the parsers give every flow: `from` and `to` cut to FLOW_ADDRESS_MAX and
 * meta.memo to FLOW_MEMO_MAX, and meta.textCut naming the whole length of each one cut, so a cut row says it was cut.
 * Kept whole, one dust IBC send with a 32 KiB memo of control characters is about 197 KB stored, and the moves export,
 * a moves page and the cron's bridge read load every such row whole. The same text is cut the same way on both chains,
 * so the two records of a crossing still pair; a flow with nothing to cut is returned as it is.
 */
export function boundFlowText<F extends { from: string | null; to: string | null; meta?: Record<string, unknown> | null }>(f: F): F {
  const cut: Record<string, number> = {};
  const bound = (v: string | null, k: string, max: number) => {
    if (typeof v !== 'string' || v.length <= max) return v;
    cut[k] = v.length;
    return cutText(v, max);
  };
  const memo = f.meta?.memo;
  const memoCut = typeof memo === 'string' ? bound(memo, 'memo', FLOW_MEMO_MAX) : memo;
  const from = bound(f.from, 'from', FLOW_ADDRESS_MAX);
  const to = bound(f.to, 'to', FLOW_ADDRESS_MAX);
  if (!Object.keys(cut).length) return f;
  return { ...f, from, to, meta: { ...(f.meta ?? {}), ...(typeof memo === 'string' ? { memo: memoCut } : {}), textCut: cut } };
}

/**
 * An address an Osmosis pool can have: a checksummed osmo1 address of 32 bytes. Balancer, stableswap and concentrated
 * pools hold their coins in an account derived from the pool id, and a CosmWasm pool in its contract, all 32 bytes;
 * a wallet's key address is 20 bytes, as are the module accounts, and a Namada address is never osmo1. The pool list
 * is a third party's answer, and an address it names leaves every holder list as a pool (holders.ts notPool, LISTED),
 * so a name of any other shape is not taken as a pool.
 */
export function isPoolAccount(address: unknown): boolean {
  if (typeof address !== 'string' || isRealAddress(address) !== 'osmosis') return false;
  try {
    return bech32.fromWords(bech32.decode(address as `${string}1${string}`, 90).words).length === 32;
  } catch {
    return false;
  }
}

export const now = () => Date.now();
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
