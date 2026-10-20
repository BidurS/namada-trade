import type { IVenue, VenuePrice } from './types';
import { fetchNamPrice, fetchNamPools } from '../sources/sqs';

export class OsmosisVenue implements IVenue {
  name = 'Osmosis DEX';
  type = 'dex' as const;
  isLive = true;

  async getPrice(): Promise<VenuePrice> {
    const { usd } = await fetchNamPrice();
    const { pools } = await fetchNamPools();
    const pool3005 = pools.find((p) => p.id === '3005');

    return {
      venue: this.name,
      usd,
      volume24hUsd: pool3005?.volume24hUsd || 0,
      ts: Date.now(),
    };
  }
}
