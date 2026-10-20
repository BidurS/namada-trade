import { OSMOSIS, NAM } from '../config';
import { fetchJson, toNam } from '../util';

export interface HolderItem {
  address: string;
  balance: string;
  balanceNum: number;
}

export async function fetchOsmosisHolders(keplrKey: string): Promise<HolderItem[]> {
  return (await fetchOsmosisHolderList(keplrKey)).holders;
}

/** Pages of 100 holders read at most per sync (10,000 holders; 1,332 on 2026-10-17). */
export const OSMOSIS_HOLDER_PAGES = 100;

/**
 * Options for a Keplr REST read. The cron passes its tick deadline (`signal`) and a short timeout with one retry,
 * so a Keplr that accepts requests and never answers costs seconds, not the tick; scripts keep the long defaults.
 */
export interface KeplrOpts { signal?: AbortSignal; timeoutMs?: number; retries?: number }

/**
 * Every NAM holder on Osmosis. `complete` is true only when a page carried a pagination object whose next_key is
 * empty: the bank saying there are no more pages, which is what allows an address missing from the list to be
 * read as holding nothing (the cron also checks the list adds up to the supply). A 200 answer without pagination,
 * or hitting the page cap, leaves `complete` false (`capped` says which).
 */
export async function fetchOsmosisHolderList(keplrKey: string, pages = OSMOSIS_HOLDER_PAGES, opts: KeplrOpts = {}): Promise<{ holders: HolderItem[]; complete: boolean; capped: boolean }> {
  const rest = OSMOSIS.keplrRest(keplrKey);
  const denom = encodeURIComponent(NAM.osmoDenom);
  let nextKey: string | null = null;
  let complete = false;
  let capped = true;
  const holders: HolderItem[] = [];

  for (let page = 0; page < pages; page++) {
    // A list cut by the deadline is not a list: the caller gets an error, never part of it as if it were all.
    if (opts.signal?.aborted) throw new Error(`deadline passed after ${page} pages of the Osmosis holder list`);
    const pageUrl: string = `${rest}/cosmos/bank/v1beta1/denom_owners_by_query?denom=${denom}&pagination.limit=100${
      nextKey ? `&pagination.key=${encodeURIComponent(nextKey)}` : ''
    }`;
    const pageRes: any = await fetchJson(pageUrl, { timeoutMs: opts.timeoutMs ?? 25000, retries: opts.retries ?? 2, signal: opts.signal });
    const owners = pageRes.denom_owners || [];
    for (const o of owners) {
      const balStr = o.balance?.amount || '0';
      holders.push({
        address: o.address,
        balance: balStr,
        balanceNum: toNam(balStr),
      });
    }
    const pg = pageRes?.pagination;
    if (!pg || typeof pg !== 'object') { capped = false; break; } // not the bank's answer: stop, not complete
    nextKey = pg.next_key || null;
    if (!nextKey) { complete = true; capped = false; break; }
    if (owners.length === 0) { capped = false; break; } // a next key with an empty page: stop, not complete
  }

  // Sort descending by balance
  holders.sort((a, b) => b.balanceNum - a.balanceNum);
  return { holders, complete, capped: complete ? false : capped };
}

/** The bank's supply of NAM on Osmosis, in base units (exact, for the holder-list check). */
export async function fetchOsmosisSupplyBase(keplrKey: string, opts: KeplrOpts = {}): Promise<bigint> {
  const rest = OSMOSIS.keplrRest(keplrKey);
  const denom = encodeURIComponent(NAM.osmoDenom);
  const res = await fetchJson(`${rest}/cosmos/bank/v1beta1/supply/by_denom?denom=${denom}`, {
    timeoutMs: opts.timeoutMs ?? 15000,
    retries: opts.retries ?? 2,
    signal: opts.signal,
  });
  const amt = res?.amount?.amount;
  if (typeof amt !== 'string' || !/^\d+$/.test(amt)) throw new Error('supply answer without an amount');
  return BigInt(amt);
}

export async function fetchOsmosisSupply(keplrKey: string): Promise<number> {
  return toNam(await fetchOsmosisSupplyBase(keplrKey));
}

export async function fetchOsmosisStatus(keplrKey: string) {
  const rpc = OSMOSIS.keplrRpc(keplrKey);
  const res = await fetchJson(`${rpc}/status`, { timeoutMs: 10000, retries: 1 });
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
  const rpc = OSMOSIS.keplrRpc(keplrKey);
  const q = encodeURIComponent(`"${query}"`);
  const url = `${rpc}/tx_search?query=${q}&page=${page}&per_page=${perPage}&order_by="${orderBy}"`;
  const res = await fetchJson(url, { timeoutMs: 30000, retries: 2 });
  return {
    total: Number(res.result?.total_count || 0),
    txs: res.result?.txs || [],
  };
}
