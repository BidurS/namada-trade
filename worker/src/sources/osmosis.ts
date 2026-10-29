import { OSMOSIS, NAM, keplrHeaders } from '../config';
import { fetchJson, toNam, isRealAddress, FETCH_TEXT_MAX_BYTES } from '../util';

export interface HolderItem {
  address: string;
  balance: string;
  balanceNum: number;
}

export async function fetchOsmosisHolders(keplrKey: string): Promise<HolderItem[]> {
  return (await fetchOsmosisHolderList(keplrKey)).holders;
}

/**
 * Pages of 100 holders read at most in one call (10,000 holders, about 1.5 MB held at once; 1,339 holders in 14 pages
 * on 2026-10-23). The cron reads the list a slice at a time from the bank's next key (cron.ts OsmoHolderPass), so
 * this bounds one tick's read, not the list.
 */
export const OSMOSIS_HOLDER_PAGES = 100;
/** The longest next key kept (base64 of the bank's key, a length byte and a 20 or 32 byte address: 28 or 44 characters). */
export const OSMOSIS_NEXT_KEY_MAX = 200;
/** Owners asked for in one page (pagination.limit); the bank never names more. */
export const OSMOSIS_HOLDER_PAGE_SIZE = 100;
/** An owner's amount as the bank writes it: a whole number of base units (at most 13 digits on 2026-10-22). */
const OWNER_AMOUNT = /^\d{1,40}$/;

/**
 * One page's owners as holders. A page that is not the bank's answer throws: more owners than the page asked for, or
 * an owner that is not a checksummed osmo1 address (at most 85 characters, util.ts chainOf) with a whole-number
 * amount. Each page is under fetchJson's cap, but the list keeps every page's owners until the last page is read, so
 * these bounds are what hold it to at most 10,000 short owners (about 1.5 MB) whatever the pages carry. The error
 * says which rule the page broke, never what it named (the cron's health row is public).
 */
function pageOwners(owners: unknown, page: number): HolderItem[] {
  const refuse = (why: string) => new Error(`page ${page + 1} of the Osmosis holder list is not the bank's answer: ${why}`);
  if (owners == null) return [];
  if (!Array.isArray(owners)) throw refuse('its owners are not a list');
  if (owners.length > OSMOSIS_HOLDER_PAGE_SIZE) throw refuse(`${owners.length} owners, of ${OSMOSIS_HOLDER_PAGE_SIZE} asked for`);
  const out: HolderItem[] = [];
  for (const o of owners) {
    const address: unknown = o?.address, amount: unknown = o?.balance?.amount;
    if (typeof address !== 'string' || isRealAddress(address) !== 'osmosis') throw refuse('an owner that is not an Osmosis address');
    if (typeof amount !== 'string' || !OWNER_AMOUNT.test(amount)) throw refuse('an owner whose amount is not a whole number of at most 40 digits');
    out.push({ address, balance: amount, balanceNum: toNam(amount) });
  }
  return out;
}

/**
 * Options for a Keplr REST read. The cron passes its tick deadline (`signal`) and a short timeout with one retry,
 * so a Keplr that accepts requests and never answers costs seconds, not the tick; scripts keep the long defaults.
 */
export interface KeplrOpts { signal?: AbortSignal; timeoutMs?: number; retries?: number }
/**
 * Where a read of the holder list starts and how it may end. `from`: a next key the bank gave (the first page when
 * absent). `resume`: a read that `signal` ends after at least one page returns the pages read and the key to go on
 * from (`nextKey`) instead of failing. `pagesBefore`: pages of the same pass read before, for the error's page number.
 */
export interface HolderListOpts extends KeplrOpts { from?: string | null; resume?: boolean; pagesBefore?: number }
/** One read of the holder list: `nextKey` is the bank's key for the page after the last one read (absent when complete or stopped). */
export interface HolderListRead { holders: HolderItem[]; complete: boolean; capped: boolean; pages: number; nextKey?: string }

/**
 * Every NAM holder on Osmosis, or one slice of them. `complete` is true only when a page carried a pagination object
 * whose next_key is empty: the bank saying there are no more pages, which is what allows an address missing from the
 * list to be read as holding nothing (the cron also checks the list adds up to the supply). A 200 answer without
 * pagination, or hitting the page cap, leaves `complete` false (`capped` says which). A page whose owners are not the
 * bank's (pageOwners), or whose next key is not one (not a string, too long, or the key the page was asked with),
 * fails the whole read: a producer that names one made-up owner is not taken at its word for the pages before it
 * either, and the error is the cron's health note (had the list only stopped there, a refused first page would leave
 * that row ok with nothing read). With `resume`, the page cap and a deadline after the first page end the read with
 * `nextKey`, the key the next read starts from.
 */
export async function fetchOsmosisHolderList(keplrKey: string, pages = OSMOSIS_HOLDER_PAGES, opts: HolderListOpts = {}): Promise<HolderListRead> {
  const rest = OSMOSIS.keplrRest;
  const headers = keplrHeaders(keplrKey);
  const denom = encodeURIComponent(NAM.osmoDenom);
  let nextKey: string | null = opts.from ?? null;
  let complete = false;
  let capped = true;
  let read = 0;
  const holders: HolderItem[] = [];
  const before = opts.pagesBefore ?? 0;
  // The pages read so far and the key of the one not read: what a later read goes on from.
  const paused = (): HolderListRead => ({ holders: sorted(holders), complete: false, capped: false, pages: read, nextKey: nextKey ?? undefined });

  for (let page = 0; page < pages; page++) {
    // A list cut by the deadline is not a list: the caller gets an error, or with `resume` the pages read and where to
    // go on, never part of it as if it were all.
    if (opts.signal?.aborted) {
      if (opts.resume && read > 0) return paused();
      throw new Error(`deadline passed after ${before + page} pages of the Osmosis holder list`);
    }
    const pageUrl: string = `${rest}/cosmos/bank/v1beta1/denom_owners_by_query?denom=${denom}&pagination.limit=${OSMOSIS_HOLDER_PAGE_SIZE}${
      nextKey ? `&pagination.key=${encodeURIComponent(nextKey)}` : ''
    }`;
    let pageRes: any;
    try {
      pageRes = await fetchJson(pageUrl, { timeoutMs: opts.timeoutMs ?? 25000, retries: opts.retries ?? 2, signal: opts.signal, init: { headers } });
    } catch (e) {
      if (opts.resume && read > 0 && opts.signal?.aborted) return paused();
      throw e;
    }
    const owners = pageOwners(pageRes.denom_owners, before + page);
    const pg = pageRes?.pagination;
    const key: unknown = pg && typeof pg === 'object' ? pg.next_key || null : null;
    if (key != null && (typeof key !== 'string' || key.length > OSMOSIS_NEXT_KEY_MAX || key === nextKey)) {
      throw new Error(`page ${before + page + 1} of the Osmosis holder list is not the bank's answer: its next key is not one`);
    }
    holders.push(...owners);
    read++;
    if (!pg || typeof pg !== 'object') { capped = false; nextKey = null; break; } // not the bank's answer: stop, not complete
    nextKey = key as string | null;
    if (!nextKey) { complete = true; capped = false; break; }
    if (owners.length === 0) { capped = false; nextKey = null; break; } // a next key with an empty page: stop, not complete
  }

  return { holders: sorted(holders), complete, capped: complete ? false : capped, pages: read, ...(capped && !complete && nextKey ? { nextKey } : {}) };
}

/** Largest balance first. */
function sorted(holders: HolderItem[]): HolderItem[] {
  return holders.sort((a, b) => b.balanceNum - a.balanceNum);
}

/** The bank's supply of NAM on Osmosis, in base units (exact, for the holder-list check). */
export async function fetchOsmosisSupplyBase(keplrKey: string, opts: KeplrOpts = {}): Promise<bigint> {
  const denom = encodeURIComponent(NAM.osmoDenom);
  const res = await fetchJson(`${OSMOSIS.keplrRest}/cosmos/bank/v1beta1/supply/by_denom?denom=${denom}`, {
    timeoutMs: opts.timeoutMs ?? 15000,
    retries: opts.retries ?? 2,
    signal: opts.signal,
    init: { headers: keplrHeaders(keplrKey) },
  });
  const amt = res?.amount?.amount;
  if (typeof amt !== 'string' || !/^\d+$/.test(amt)) throw new Error('supply answer without an amount');
  return BigInt(amt);
}

/** verified_src of an Osmosis row read from Keplr's REST (the holder list, and a balance by address). */
export const KEPLR_REST_SRC = 'keplr_rest';
/** verified_src of an Osmosis row whose balance by address Osmosis's public REST gave, after Keplr's read failed. */
export const OSMOSIS_PUBLIC_REST_SRC = 'osmosis_public_rest';
/** One balance read by address: the base units and the source that gave them. */
export interface OsmosisBalanceRead { base: bigint; src: typeof KEPLR_REST_SRC | typeof OSMOSIS_PUBLIC_REST_SRC }

/**
 * One address's NAM on Osmosis as the bank holds it now, in base units (bank balances by_denom). The cron asks it
 * for the few holders a pass's list stopped naming before it zeroes one, and for the largest holders read in a pass's
 * earlier slices. Keplr's REST is asked first; when that read fails (no answer, a refusal of the route, or an answer
 * that is not the bank's), Osmosis's public REST is asked the same thing, so a Keplr that does not serve the route
 * does not stop every holder from being zeroed. A deadline (`signal`) ends both. An answer that does not name the
 * denom asked for, or whose amount is not a whole number of at most 40 digits, is not the bank's answer; when neither
 * gives one, this throws.
 */
export async function fetchOsmosisBalanceBase(keplrKey: string, address: string, opts: KeplrOpts = {}): Promise<OsmosisBalanceRead> {
  const path = `/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}/by_denom?denom=${encodeURIComponent(NAM.osmoDenom)}`;
  try {
    return { base: await balanceAnswer(`${OSMOSIS.keplrRest}${path}`, opts, keplrHeaders(keplrKey)), src: KEPLR_REST_SRC };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
  }
  try {
    return { base: await balanceAnswer(`${OSMOSIS.publicRest}${path}`, opts), src: OSMOSIS_PUBLIC_REST_SRC };
  } catch {
    throw new Error("neither Keplr's REST nor Osmosis's public REST gave the bank's balance by address");
  }
}
/** The amount of one bank balances by_denom answer at `url` (asked with `headers`), in base units; throws on an answer that is not the bank's. */
async function balanceAnswer(url: string, opts: KeplrOpts, headers?: Record<string, string>): Promise<bigint> {
  const res = await fetchJson(url, { timeoutMs: opts.timeoutMs ?? 15000, retries: opts.retries ?? 2, signal: opts.signal, ...(headers ? { init: { headers } } : {}) });
  const b = res?.balance;
  if (!b || typeof b !== 'object' || b.denom !== NAM.osmoDenom || typeof b.amount !== 'string' || !OWNER_AMOUNT.test(b.amount)) {
    throw new Error('balance answer without the denom asked for and a whole-number amount');
  }
  return BigInt(b.amount);
}

export async function fetchOsmosisSupply(keplrKey: string): Promise<number> {
  return toNam(await fetchOsmosisSupplyBase(keplrKey));
}

export async function fetchOsmosisStatus(keplrKey: string) {
  const res = await fetchJson(`${OSMOSIS.keplrRpc}/status`, { timeoutMs: 10000, retries: 1, init: { headers: keplrHeaders(keplrKey) } });
  const s = res.result?.sync_info;
  return {
    height: Number(s?.latest_block_height || 0),
    time: Date.parse(s?.latest_block_time || ''),
    catchingUp: Boolean(s?.catching_up),
  };
}

export async function searchOsmosisTxs(
  keplrKey: string,
  query: string,
  page = 1,
  perPage = 50,
  orderBy = 'desc',
) {
  const q = encodeURIComponent(`"${query}"`);
  const url = `${OSMOSIS.keplrRpc}/tx_search?query=${q}&page=${page}&per_page=${perPage}&order_by="${orderBy}"`;
  // A page of 50 was 1.7 MB on 2026-10-22, close to fetchJson's default cap: it may be as large as a listing.
  const res = await fetchJson(url, { timeoutMs: 30000, retries: 2, maxBytes: FETCH_TEXT_MAX_BYTES, init: { headers: keplrHeaders(keplrKey) } });
  return {
    total: Number(res.result?.total_count || 0),
    txs: res.result?.txs || [],
  };
}
