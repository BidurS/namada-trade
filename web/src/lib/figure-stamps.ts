// The headline figures with the stamp the overview gives each, under the plain label the Sources sheet and the status
// page both print (one list, so the two cannot name a figure differently).
import type { Overview } from '../../../shared/types';
import type { Stamp } from './prov';

/** The headline figures and their stamps (plain labels; each stamp is printed in plain words). */
export function figureStamps(o: Overview): { label: string; p: Stamp }[] {
  return [
    { label: 'NAM price, quoted', p: o.price.usd.prov },
    { label: 'Last trade price', p: o.price.swap1h.prov },
    { label: 'Staked, shielded and public funding', p: o.supply.prov },
    { label: 'NAM on Osmosis', p: o.supply.osmosisProv },
    { label: 'Pool depth on Osmosis', p: o.dex.prov },
    { label: 'Moves on Osmosis', p: o.dex.coverage },
    { label: 'Moves on Namada', p: o.namada.coverage },
    { label: 'Latest Osmosis block', p: o.heads.osmosis.prov },
    { label: 'Latest Namada block', p: o.heads.namada.prov },
  ];
}
