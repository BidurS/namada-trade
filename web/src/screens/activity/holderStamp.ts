// The stamp of the holder figures (the holder counts and the top-10 shares): one rule, so Home and
// /holders say the same age for the same figure.
//
// A server that sends overview.concentration.namadaProv / osmosisProv (the oldest balance reading
// behind the count and the top 10, old past 6 h, owner decision 7) is used as it is. An older server
// sends none: then the stamp is read from the ten biggest holder rows (GET /api/holders), the oldest
// reading among them (a lower bound for the whole list), old when every one of them is old or
// disagrees. The overview's fetch time is never the age of a balance.
import type { Holder, Overview, Provenance } from '../../../../shared/types';
import type { Stamp } from '../../lib/prov';
import { TECH } from './words';

export type HolderChain = 'namada' | 'osmosis';

/** overview.concentration on servers that stamp the holder figures (absent before W2/W13 ship). */
type StampedConcentration = Overview['concentration'] & { namadaProv?: Provenance | null; osmosisProv?: Provenance | null };

/** The server's stamp of one chain's holder figures, or null when the server sends none. */
export function serverHolderProv(o: Overview | null | undefined, chain: HolderChain): Provenance | null {
  if (!o) return null;
  const c = o.concentration as StampedConcentration;
  return (chain === 'namada' ? c.namadaProv : c.osmosisProv) ?? null;
}

/**
 * The balances behind a list of holder rows: the oldest reading (a chain read, else the last write),
 * old when every row is old or disagrees (the server's status, owner decision 7: older than 6 h).
 */
export function balancesStamp(rows: Holder[]): Stamp {
  const reads = rows.map((h) => h.verifiedAt ?? h.updatedAt).filter((t): t is number => t != null);
  const allOld = rows.length > 0 && rows.every((h) => h.status === 'stale' || h.status === 'conflict');
  return {
    source: TECH.holderIndex,
    plain: 'Holder index',
    at: reads.length ? Math.min(...reads) : null,
    status: !reads.length ? 'missing' : allOld ? 'stale' : 'live',
    note: allOld ? 'Spendable balances are re-read from the chain on a schedule; these were read longer ago than 6 hours.' : undefined,
  };
}

/**
 * The stamp of one chain's holder count and top-10 share.
 * - `rows`: the ten biggest holders on that chain (null while they load or when the server stamps the figures).
 * - `rowsFailed`: the rows did not load, so the age is not known.
 * - `rewoundAt`: under Rewind the figures are current, not as of then, and say so.
 * Returns null while the stamp is still on its way (the figure waits with it).
 */
export function holderFiguresStamp(
  o: Overview | null | undefined,
  chain: HolderChain,
  rows: Holder[] | null,
  rowsFailed: boolean,
  rewoundAt: number | null,
  rewoundNote: string | null,
): Stamp | null {
  if (!o) return null;
  const server = serverHolderProv(o, chain);
  let p: Stamp;
  if (server) p = { ...server, plain: 'Holder index' };
  else if (rows && rows.length) {
    const b = balancesStamp(rows);
    p = {
      ...b,
      note:
        b.status === 'stale'
          ? 'Counted from spendable balances re-read from the chain on a schedule; the ten biggest were read longer ago than 6 hours, so the figure is old.'
          : 'Counted from spendable balances re-read from the chain on a schedule; the time is the oldest reading among the ten biggest holders.',
    };
  } else if (rowsFailed || (rows && !rows.length)) {
    const note = rowsFailed ? 'The balance readings behind this figure did not load, so how old it is is not known.' : 'No balance readings came back for this chain, so how old this figure is is not known.';
    p = { source: TECH.holderIndex, plain: 'Holder index', at: null, status: 'stale', note };
  } else return null;
  return rewoundAt != null ? { ...p, status: 'stale', note: rewoundNote ?? p.note } : p;
}
