// Admission to the live feed (live-hub.ts): the one Durable Object holds every socket in memory and walks them all
// on each broadcast, so a flood of connections would slow the block scan that runs in the same object.
import type { Client } from './client-key';

/** Sockets the hub holds at most (about 0.3 MB each measured locally, well inside the object's memory). */
export const MAX_SOCKETS = 1000;
/**
 * Sockets from one IPv4 address at most: the tabs of one machine, a household or an office behind one address, and the
 * many lines a carrier puts behind one shared address (carrier-grade NAT), hence more than for an IPv6 /64.
 */
export const MAX_SOCKETS_PER_IPV4 = 32;
/** Sockets from one IPv6 /64 at most (client-key.ts: one line's block, which one machine can fill alone). */
export const MAX_SOCKETS_PER_V6_64 = 16;
/** Sockets from one IPv6 /48 at most: the widest block one site is usually handed, so taking more /64s does not get past the cap. */
export const MAX_SOCKETS_PER_V6_48 = 64;

export type Admission = 'ok' | 'full' | 'ip';

/**
 * `total`: sockets open now; `sameKey`: of those, from the connecting client's address or /64 (client-key.ts);
 * `sameWide`: from its /48 (IPv6 only).
 */
export function admitSocket(total: number, client: Client, sameKey: number, sameWide = 0): Admission {
  if (total >= MAX_SOCKETS) return 'full';
  if (sameKey >= (client.v6 ? MAX_SOCKETS_PER_V6_64 : MAX_SOCKETS_PER_IPV4)) return 'ip';
  if (client.v6 && sameWide >= MAX_SOCKETS_PER_V6_48) return 'ip';
  return 'ok';
}

/** admitSocket over the clients of the sockets open now. */
export function admitAmong(open: Iterable<Client | undefined>, client: Client): Admission {
  let total = 0, sameKey = 0, sameWide = 0;
  for (const c of open) {
    total++;
    if (!c) continue;
    if (c.key === client.key) sameKey++;
    if (client.wide != null && c.wide === client.wide) sameWide++;
  }
  return admitSocket(total, client, sameKey, sameWide);
}
