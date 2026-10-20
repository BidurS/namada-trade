// The address sheet's moves, counted once (S7, system.md 9.8).
//
// A bridge crossing is recorded on both chains: the sending record (ibc_out) and the receiving record
// (ibc_in, same addresses and amount within 15 minutes). The sheet lists each crossing once, by its sending
// record (the ?pairs=one rule of GET /api/flows, lib/flows.ts), and counts "who it moves NAM with" and
// "linked across the bridge" from the same rows, so the sheet's figures agree with each other. Moves of
// another coin (meta.tokenSymbol: shielded OSMO, USDC…) are listed with their own coin and never added to
// a NAM figure.
import type { AddressReport, Flow } from '../../../../shared/types';
import { otherCoin } from '../../lib/flows';

/**
 * The sheet's moves, each bridge crossing once, and who the address moves NAM with (NAM only, each crossing once,
 * biggest total first, with each label's source and author): the one definition GET /api/address/:addr uses too.
 */
export { onePerCrossing, counterpartiesOf } from '../../../../shared/flow-rules';

/** The coin a move's amount is in: NAM, or the other coin it names (meta.tokenSymbol). */
export const coinOf = (f: Flow): string => {
  const sym = (f.meta as { tokenSymbol?: unknown } | null | undefined)?.tokenSymbol;
  return otherCoin(f) && typeof sym === 'string' && sym.trim() ? sym.trim() : 'NAM';
};

export type Counterparty = AddressReport['counterparties'][number];

/** Bridge crossings of NAM between `address` and `other`, over the given moves (each crossing once). */
export function crossingsWith(moves: Flow[], address: string, other: string): { n: number; nam: number; last: number | null } {
  let n = 0;
  let nam = 0;
  let last: number | null = null;
  for (const f of moves) {
    if ((f.kind !== 'ibc_in' && f.kind !== 'ibc_out') || otherCoin(f)) continue;
    if (!((f.from === address && f.to === other) || (f.from === other && f.to === address))) continue;
    n += 1;
    nam += f.amount;
    last = last == null ? f.ts : Math.max(last, f.ts);
  }
  return { n, nam, last };
}
