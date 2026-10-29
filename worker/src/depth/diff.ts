// The depth diff (plan 1.5 depth_changes): two readings of the same things, and the rows for what appeared, left,
// filled, grew or shrank between them. Two readings are compared each minute (the stored states of the minute before
// and this one: every concentrated pool's tick ranges by their liquidity, which only a position event moves, and every
// weighted or stable pool's reserves, a row only when both moved the same way, since a swap moves them apart and is a
// trade, not a change of liquidity) and each hour (the positions and orders of the hourly read against the hour
// before's, by position id and order id, with the owner). Equal readings give no rows, so the table is bounded by real
// events. Nothing here names a coin: the base coin's decimals and the counter coins' prices come with the states.
import type { DepthChangeRow, DepthOwner, DepthSide } from '../../../shared/depth';
import type { DepthConfig } from './config';
import { decToScaled } from './proto';
import { clModel, usdPerRaw } from './model';
import type { DepthStates, StoredPoolState } from './index';

/** One thing a reading holds, with the figure two readings are compared by (`key`: a liquidity, a quantity or the two reserves, as strings the chain gave). */
export interface ChangeItem {
  pool: string;
  ref: string;
  side: DepthSide | null;
  loUsd: number | null;
  hiUsd: number | null;
  /** The item's size in whole base coins and in USD at this reading. */
  nam: number;
  usd: number;
  owner: string | null;
  key: string;
}

/** A stored pool's factor from a raw price (counter base units per base unit) to USD per whole base coin, at the pool's counter price. */
export const usdPerState = (s: Pick<StoredPoolState, 'counterUsd' | 'counterDecimals'>, baseDecimals: number): number => usdPerRaw({ counterUsd: s.counterUsd, counterDecimals: s.counterDecimals }, baseDecimals);

/** What the minute compares: every concentrated pool's ranges and every weighted or stable pool's reserves of a stored minute. */
export function minuteItemsOf(cfg: DepthConfig, states: DepthStates | null): ChangeItem[] {
  const out: ChangeItem[] = [];
  if (!states || !Array.isArray(states.pools)) return out;
  const baseUnit = 10 ** cfg.base.decimals;
  for (const s of states.pools) {
    if (!(s.counterUsd > 0) || s.counterDecimals == null) continue;
    const k = usdPerState(s, cfg.base.decimals);
    const cUnit = 10 ** s.counterDecimals;
    try {
      if (s.cl) {
        const byTicks = new Map(s.cl.ranges.map((r) => [`${r.lower_tick}:${r.upper_tick}`, String(r.liquidity_amount)]));
        for (const l of clModel(s.cl.pool, s.cl.ranges, cfg.base.denom).levels()) {
          if (l.loTick == null || l.hiTick == null) continue;
          const key = byTicks.get(`${l.loTick}:${l.hiTick}`) ?? String(l.L ?? '');
          out.push({ pool: s.id, ref: `rng:${l.loTick}:${l.hiTick}`, side: l.nam > 0 && l.counter > 0 ? null : l.nam > 0 ? 'ask' : 'bid', loUsd: l.lo * k, hiUsd: l.hi * k, nam: l.nam / baseUnit, usd: (l.counter / cUnit) * s.counterUsd, owner: null, key });
        }
      } else if (s.gamm || s.stable) {
        const coins = s.gamm ? s.gamm.assets.map((a) => ({ denom: a.denom, amount: String(a.amount) })) : s.stable!.liquidity.map((c) => ({ denom: c.denom, amount: String(c.amount) }));
        const base = coins.find((c) => c.denom === cfg.base.denom), counter = coins.find((c) => c.denom === s.counterDenom);
        if (!base || !counter) continue;
        out.push({ pool: s.id, ref: 'res', side: null, loUsd: null, hiUsd: null, nam: Number(base.amount) / baseUnit, usd: (Number(counter.amount) / cUnit) * s.counterUsd, owner: null, key: `${base.amount}|${counter.amount}` });
      }
    } catch { /* a state that does not model is not compared */ }
  }
  return out;
}

/** What the hour compares: the positions and orders of a stored owners reading (kv depth.owners), each with its owner. */
export function ownerItemsOf(owners: DepthOwner[] | null | undefined): ChangeItem[] {
  const out: ChangeItem[] = [];
  for (const o of owners ?? []) {
    for (const it of o.items ?? []) {
      const key = it.kind === 'position' ? it.liquidity : it.quantity;
      if (key == null) continue;
      out.push({ pool: it.pool, ref: `${it.kind === 'position' ? 'pos' : 'ord'}:${it.id}`, side: it.side ?? null, loUsd: it.loUsd, hiUsd: it.hiUsd, nam: it.nam, usd: it.usd, owner: o.address, key });
    }
  }
  return out;
}

/** The sign of b against a, both decimal strings (18 places are enough for a liquidity, a quantity or a reserve). */
const cmp = (a: string, b: string): number => { const x = decToScaled(a, 18), y = decToScaled(b, 18); return x === y ? 0 : y > x ? 1 : -1; };
const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);

/**
 * The rows between two readings at `ts` (the later reading's time) and `height` (its height). An item in the later
 * reading only is 'added' at its size; one in the earlier only is 'removed' at the size it had; one whose key moved is
 * 'grew' or 'shrank' (an order whose remaining fell is 'filled') by the size of the move. A reserve is a row only when
 * both reserves moved the same way.
 */
export function diffItems(prev: ChangeItem[], next: ChangeItem[], ts: number, height: number | null): DepthChangeRow[] {
  const keyOf = (i: ChangeItem) => `${i.pool}\u0000${i.ref}`;
  const before = new Map(prev.map((i) => [keyOf(i), i]));
  const after = new Map(next.map((i) => [keyOf(i), i]));
  const rows: DepthChangeRow[] = [];
  const row = (i: ChangeItem, kind: DepthChangeRow['kind'], nam: number, usd: number): DepthChangeRow => ({ ts, pool: i.pool, ref: i.ref, kind, side: i.side, loUsd: i.loUsd, hiUsd: i.hiUsd, nam: finite(nam), usd: finite(usd), owner: i.owner, height });
  for (const [k, n] of after) {
    const p = before.get(k);
    if (!p) { rows.push(row(n, 'added', n.nam, n.usd)); continue; }
    if (p.key === n.key) continue;
    if (n.ref === 'res') {
      const [pb, pc] = p.key.split('|'), [nb, nc] = n.key.split('|');
      const db = cmp(pb, nb), dc = cmp(pc, nc);
      if (db === 0 && dc === 0) continue;
      if (db * dc < 0) continue; // a swap: one reserve up, the other down
      rows.push(row(n, db + dc > 0 ? 'grew' : 'shrank', Math.abs(n.nam - p.nam), Math.abs(n.usd - p.usd)));
      continue;
    }
    let c: number;
    try { c = cmp(p.key, n.key); } catch { c = n.key > p.key ? 1 : -1; }
    if (c === 0) continue;
    const kind: DepthChangeRow['kind'] = c > 0 ? 'grew' : n.ref.startsWith('ord:') ? 'filled' : 'shrank';
    rows.push(row(n, kind, Math.abs(n.nam - p.nam), Math.abs(n.usd - p.usd)));
  }
  for (const [k, p] of before) if (!after.has(k)) rows.push(row(p, 'removed', p.nam, p.usd));
  return rows;
}
