// Where the Address sheet was opened from (docs/design/nav-search-plan.md 3.2): a list row says so before it opens
// the sheet ("From holders · No. 1,204 by total NAM", "From activity · Move 51 of 53,934"), and the sheet reads it on
// mount. A tiny module so the lazy sheets chunk and the Activity chunk share it without loading each other.
//
// The overlays host takes only an address today (app/overlays.tsx openAddress); when it carries an `origin` of its
// own (SheetRequest), the sheet prefers that and this note is the fallback. A note is for one address and goes stale
// after ORIGIN_MS, so a sheet opened later from search for the same address never claims a list it did not come from;
// the sheet clears it when it closes.
import type { Stamp } from '../../lib/prov';

export type AddressOrigin =
  | {
      from: 'holders';
      /** the rank the row printed */
      rank: number;
      /** the order it was printed in */
      by: 'total' | 'liquid' | 'bonded';
      chain: 'namada' | 'osmosis' | 'all';
      /** the order's stamp (when the list was read) */
      stamp: Stamp | null;
    }
  | {
      from: 'activity';
      /** the move's place in the list, newest first */
      pos: number;
      /** every move the filters select, when known */
      total: number | null;
      /** false: `total` is a lower bound (an older server ignored a filter) */
      exact: boolean;
      /** the list's stamp (the flow index) */
      stamp: Stamp | null;
    };

export const ORIGIN_MS = 30_000;

let note: { address: string; origin: AddressOrigin; at: number } | null = null;

/** Say where the sheet for `address` is about to be opened from (call right before openAddress). */
export function noteOrigin(address: string, origin: AddressOrigin) {
  note = { address, origin, at: Date.now() };
}

/** The origin noted for `address`, if it is fresh; null otherwise. Reading keeps it (a remount reads it again). */
export function originFor(address: string): AddressOrigin | null {
  return note && note.address === address && Date.now() - note.at <= ORIGIN_MS ? note.origin : null;
}

/** Forget the note for `address` (the sheet closed). */
export function clearOrigin(address: string) {
  if (note?.address === address) note = null;
}
