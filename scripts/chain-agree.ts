/**
 * Chain data the history backfill stores as exact (block times, and the token and MASP events of a block) is taken
 * only when two nodes give the same answer, so no one node, whoever runs it, can set a stored time or a stored flow
 * alone. Each node's answer is checked on its own first: block metas only of the chain and heights asked, with times
 * that are dates, not in the future, and rising with height.
 *
 * No network or file access here: the callers pass the read.
 */

/** How many nodes must give the same answer. */
export const AGREE = 2;

/** An answer and the nodes that gave it. */
export type Agreed<T> = { value: T; by: string[] };

/**
 * Asks the nodes in order until AGREE of them give the same answer (compared by `key`) and returns it with the nodes
 * that gave it, or null when no answer reaches AGREE. A read that throws or returns null is no answer. `held` is an
 * answer already kept from one node (a cached block): it counts as that node's answer and that node is not asked again.
 * An answer that `alone` accepts is taken from one node (the caller stores nothing from it), but only while no other
 * answer is held or was given: once a node has answered differently, AGREE nodes must give the same answer.
 */
export async function agreed<T>(
  nodes: string[],
  read: (node: string) => Promise<T | null>,
  key: (v: T) => string = (v) => JSON.stringify(v),
  held?: Agreed<T>,
  alone?: (v: T) => boolean,
): Promise<Agreed<T> | null> {
  const seen = new Map<string, Agreed<T>>();
  if (held) seen.set(key(held.value), { value: held.value, by: [...held.by] });
  for (const node of new Set(nodes)) {
    if (held?.by.includes(node)) continue;
    let v: T | null;
    try { v = await read(node); } catch { continue; }
    if (v == null) continue;
    // An answer that agreed with an earlier one would reach AGREE below, so an earlier answer here is a different one.
    if (seen.size === 0 && alone?.(v)) return { value: v, by: [node] };
    const k = key(v);
    const s = seen.get(k) ?? { value: v, by: [] };
    s.by.push(node);
    seen.set(k, s);
    if (s.by.length >= AGREE) return s;
  }
  return null;
}

/**
 * The [height, time] pairs of a /blockchain answer for heights lo..hi, or null when the answer is not one: no metas,
 * a meta of another chain, a height outside lo..hi, given twice or missing, or a time that is not a date, is in the
 * future or does not rise with height (CometBFT block times rise strictly with height).
 */
export function metaTimes(answer: any, lo: number, hi: number, chainId: string, now = Date.now()): [number, number][] | null {
  const metas = answer?.result?.block_metas;
  if (!Array.isArray(metas) || metas.length !== hi - lo + 1) return null;
  const out: [number, number][] = [];
  for (const m of metas) {
    const h = Number(m?.header?.height), t = Date.parse(m?.header?.time);
    if (m?.header?.chain_id !== chainId || !Number.isSafeInteger(h) || h < lo || h > hi || !Number.isFinite(t) || t > now) return null;
    out.push([h, t]);
  }
  out.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < out.length; i++) if (out[i][0] === out[i - 1][0] || out[i][1] <= out[i - 1][1]) return null;
  return out;
}

export type TokenEvent = { type: string; attrs: Record<string, string> };
export type BlockEvents = { nEvents: number; events: TokenEvent[] };

/** The token/ and masp/ events of a block_results answer, or null for an answer with no events (a node without the block). */
export function maspEvents(answer: any): BlockEvents | null {
  const r = answer?.result;
  if (!r || typeof r !== 'object') return null;
  const evs: any[] = [...(r.end_block_events ?? []), ...(r.finalize_block_events ?? []), ...((r.txs_results ?? []) as any[]).flatMap((x) => x?.events ?? [])];
  if (!evs.length) return null;
  return {
    nEvents: evs.length,
    events: evs.filter((e) => /^(token|masp)\//.test(e?.type)).map((e) => ({ type: e.type, attrs: Object.fromEntries((e.attributes ?? []).map((a: any) => [a.key, a.value])) })),
  };
}

/** Two answers are the same block when their token/ and masp/ events are, attribute order aside. */
export const eventsKey = (b: BlockEvents): string =>
  JSON.stringify(b.events.map((e) => [e.type, Object.entries(e.attrs).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))]));

/**
 * A block's token/ and masp/ events, taken when AGREE nodes give the same events (or from the first node that answers
 * when `alone` accepts its events and nothing is held). `held` is an answer kept from one node before, which counts as
 * that node's. Returns null when every node asked answered with no events; throws when no AGREE nodes agree.
 */
export async function agreedBlock(
  h: number,
  nodes: string[],
  get: (url: string) => Promise<any>,
  held?: Agreed<BlockEvents>,
  alone?: (b: BlockEvents) => boolean,
): Promise<Agreed<BlockEvents> | null> {
  let asked = 0, empty = 0;
  const a = await agreed(nodes, async (node) => {
    asked++;
    const v = maspEvents(await get(`${node}/block_results?height=${h}`));
    if (!v) empty++;
    return v;
  }, eventsKey, held, alone);
  if (a) return a;
  if (!held && asked > 0 && empty === asked) return null;
  throw new Error(`block_results ${h}: no ${AGREE} nodes gave the same events`);
}
