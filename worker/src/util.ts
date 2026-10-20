import { NAM, UA } from './config';
import { bech32, bech32m } from '@scure/base';

export interface Env {
  DB: D1Database;
  LIVE: DurableObjectNamespace;
  ASSETS: Fetcher;
  KEPLR_KEY: string;
  DISCORD_WEBHOOK_URL?: string;
  ACCESS_AUD?: string;
  /** 32 bytes base64; encrypts per-user settings at rest */
  SETTINGS_KEY?: string;
  WHALE_OSMOSIS_NAM?: string;
  WHALE_NAMADA_NAM?: string;
  /** Workers rate limiting (wrangler.jsonc `ratelimits`) for the requests that read many rows or write for anyone (worker/src/http.ts) */
  HEAVY_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  /** The same for rewound reads and metric histories, which miss the edge cache by design (worker/src/http.ts) */
  REPLAY_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
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

export async function fetchJson<T = any>(
  url: string,
  opts: { timeoutMs?: number; retries?: number; init?: RequestInit; signal?: AbortSignal } = {},
): Promise<T> {
  const { timeoutMs = 15000, retries = 2, init, signal } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // A caller's deadline (`signal`) ends the request and every retry, as the per-attempt timeout ends one attempt.
    if (signal?.aborted) throw new Error(`deadline passed before ${redact(url)}`);
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
        const body = await res.text();
        // 4xx (except 429) are not retryable
        if (res.status < 500 && res.status !== 429) throw new HttpError(res.status, url, body);
        lastErr = new HttpError(res.status, url, body);
      } else {
        return (await res.json()) as T;
      }
    } catch (e) {
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

export const now = () => Date.now();
export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
