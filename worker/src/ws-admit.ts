// Admission to the live feed (live-hub.ts): the one Durable Object holds every socket in memory and walks them all
// on each broadcast, so a flood of connections would slow the block scan that runs in the same object.
/** Sockets the hub holds at most (about 0.3 MB each measured locally, well inside the object's memory). */
export const MAX_SOCKETS = 1000;
/** Sockets from one client address at most: the tabs of one machine, a household or an office behind one address. */
export const MAX_SOCKETS_PER_IP = 16;

export type Admission = 'ok' | 'full' | 'ip';

/** `total`: sockets open now; `sameIp`: of those, from the connecting address (0 when the address is not known). */
export function admitSocket(total: number, sameIp: number): Admission {
  if (total >= MAX_SOCKETS) return 'full';
  if (sameIp >= MAX_SOCKETS_PER_IP) return 'ip';
  return 'ok';
}
