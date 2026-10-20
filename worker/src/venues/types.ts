import type { Flow } from '../../../shared/types';

export interface OrderbookLevel {
  price: number;
  amount: number;
}

export interface Orderbook {
  venue: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  ts: number;
}

export interface VenuePrice {
  venue: string;
  usd: number | null;
  change24h?: number | null;
  volume24hUsd?: number | null;
  ts: number;
}

export interface VenueTrade {
  id: string;
  venue: string;
  side: 'buy' | 'sell';
  amount: number;
  price: number;
  ts: number;
}

export interface IVenue {
  name: string;
  type: 'dex' | 'cex';
  isLive: boolean;

  getPrice(): Promise<VenuePrice>;
  getOrderbook?(): Promise<Orderbook | null>;
  getRecentTrades?(limit?: number): Promise<VenueTrade[]>;
  getFlows?(sinceTs?: number): Promise<Flow[]>;
}
