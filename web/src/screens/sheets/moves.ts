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
import { isOtherCoin, onePerCrossing } from '../../../../shared/flow-rules';
import { INTERNAL_ADDRESSES } from '../../../../shared/alerts';

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
/**
 * What the address received in NAM over `moves` (each bridge crossing once, other coins left out), and the part of it
 * that came out of the shielded pool: every leg from the pool to this address, whatever its kind (an unshield, a
 * crossing straight out of the pool, the pool's fee for a transaction it paid to this address). Dust that prints as 0
 * counts as it is. `moves` is how many such legs there were.
 */
export function fromPoolOf(moves: readonly Flow[], address: string): { receivedNam: number; fromPoolNam: number; moves: number } {
  let receivedNam = 0, fromPoolNam = 0, n = 0;
  for (const f of onePerCrossing(moves.filter((x) => !isOtherCoin(x) && Number.isFinite(x.amount)))) {
    if (f.to !== address || f.from === address) continue;
    receivedNam += f.amount;
    if (f.from === INTERNAL_ADDRESSES.masp) { fromPoolNam += f.amount; n += 1; }
  }
  return { receivedNam, fromPoolNam, moves: n };
}

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
