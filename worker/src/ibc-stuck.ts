// IBC packets that left Namada's escrow for Osmosis and were never delivered, acknowledged or timed out: their
// NAM stays in the escrow while Osmosis never minted the voucher, so the conservation check (escrow = Osmosis
// supply) would differ by their amount forever. The list is kept in kv `ibc.stuck_packets` with the evidence,
// re-verified against indexer.namada.net every tick (`/ibc/{inner tx}/status`: "unknown" means no ack and no
// timeout was ever relayed), and subtracted from the escrow before the comparison. A packet whose status
// changes (a late timeout refunds the sender; a late delivery mints on Osmosis) leaves the list on its own.
export interface StuckPacket {
  /** inner tx hash (indexer id, lower-case hex) */
  innerTx: string;
  wrapperTx: string | null;
  height: number | null;
  /** block time (ISO) */
  sentAt: string;
  nam: number;
  /** the packet: channel on Namada, sequence, the chain it was sent to */
  channel: string | null;
  sequence: number | null;
  counterparty: string | null;
  /** what happened, in words the sheet shows ("stuck in a transfer to Noble that was refused and never refunded") */
  note: string;
  /** last status indexer.namada.net gave ("unknown" = never delivered, never timed out) */
  status: string;
  /** the packet's timeout timestamp as the indexer reports it (ns since epoch, as a string), if given */
  timeout: string | null;
  /** when the status was last read successfully */
  verifiedAt: number;
  /** when the packet was first listed, and how */
  listedAt: number;
  listedBy: 'seed' | 'bridge_records';
  /** where the evidence is */
  evidence: string;
  /** the last read failed: the status above is from `verifiedAt` */
  stale?: boolean;
}

export interface StuckList { at: number; packets: StuckPacket[]; /** dropped since the last tick, with why */ dropped: { innerTx: string; nam: number; status: string; at: number }[] }

export const INDEXER_IBC_STATUS = (inner: string) => `https://indexer.namada.net/api/v1/ibc/${inner}/status`;

/**
 * Known at the start (2026-10-19). Namada block 7,067,154: send_packet sequence 1647 on channel-5 (to Noble's
 * channel-136) with an osmo1 receiver, 1,614 NAM, inner tx 3d4ada1c…, wrapper df26c3d0…, block time
 * 2026-06-26T11:13:59Z. Noble block 53,512,565 (11:14 UTC): recv_packet with an error acknowledgement; the
 * acknowledgement was never relayed back, so Namada never refunded it. indexer.namada.net `/ibc/<inner>/status`
 * answers "unknown" (no ack, no timeout) while neighbouring transfers answer "success"; Noble's NAM supply is 0;
 * the escrow has been exactly 1,614 NAM above the Osmosis supply at every tick since.
 */
export const SEED_STUCK_PACKETS: Omit<StuckPacket, 'status' | 'timeout' | 'verifiedAt' | 'listedAt' | 'listedBy' | 'stale'>[] = [{
  innerTx: '3d4ada1c1183ee7e1b66e0f89865c01d34a7b4bf201ed357ae58c418df8180c5',
  wrapperTx: 'df26c3d0523663005b432b4903b12de57f4e449335731bade04cfff56d1c7cd8',
  height: 7067154,
  sentAt: '2026-06-26T11:13:59Z',
  nam: 1614,
  channel: 'channel-5', sequence: 1647, counterparty: 'Noble',
  note: 'stuck in a transfer to Noble that was refused and never refunded',
  evidence: INDEXER_IBC_STATUS('3d4ada1c1183ee7e1b66e0f89865c01d34a7b4bf201ed357ae58c418df8180c5'),
}];

/** A Namada ibc_out row the bridge check found on Namada only, as a candidate for the list. */
export interface StuckCandidate { innerTx: string; wrapperTx: string | null; height: number | null; sentAt: string; nam: number; channel: string | null; sequence: number | null; counterparty: string | null }

export type StatusLookup = (innerTx: string) => Promise<{ status: string; timeout: string | null } | null>;

/** Statuses that mean the NAM is no longer waiting in the escrow for this packet. */
export const isSettled = (status: string) => status === 'success' || status === 'timeout' || status === 'fail';

/** A row from `flows` with a Namada tx id (`namada:<HASH>:…`), its inner hash when the row was keyed by the wrapper. */
export function innerTxOfRow(row: { id: string; meta?: any }): string | null {
  const m = typeof row.meta === 'string' ? (() => { try { return JSON.parse(row.meta); } catch { return {}; } })() : row.meta ?? {};
  const inner = m?.innerTxHash ?? row.id.split(':')[1];
  return typeof inner === 'string' && /^[0-9a-fA-F]{64}$/.test(inner) ? inner.toLowerCase() : null;
}

/**
 * The list for this tick: every listed packet (seed ∪ stored) re-read, candidates added when the indexer says
 * "unknown", settled ones dropped. A read that fails keeps the packet with its last status, marked stale. At
 * most `maxReads` lookups (listed packets first, so the subtraction is never made on an unread candidate).
 */
export async function reconcileStuckPackets(prev: StuckList | null, candidates: StuckCandidate[], lookup: StatusLookup, now: number, maxReads = 8): Promise<StuckList> {
  const byId = new Map<string, StuckPacket>();
  for (const p of prev?.packets ?? []) byId.set(p.innerTx, p);
  // A seed the stored list has already dropped (settled, with the evidence in `dropped`) is not listed again.
  const settled = new Set((prev?.dropped ?? []).map((d) => d.innerTx));
  for (const s of SEED_STUCK_PACKETS) if (!byId.has(s.innerTx) && !settled.has(s.innerTx)) byId.set(s.innerTx, { ...s, status: 'unknown', timeout: null, verifiedAt: 0, listedAt: now, listedBy: 'seed' });
  const dropped: StuckList['dropped'] = [];
  let reads = 0;
  for (const p of byId.values()) {
    if (reads >= maxReads) { p.stale = true; continue; }
    reads++;
    const r = await lookup(p.innerTx).catch(() => null);
    if (!r) { p.stale = true; continue; }
    p.status = r.status; p.timeout = r.timeout; p.verifiedAt = now; delete p.stale;
    if (isSettled(r.status)) { byId.delete(p.innerTx); dropped.push({ innerTx: p.innerTx, nam: p.nam, status: r.status, at: now }); }
  }
  for (const c of candidates) {
    if (byId.has(c.innerTx) || reads >= maxReads) continue;
    reads++;
    const r = await lookup(c.innerTx).catch(() => null);
    if (!r || r.status !== 'unknown') continue;
    byId.set(c.innerTx, { ...c, note: 'stuck in a transfer that was never delivered and never refunded', status: r.status, timeout: r.timeout, verifiedAt: now, listedAt: now, listedBy: 'bridge_records', evidence: INDEXER_IBC_STATUS(c.innerTx) });
  }
  const packets = [...byId.values()].sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  // Drops are kept 30 days (a seed's for good, so it is never re-listed).
  const seeds = new Set(SEED_STUCK_PACKETS.map((s) => s.innerTx));
  return { at: now, packets, dropped: [...(prev?.dropped ?? []).filter((d) => seeds.has(d.innerTx) || now - d.at < 30 * 86400000), ...dropped] };
}

export const stuckTotalNam = (list: StuckList | null): number => (list?.packets ?? []).reduce((a, p) => a + p.nam, 0);
