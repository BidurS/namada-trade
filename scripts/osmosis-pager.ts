/**
 * The Osmosis history pager for scripts/backfill-osmosis.ts: a tx_search query read oldest first, every answer taken
 * from the deep index only, a failed read asked again after a pause, and the run stopped with an error naming the
 * query and the page when one keeps failing. Nothing is skipped.
 *
 * osmosis-rpc.publicnode.com answers from two indexes behind one name (measured 2026-10-29): a deep one, holding the
 * transactions from 2026-08-10 (its /status names block 68,229,727 as its first), and a shallow one holding about the
 * last 16 hours (73,431,644 that evening). The shallow one answers a query with fewer transactions (pool 3368's
 * deposits: total_count 39 against 1,970; the NAM transfers: 176 against 5,256), refuses a page past its own last
 * ("page should be within [1, 1] range"), a block before its first ("is not available, lowest height is") and a
 * transaction it does not hold ("not found"). Each request goes to either, and not by chance alone: over one kept-alive
 * connection about three answers in four were the shallow one's, in runs of up to 27 in a row; on a new connection a
 * second apart, 17 of 30, in runs of at most 4; on new connections with no pause, runs of up to 20. So no count of
 * agreeing answers shows which index gave one. The node also refuses a tx.height range ("please specify tx.height
 * event with strict equality"), and answers a JSON-RPC batch of up to 10 calls (11 are refused: "batch request exceeds
 * maximum (10) allowed number of requests"), one batch from one index: in 20 batches of a /status, a tx_search and a
 * /status, the two /status answers always named one first block, and that block always told the index the tx_search
 * came from. So:
 * - Every read is a batch of a /status and the call, and the /status answer names the first block of the index that
 *   gave the answer. The deep index is the one naming the lowest first block the opening /status reads saw
 *   (`deepFirst`); an answer of any other is asked again after a pause doubling from SHALLOW_PAUSE_MS to
 *   SHALLOW_PAUSE_MAX_MS, on a new connection, up to SHALLOW_TRIES times. An index naming a lower block still stops
 *   the run (places counted on the deep index would not be its places).
 * - A query is read oldest first: a transaction's place counted from the oldest never moves while the run reads. The
 *   deep index's total only grows; an answer of it with a smaller total (a node a block behind) is asked again too.
 * - Any other failure (no answer in time, an HTTP error, an answer that is not a whole page) is asked again after 1, 2,
 *   4 and 8 s; the PAGE_TRIES-th failure of one read stops the run (PagerError).
 * - The first transaction at or above a height is found by halving over places, in pages of one transaction.
 */

/** Failed reads of one page (or block, or status) before the run stops; the pauses between them double from 1 s. */
export const PAGE_TRIES = 5;
/** Answers of another index than the deep one (or of a deep node a block behind) one read is asked again for. */
export const SHALLOW_TRIES = 40;
/** The pause before asking again after such an answer: doubling from this up to SHALLOW_PAUSE_MAX_MS (about 2.5 min in all). */
export const SHALLOW_PAUSE_MS = 250;
export const SHALLOW_PAUSE_MAX_MS = 4000;
/** /status answers read at the start: STATUS_READS, and up to STATUS_READS_MAX while they all name one first block. */
export const STATUS_READS = 6;
export const STATUS_READS_MAX = 24;
export const STATUS_PAUSE_MS = 500;
export const PER_PAGE = 50;

/** The run stops: a read kept failing, or no answer came from the deep index. */
export class PagerError extends Error {}

export interface QueryState {
  q: string;
  /** The deep index's total: the largest total_count it gave. */
  total: number;
  /** The oldest transaction's height on the deep index, null for a query with none. */
  first: number | null;
}
export interface PagerStats { reads: number; failed: number; shallow: number; bytes: number }
export interface Page { total: number; txs: any[] }
/** A JSON-RPC call, as one of a batch's. */
export interface Call { method: string; params: Record<string, unknown> }
/** One answer: the first block and the head of the index that gave it, and the call's result or its error. */
interface Answer { first: number; head: number; result?: any; error?: string }

const SHALLOW = Symbol('shallow');
const errText = (e: any): string => `${e?.message ?? ''} ${typeof e?.data === 'string' ? e.data : ''}`.trim();
const pauseAfter = (n: number) => Math.min(SHALLOW_PAUSE_MAX_MS, SHALLOW_PAUSE_MS * 2 ** (n - 1));

export class OsmosisPager {
  readonly stats: PagerStats = { reads: 0, failed: 0, shallow: 0, bytes: 0 };
  head = 0;
  /** The deep index's first block: the lowest a /status answer named (0 until status() ran). */
  deepFirst = 0;
  /** The highest first block a /status answer named: the shallow index's (the deep one's when only it answered). */
  horizon = 0;
  private states = new Map<string, QueryState>();
  private sleep: (ms: number) => Promise<void>;
  private timeoutMs: number;

  constructor(readonly rpc: string, opts: { sleep?: (ms: number) => Promise<void>; timeoutMs?: number } = {}) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** One read: a batch of a /status and `call`, on a new connection when `fresh` (a kept one goes to one index in runs). */
  private async once(call: Call, fresh: boolean): Promise<Answer> {
    this.stats.reads++;
    const body = JSON.stringify([{ jsonrpc: '2.0', id: 0, method: 'status', params: {} }, { jsonrpc: '2.0', id: 1, ...call }]);
    const res = await fetch(this.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(fresh ? { Connection: 'close' } : {}) },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    this.stats.bytes += text.length;
    let j: any;
    try { j = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}, not JSON: ${text.slice(0, 80)}`); }
    if (!Array.isArray(j)) throw new Error(`HTTP ${res.status}, not a batch answer: ${(j?.error ? errText(j.error) : text).slice(0, 160)}`);
    const by = new Map<unknown, any>(j.map((x: any) => [x?.id, x]));
    const s = by.get(0)?.result?.sync_info, a = by.get(1);
    const first = Number(s?.earliest_block_height), head = Number(s?.latest_block_height);
    if (!(first > 0) || !(head > 0)) throw new Error(`HTTP ${res.status}, a batch answer without the node's first block and head`);
    if (!a) throw new Error(`HTTP ${res.status}, a batch answer without the call's`);
    if (a.error) return { first, head, error: errText(a.error) };
    if (a.result == null) throw new Error(`HTTP ${res.status}, no result`);
    return { first, head, result: a.result };
  }

  /**
   * A read asked until `take` takes its answer. `take` returns SHALLOW for an answer to ask again (a deep node a block
   * behind), throws a PagerError to stop the run, or throws anything else for an answer that is not what was asked (a
   * failure). An answer of another index than the deep one is asked again, unless `anyIndex` (a block or a
   * transaction, which any index holding it gives alike): then only its refusal is.
   */
  private async ask<T>(what: string, call: Call, take: (r: any) => T | typeof SHALLOW, anyIndex = false): Promise<T> {
    if (!this.deepFirst) await this.status();
    let failed = 0, shallow = 0, fresh = false;
    for (;;) {
      let got: T | typeof SHALLOW;
      try {
        const a = await this.once(call, fresh);
        this.head = Math.max(this.head, a.head);
        if (a.first < this.deepFirst) throw new PagerError(`${what}: an index whose first block is ${a.first} answered, below the deep index's ${this.deepFirst}; run again`);
        const deep = a.first === this.deepFirst;
        if (a.error != null) {
          // another index refuses what it does not hold: a page past its last, a block before its first, a transaction
          if (!deep) got = SHALLOW;
          else throw new Error(a.error.slice(0, 200));
        } else got = deep || anyIndex ? take(a.result) : SHALLOW;
      } catch (e) {
        if (e instanceof PagerError) throw e;
        failed++;
        this.stats.failed++;
        const why = String((e as Error)?.message ?? e).slice(0, 200);
        if (failed >= PAGE_TRIES) throw new PagerError(`${what}: ${failed} reads failed, the last: ${why}`);
        fresh = true;
        await this.sleep(1000 * 2 ** (failed - 1));
        continue;
      }
      if (got !== SHALLOW) return got;
      shallow++;
      this.stats.shallow++;
      if (shallow >= SHALLOW_TRIES) throw new PagerError(`${what}: ${shallow} answers came from another index than the deep one (first block ${this.deepFirst}) or a node behind, none from it`);
      fresh = true;
      await this.sleep(pauseAfter(shallow));
    }
  }

  /**
   * The head and the first blocks the /status answers name: STATUS_READS of them, up to STATUS_READS_MAX while all
   * name one, each after the first on a new connection after a pause. The lowest is the deep index's.
   */
  async status(): Promise<{ head: number; deepFirst: number; horizon: number }> {
    const firsts = new Set<number>();
    for (let i = 0; i < STATUS_READS || (i < STATUS_READS_MAX && firsts.size < 2); i++) {
      if (i) await this.sleep(STATUS_PAUSE_MS);
      for (let failed = 0; ; ) {
        try {
          const a = await this.once({ method: 'status', params: {} }, i > 0 || failed > 0);
          if (a.error != null) throw new Error(a.error.slice(0, 200));
          firsts.add(a.first);
          this.head = Math.max(this.head, a.head);
          break;
        } catch (e) {
          failed++;
          this.stats.failed++;
          if (failed >= PAGE_TRIES) throw new PagerError(`/status: ${failed} reads failed, the last: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
          await this.sleep(1000 * 2 ** (failed - 1));
        }
      }
    }
    this.deepFirst = Math.min(...firsts);
    this.horizon = Math.max(...firsts);
    return { head: this.head, deepFirst: this.deepFirst, horizon: this.horizon };
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

  static search(q: string, page: number, per: number): Call {
    return { method: 'tx_search', params: { query: q, page: String(page), per_page: String(per), order_by: 'asc', prove: false } };
  }

  /** The query's total and oldest transaction on the deep index, read the first time it is asked. */
  async query(q: string): Promise<QueryState> {
    const had = this.states.get(q);
    if (had) return had;
    const a = await this.ask(`query "${q}": its oldest transaction`, OsmosisPager.search(q, 1, 1), (r) => OsmosisPager.pageOf(r, 1, 1));
    const st: QueryState = { q, total: a.total, first: a.txs.length ? Number(a.txs[0].height) : null };
    this.states.set(q, st);
    return st;
  }

  /** Page `page` of `per` transactions of the query, oldest first, from the deep index. */
  async page(q: string, page: number, per = PER_PAGE): Promise<Page> {
    const st = await this.query(q);
    return this.ask(`query "${q}" page ${page} (${per} a page)`, OsmosisPager.search(q, page, per), (r) => {
      const a = OsmosisPager.pageOf(r, page, per);
      if (a.total < st.total) return SHALLOW;
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
   * the transactions in the range, with the page's number), so a long history is never held whole. `startPage`: the
   * page to go on from (a run resumed once the pages before it were handed on) instead of the one `from` is on.
   */
  async read(q: string, from: number, to: number, each: (txs: any[], page: number) => void | Promise<void>, startPage?: number): Promise<void> {
    const st = await this.query(q);
    const pos = startPage == null ? await this.position(q, from) : (startPage - 1) * PER_PAGE + 1;
    for (let p = Math.floor((pos - 1) / PER_PAGE) + 1; ; p++) {
      if ((p - 1) * PER_PAGE >= st.total) return;
      const a = await this.page(q, p);
      await each(a.txs.filter((t) => Number(t.height) >= from && Number(t.height) <= to), p);
      const last = a.txs.at(-1);
      if (!last || Number(last.height) > to || p * PER_PAGE >= a.total) return;
    }
  }

  /** One transaction by hash, from an index that holds it (another index's "not found" is asked again). */
  async tx(hash: string): Promise<any> {
    return this.ask(`transaction ${hash}`, { method: 'tx', params: { hash: Buffer.from(hash, 'hex').toString('base64'), prove: false } }, (r) => {
      if (String(r?.hash ?? '').toUpperCase() !== hash.toUpperCase() || !r?.tx_result) throw new Error('not the transaction asked for');
      return r;
    }, true);
  }

  /** A block's time (ms), from an index that holds the block. */
  async blockTime(height: number): Promise<number> {
    return this.ask(`block ${height}`, { method: 'block', params: { height: String(height) } }, (r) => {
      if (Number(r?.block?.header?.height) !== height) throw new Error('not the block asked for');
      const ts = Date.parse(r.block.header.time ?? '');
      if (!Number.isFinite(ts)) throw new Error('a block with no time');
      return ts;
    }, true);
  }
}
