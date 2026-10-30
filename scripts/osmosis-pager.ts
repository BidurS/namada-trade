/**
 * The Osmosis history pager for scripts/backfill-osmosis.ts: a tx_search query read oldest first, every page taken
 * from the deep index only, a failed read asked again after a pause, and the run stopped with an error naming the
 * query and the page when one keeps failing. Nothing is skipped.
 *
 * osmosis-rpc.publicnode.com answers from two indexes behind one name (measured 2026-10-29): a deep one, holding the
 * transactions from 2026-08-10 (block 68,229,727), and a shallow one holding about the last 16 hours. Each request goes
 * to either. The shallow one answers a query with fewer transactions (pool 3368's deposits: total_count 39 against
 * 1,970), refuses a page past its own last with HTTP 500 "page should be within [1, 1] range", a block before its first
 * with "is not available, lowest height is", and its /status names its first block (73,431,644 that evening). The
 * node refuses a tx.height range ("please specify tx.height event with strict equality", 2026-10-29). Pages read
 * newest first move as transactions come, and a page of one index holds other transactions than the same page of the
 * other, so:
 * - A query is read oldest first: a transaction's place counted from the oldest never moves while the run reads.
 * - Each query is first asked for its oldest transaction until an answer's lies below the highest first block a
 *   /status answer named (the shallow index's: only the deep index holds a transaction there; 'below'), or DEEP_TRIES
 *   answers came. Its deep total is the largest total_count an answer gave: two different totals keep the larger
 *   ('larger'); DEEP_TRIES answers of one total, none below that block, say every index that answered holds the same
 *   ('agreed': an empty pool, or one whose history is all recent). With the two indexes answering about half each,
 *   DEEP_TRIES answers all from the shallow one while the deep one holds more come about once in 16 million.
 * - A later answer is taken only with a total_count at least the deep total (which grows as transactions come); one
 *   with less, or a refusal of the shallow index, is asked again after SHALLOW_PAUSE_MS, up to SHALLOW_TRIES times. An
 *   agreed query whose total then jumps by more than a page met a deeper index after all: the run stops, since its
 *   places were counted on another index.
 * - Any other failure (no answer in time, an HTTP error, an answer that is not a whole page) is asked again after 1, 2,
 *   4 and 8 s; the PAGE_TRIES-th failure of one read stops the run (PagerError).
 * - The first transaction at or above a height is found by halving over places, in pages of one transaction.
 */

/** Failed reads of one page (or block, or status) before the run stops; the pauses between them double from 1 s. */
export const PAGE_TRIES = 5;
/** Answers of the shallow index (or of a deep node a block behind) one read is asked again for before the run stops. */
export const SHALLOW_TRIES = 30;
export const SHALLOW_PAUSE_MS = 500;
/** Answers of a query's oldest transaction asked for to find the deep index (each of a single transaction). */
export const DEEP_TRIES = 24;
/** /status answers read at the start, for the head and the shallow index's first block. */
export const STATUS_READS = 6;
export const PER_PAGE = 50;

/** The run stops: a read kept failing, or the answers cannot be from one index. */
export class PagerError extends Error {}
/** The shallow index's refusal (a page past its last, a block before its first, a transaction it does not hold). */
class ShortIndex extends Error {}
const SHORT_INDEX = /page should be within|is not available, lowest height is|must be less than or equal to the current blockchain height|\btx \([0-9A-F]+\) not found/i;

/** How a query was shown to come from the deep index. */
export type Deep = 'below' | 'larger' | 'agreed';
export interface QueryState {
  q: string;
  /** The deep total: the largest total_count taken. */
  total: number;
  /** 'below': an answer's oldest transaction lies below the shallow index's first block; 'larger': two totals were given and the larger kept; 'agreed': DEEP_TRIES answers gave one total. */
  deep: Deep;
  /** The oldest transaction's height on the deepest answer, null for a query with none. */
  first: number | null;
}
export interface PagerStats { reads: number; failed: number; shallow: number; bytes: number }
export interface Page { total: number; txs: any[] }

const SHALLOW = Symbol('shallow');

export class OsmosisPager {
  readonly stats: PagerStats = { reads: 0, failed: 0, shallow: 0, bytes: 0 };
  head = 0;
  /** The highest first block a /status answer named: the shallow index's (0 until status() ran). */
  horizon = 0;
  /** The lowest first block a /status answer named. */
  lowest = Infinity;
  private states = new Map<string, QueryState>();
  private sleep: (ms: number) => Promise<void>;
  private timeoutMs: number;

  constructor(readonly rpc: string, opts: { sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {}) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** One read: the JSON-RPC result, or an error (ShortIndex for the shallow index's refusal). */
  private async once(path: string): Promise<any> {
    this.stats.reads++;
    const res = await fetch(`${this.rpc}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text();
    this.stats.bytes += text.length;
    let j: any;
    try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}, not JSON: ${text.slice(0, 80)}`); }
    const err = j?.error ? `${j.error.message ?? ''} ${typeof j.error.data === 'string' ? j.error.data : ''}`.trim() : null;
    if (err && SHORT_INDEX.test(err)) throw new ShortIndex(err);
    if (err) throw new Error(`HTTP ${res.status}: ${err.slice(0, 160)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (j?.result == null) throw new Error(`HTTP ${res.status}, no result`);
    return j.result;
  }

  /**
   * A read asked until `take` takes its answer. `take` returns SHALLOW for an answer of the shallow index, throws a
   * PagerError to stop the run, or throws anything else for an answer that is not what was asked (a failure).
   */
  private async ask<T>(what: string, path: string, take: (r: any) => T | typeof SHALLOW, shortIs: 'shallow' | 'failure' = 'shallow'): Promise<T> {
    let failed = 0, shallow = 0;
    for (;;) {
      let got: T | typeof SHALLOW;
      try {
        got = take(await this.once(path));
      } catch (e) {
        if (e instanceof PagerError) throw e;
        if (e instanceof ShortIndex && shortIs === 'shallow') got = SHALLOW;
        else {
          failed++;
          this.stats.failed++;
          const why = String((e as Error)?.message ?? e).slice(0, 200);
          if (failed >= PAGE_TRIES) throw new PagerError(`${what}: ${failed} reads failed, the last: ${why}`);
          await this.sleep(1000 * 2 ** (failed - 1));
          continue;
        }
      }
      if (got !== SHALLOW) return got;
      shallow++;
      this.stats.shallow++;
      if (shallow >= SHALLOW_TRIES) throw new PagerError(`${what}: ${shallow} answers came from the shallow index or a node behind, none from the deep one`);
      await this.sleep(SHALLOW_PAUSE_MS);
    }
  }

  /** The head and the first blocks the /status answers name: STATUS_READS of them, twice as many while all name one. */
  async status(): Promise<{ head: number; horizon: number; lowest: number }> {
    for (let i = 0; i < STATUS_READS || (i < 2 * STATUS_READS && this.lowest === this.horizon); i++) {
      const s = await this.ask('/status', '/status', (r) => {
        const head = Number(r?.sync_info?.latest_block_height), first = Number(r?.sync_info?.earliest_block_height);
        if (!(head > 0) || !(first > 0)) throw new Error('no heights in /status');
        return { head, first };
      }, 'failure');
      this.head = Math.max(this.head, s.head);
      this.horizon = Math.max(this.horizon, s.first);
      this.lowest = Math.min(this.lowest, s.first);
    }
    return { head: this.head, horizon: this.horizon, lowest: this.lowest };
  }

  /** A tx_search answer checked whole: its total, and the page of transactions that total gives, oldest first. */
  private static pageOf(r: any, page: number, per: number): Page {
    const total = Number(r?.total_count);
    const txs = r?.txs;
    if (!Number.isInteger(total) || total < 0 || !Array.isArray(txs)) throw new Error('not a tx_search page');
    const due = Math.max(0, Math.min(per, total - (page - 1) * per));
    if (txs.length !== due) throw new Error(`a page of ${txs.length} transactions where its total gives ${due}`);
    for (let i = 0; i < txs.length; i++) {
      const h = Number(txs[i]?.height);
      if (!Number.isInteger(h) || h <= 0 || typeof txs[i]?.hash !== 'string') throw new Error('a transaction with no height or hash');
      if (i > 0 && h < Number(txs[i - 1].height)) throw new Error('a page not in ascending order');
    }
    return { total, txs };
  }

  static searchPath(q: string, page: number, per: number) {
    return `/tx_search?query=${encodeURIComponent(`"${q}"`)}&page=${page}&per_page=${per}&order_by=%22asc%22`;
  }

  /** The query's deep total, found the first time it is asked (see the header). */
  async query(q: string): Promise<QueryState> {
    const had = this.states.get(q);
    if (had) return had;
    if (!this.horizon) await this.status();
    const st: QueryState = { q, total: 0, deep: 'agreed', first: null };
    const totals = new Set<number>();
    for (let i = 0; i < DEEP_TRIES; i++) {
      const a = await this.ask(`query "${q}": its oldest transaction`, OsmosisPager.searchPath(q, 1, 1), (r) => OsmosisPager.pageOf(r, 1, 1));
      totals.add(a.total);
      const first = a.txs.length ? Number(a.txs[0].height) : null;
      if (first != null && first < this.horizon) { st.deep = 'below'; st.total = a.total; st.first = first; break; }
      if (a.total > st.total) { st.total = a.total; st.first = first; }
    }
    if (st.deep !== 'below' && totals.size > 1) st.deep = 'larger';
    this.states.set(q, st);
    return st;
  }

  /** Whether the deep index still answers the query: one of DEEP_TRIES answers of its oldest transaction lies below the shallow index. */
  async stillDeep(q: string): Promise<boolean> {
    for (let i = 0; i < DEEP_TRIES; i++) {
      const a = await this.ask(`query "${q}": its oldest transaction`, OsmosisPager.searchPath(q, 1, 1), (r) => OsmosisPager.pageOf(r, 1, 1));
      if (a.txs.length && Number(a.txs[0].height) < this.horizon) return true;
    }
    return false;
  }

  /** Page `page` of `per` transactions of the query, oldest first, from the deep index. */
  async page(q: string, page: number, per = PER_PAGE): Promise<Page> {
    const st = await this.query(q);
    return this.ask(`query "${q}" page ${page} (${per} a page)`, OsmosisPager.searchPath(q, page, per), (r) => {
      const a = OsmosisPager.pageOf(r, page, per);
      if (a.total < st.total) return SHALLOW;
      if (st.deep === 'agreed' && a.total > st.total + PER_PAGE) {
        throw new PagerError(`query "${q}": an answer of ${a.total} transactions after its first answers gave ${st.total} (a deeper index answered late); run again`);
      }
      st.total = a.total;
      return a;
    });
  }

  /** The place (from 1, oldest first) of the query's first transaction at or above `height`; past the last when none is. */
  async position(q: string, height: number): Promise<number> {
    const st = await this.query(q);
    let lo = 1, hi = st.total + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const a = await this.page(q, mid, 1);
      if (Number(a.txs[0].height) >= height) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /**
   * Every transaction of the query from height `from` to `to`, oldest first, handed to `each` a page at a time (only
   * the transactions in the range), so a long history is never held whole.
   */
  async read(q: string, from: number, to: number, each: (txs: any[]) => void | Promise<void>): Promise<void> {
    const pos = await this.position(q, from);
    for (let p = Math.floor((pos - 1) / PER_PAGE) + 1; ; p++) {
      if ((p - 1) * PER_PAGE >= this.states.get(q)!.total) return;
      const a = await this.page(q, p);
      await each(a.txs.filter((t) => Number(t.height) >= from && Number(t.height) <= to));
      const last = a.txs.at(-1);
      if (!last || Number(last.height) > to || p * PER_PAGE >= a.total) return;
    }
  }

  /** One transaction by hash, from an index that holds it (a "not found" is the shallow index's). */
  async tx(hash: string): Promise<any> {
    return this.ask(`transaction ${hash}`, `/tx?hash=0x${hash}`, (r) => {
      if (String(r?.hash ?? '').toUpperCase() !== hash.toUpperCase() || !r?.tx_result) throw new Error('not the transaction asked for');
      return r;
    });
  }

  /** A block's time (ms), from a node that holds the block. */
  async blockTime(height: number): Promise<number> {
    return this.ask(`block ${height}`, `/block?height=${height}`, (r) => {
      if (Number(r?.block?.header?.height) !== height) throw new Error('not the block asked for');
      const ts = Date.parse(r.block.header.time ?? '');
      if (!Number.isFinite(ts)) throw new Error('a block with no time');
      return ts;
    });
  }
}
