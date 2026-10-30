// The record read to a time on both chains, as the public posts ask before they read an hour (worker/src/public-posts.ts
// hourCovered): the Osmosis catch-up search's cursor with its block's time, the Namada scan's cursor, and the cron's
// last look at the Namada nodes with a node's newest block at that time.
import { NAMADA } from '../worker/src/config';
import type { TestD1 } from './d1-sqlite';

export function readTo(db: TestD1, until: number, opts: { osmosis?: number | null; namadaCursor?: number } = {}) {
  const osmo = opts.osmosis === undefined ? until : opts.osmosis;
  db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, ?)").run(JSON.stringify({ height: 73_500_000, at: until, ...(osmo == null ? {} : { blockAt: osmo }) }), until);
  db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, ?)").run(String(opts.namadaCursor ?? 8_400_000), until);
  db.raw.prepare("INSERT OR REPLACE INTO checks (key, status, title, detail, checked_at) VALUES ('rpc_consensus', 'ok', 'Namada RPC agreement', ?, ?)")
    .run(JSON.stringify({ statuses: [{ provider: 'test', network: NAMADA.chainId, height: 8_400_000, time: until, catchingUp: false }] }), until);
}
