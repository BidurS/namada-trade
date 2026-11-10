// Every bridge channel, and the NAM each chain holds through it (docs/design/platform-plan.md, release B).
//
// Namada keeps one bridge account for every channel: NAM sent out over any of them sits there, and the account's
// balance alone does not say on which chain. The other side does: a chain that received NAM over a channel issued
// its own voucher for it, and the total of that voucher is the NAM the chain holds through the channel. So the
// reading is made in two parts, each from the chain it is about:
//   1. the channels, from Namada's own state (sources/namada.ts ibcChannels): each channel's id, the other chain's id
//      of it, and the chain it leads to, re-read every CHANNELS_EVERY_MS (a new channel is rare; a read that failed
//      or was incomplete is tried again after CHANNELS_RETRY_MS, never every tick);
//   2. for each channel, the other chain's total of the voucher `ibc/SHA256(port/channel/<NAM's address>)`, from a
//      public node of that chain (BRIDGE_CHAINS), re-read every HELD_EVERY_MS.
// A chain with no node on the list, or one whose nodes do not serve that total (Penumbra's do not), is listed with
// no figure and the reason. A read that failed keeps the last figure with its own time,
// so the row ages and says so; nothing is ever put in its place, and a row never read says it was never read.
//
// The record (kv bridge.channels) is served by GET /api/bridges and summed into the bridge cross-check
// (cron.ts ibc_conservation: the account against Osmosis AND every other chain read).
import type { BridgeChannelRow, BridgesRecord, BridgesResponse, Provenance, SourceHealth } from '../../shared/types';
import { NAM } from './config';
import { kvGetJson, kvSet } from './db';
import { STUCK_PACKETS_KV, stuckTotalNam, type StuckList } from './ibc-stuck';
import { fetchJson, publicNote, toNam } from './util';
import { ibcChannels, type IbcChannel, type ReadOpts } from './sources/namada';

/** kv key of the record. */
export const BRIDGES_KV = 'bridge.channels';
/** How often the channel list is re-read from Namada. */
export const CHANNELS_EVERY_MS = 6 * 3600_000;
/** After a channel read that failed, or left a channel without its chain, the next attempt waits this long. */
export const CHANNELS_RETRY_MS = 15 * 60_000;
/** The most channels the record keeps (the chain's own order): a list longer than this is kept to here, and the health row says so. */
export const CHANNELS_MAX_ROWS = 64;
/** The whole pass ends this long after it starts, whatever a node does: the tick's later steps keep their time. */
export const BRIDGES_PHASE_MS = 15_000;
/** How often each chain's holding is re-read. */
export const HELD_EVERY_MS = 10 * 60_000;
/** One node's answer may take this long. A chain has two nodes asked in turn and the chains are asked together, so the step ends within twice this, inside BRIDGES_PHASE_MS. */
export const HELD_TIMEOUT_MS = 4000;
/** The health rows of the two parts. */
export const BRIDGE_HEALTH = { channels: 'Namada node (bridge channels)', held: 'Other chains (NAM held over the bridge)' } as const;

/**
 * The chains a channel may lead to, by the chain id the channel's light client names: the name the pages use and the
 * public nodes asked for the voucher's total, in order (the second only when the first fails). `rest: null` with
 * `why`: a chain whose total cannot be asked this way. Checked on 2026-11-10: every node listed answered the bank's
 * supply-by-denom route for NAM's voucher.
 */
export const BRIDGE_CHAINS: Record<string, { name: string; rest: readonly string[] | null; why?: string }> = {
  'osmosis-1': { name: 'Osmosis', rest: ['https://osmosis-rest.publicnode.com', 'https://rest.cosmos.directory/osmosis'] },
  'cosmoshub-4': { name: 'Cosmos Hub', rest: ['https://cosmos-rest.publicnode.com', 'https://cosmos-api.polkachu.com'] },
  'celestia': { name: 'Celestia', rest: ['https://celestia-rest.publicnode.com', 'https://celestia-api.polkachu.com'] },
  'noble-1': { name: 'Noble', rest: ['https://noble-api.polkachu.com', 'https://api.noble.xyz'] },
  'stride-1': { name: 'Stride', rest: ['https://stride-api.polkachu.com', 'https://rest.cosmos.directory/stride'] },
  'neutron-1': { name: 'Neutron', rest: ['https://neutron-api.polkachu.com', 'https://rest.cosmos.directory/neutron'] },
  'nyx': { name: 'Nym', rest: ['https://api.nymtech.net', 'https://nym-api.polkachu.com'] },
  'penumbra-1': { name: 'Penumbra', rest: null, why: 'Penumbra is not read: its nodes do not answer the request the other chains answer for the total of a coin.' },
};

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();

/**
 * The name the other chain gives the voucher of a coin that arrived over a channel: `ibc/` and the SHA-256 of
 * `<its port>/<its channel>/<the coin's own name>`, in capitals. For NAM over Osmosis's channel this is NAM.osmoDenom.
 */
export async function voucherDenom(port: string, channel: string, base: string): Promise<string> {
  return `ibc/${hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${port}/${channel}/${base}`)))}`;
}

/** What one chain's node answered for the voucher's total, in the coin's base units. */
export type HeldRead = (rest: string, denom: string, signal?: AbortSignal) => Promise<bigint>;

/** The bank's supply-by-denom route: `{ amount: { denom, amount } }`, the amount a whole number of base units. */
export const readHeld: HeldRead = async (rest, denom, signal) => {
  const r = await fetchJson<{ amount?: { denom?: string; amount?: string } }>(`${rest}/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`, { timeoutMs: HELD_TIMEOUT_MS, retries: 0, signal });
  const a = r?.amount;
  if (!a || a.denom !== denom || typeof a.amount !== 'string' || !/^\d{1,40}$/.test(a.amount)) throw new Error('the answer names no total for the voucher');
  return BigInt(a.amount);
};

const liveStamp = (source: string, at: number) => ({ source, at, status: 'live' as const });
const missing = (source: string, note: string) => ({ source, at: null, status: 'missing' as const, note });

/** What the reads of one pass are given: the channel reader and the holding reader (the tests' own), and Osmosis's figure when the tick already read it. */
export interface BridgeDeps {
  channels?: (opts: ReadOpts) => Promise<{ channels: IbcChannel[]; height: number; provider: string; passed?: number }>;
  held?: HeldRead;
  /** NAM on Osmosis as this tick read it (the cron reads Osmosis's own total every minute): used for the row of NAM's Osmosis voucher, so the page and the cross-check state one figure. */
  osmosis?: { nam: number; at: number } | null;
}

/** The chain a row leads to, when the site has it on its list (an own property only: a chain id is a node's word). */
export const chainOf = (chainId: string | null): (typeof BRIDGE_CHAINS)[string] | undefined => (chainId && Object.hasOwn(BRIDGE_CHAINS, chainId) ? BRIDGE_CHAINS[chainId] : undefined);
/** The port of a chain's own coin transfers: only a channel that ends there gives NAM a voucher whose total can be asked. */
const TRANSFER_PORT = 'transfer';
/** Can the chain a row leads to be asked for what it holds? */
export const readable = (r: Pick<BridgeChannelRow, 'chainId' | 'counterpartyPort'>): boolean => r.counterpartyPort === TRANSFER_PORT && !!chainOf(r.chainId)?.rest;

/**
 * The row of NAM's own voucher on Osmosis: Namada's channel to Osmosis (config NAM.namadaChannel) with the voucher
 * the site reads every minute (NAM.osmoDenom). By the channel as well as the voucher: a voucher's name is made from
 * the other side's channel alone, and two chains may give their channels the same number.
 */
export const osmosisRow = (r: Pick<BridgeChannelRow, 'channel' | 'denom'>): boolean => r.channel === NAM.namadaChannel && r.denom === NAM.osmoDenom;

/** A stored row back as the channel it was read from (the channel list is kept between its own reads). */
const channelOf = (r: BridgeChannelRow): IbcChannel => ({ channel: r.channel, open: r.open, counterpartyPort: r.counterpartyPort, counterpartyChannel: r.counterpartyChannel, connection: null, client: null, chainId: r.chainId });

/**
 * One row: the channel, the chain it leads to and the NAM that chain holds through it. `prev` is the row as last
 * stored: a read that fails keeps its figure with the time it was read (the row ages; it is never refreshed with a
 * guess), and a row never read says so. The row of NAM's own Osmosis voucher (NAM.osmoDenom, whatever chain id the
 * channel's client names) takes the tick's reading when the tick has one; any other voucher is asked of its chain,
 * and only a channel that ends at the other chain's own coin transfers has one.
 */
export async function bridgeRow(c: IbcChannel, prev: BridgeChannelRow | undefined, now: number, deps: BridgeDeps, signal?: AbortSignal): Promise<{ row: BridgeChannelRow; asked: boolean; failed: string | null }> {
  const known = chainOf(c.chainId);
  const denom = await voucherDenom(c.counterpartyPort, c.counterpartyChannel, NAM.namadaToken);
  const base = { channel: c.channel, counterpartyPort: c.counterpartyPort, counterpartyChannel: c.counterpartyChannel, chainId: c.chainId, chain: known?.name ?? null, open: c.open, denom };
  const keep = (note: string): BridgeChannelRow['held'] => (prev?.held.value != null && prev.held.prov.at != null && prev.denom === denom
    ? { value: prev.held.value, prov: { source: prev.held.prov.source, at: prev.held.prov.at, status: 'stale', note } }
    : { value: null, prov: missing(known ? `${known.name} node` : 'the other chain', note) });
  if (osmosisRow(base) && deps.osmosis) return { row: { ...base, held: { value: deps.osmosis.nam, prov: liveStamp('Osmosis node', deps.osmosis.at) } }, asked: false, failed: null };
  if (c.counterpartyPort !== TRANSFER_PORT) return { row: { ...base, held: { value: null, prov: missing(known?.name ?? 'the other chain', 'This channel does not end at the other chain\'s own coin transfers, so no total of NAM is read for it.') } }, asked: false, failed: null };
  if (!c.chainId) return { row: { ...base, held: keep('The chain this channel leads to could not be read from Namada.') }, asked: false, failed: null };
  if (!known) return { row: { ...base, held: { value: null, prov: missing('the other chain', 'No public node of this channel\'s chain is on this site\'s list, so what it holds is not read.') } }, asked: false, failed: null };
  if (!known.rest) return { row: { ...base, held: { value: null, prov: missing(known.name, known.why ?? `${known.name} is not read.`) } }, asked: false, failed: null };
  let why = '';
  for (const rest of known.rest) {
    try {
      const total = await (deps.held ?? readHeld)(rest, denom, signal);
      return { row: { ...base, held: { value: toNam(total), prov: liveStamp(`${known.name} node`, now) } }, asked: true, failed: null };
    } catch (e) { why = publicNote(String((e as Error)?.message ?? e)).slice(0, 120); }
  }
  return { row: { ...base, held: keep(`${known.name} did not answer at the last reading${why ? ` (${why})` : ''}.`) }, asked: true, failed: known.name };
}

/** How old a chain's figure may be before it is served as old and left out of the sums: three of its reads. */
export const HELD_STALE_MS = 3 * HELD_EVERY_MS;

/** A row's figure when it is current at `now`: read within HELD_STALE_MS. An older figure, or none, is null. */
export const currentHeld = (r: BridgeChannelRow, now: number): number | null =>
  (r.held.value != null && r.held.prov.at != null && now - r.held.prov.at <= HELD_STALE_MS ? r.held.value : null);

/**
 * A row's name in a list: its chain as this site names it, and its channel too when another row leads to the same
 * chain; a chain the site has no name for is named by its channel. Never the chain's id: that is a node's word, and
 * these names go into sentences.
 */
export const rowName = (r: BridgeChannelRow, rows: readonly BridgeChannelRow[]): string => {
  const name = r.chain ?? r.channel;
  return rows.some((x) => x !== r && (x.chain ?? x.channel) === name) ? `${name} (${r.channel})` : name;
};

/**
 * Why a channel list is refused, or null when it stands. A node's answer is one node's word, and a list taken
 * wrongly is kept for hours, so it is held to what is known: it must hold Namada's channel to Osmosis as config
 * names it; nothing else may claim NAM's Osmosis voucher on Osmosis; no two channels may name one other side on one
 * chain; and against the record (the chain never removes a channel and a channel never changes its other side or
 * its chain) it must hold every channel on record, each with the other side and the chain it had.
 */
export function listRefusal(list: readonly IbcChannel[], prevRows: readonly BridgeChannelRow[]): string | null {
  if (!list.length) return 'the chain listed no channel';
  const osmosis = (c: IbcChannel) => c.counterpartyPort === 'transfer' && c.counterpartyChannel === NAM.osmoChannel;
  if (!list.some((c) => c.channel === NAM.namadaChannel && osmosis(c))) return 'the answer lacks the channel to Osmosis';
  if (list.some((c) => c.channel !== NAM.namadaChannel && osmosis(c) && c.chainId === 'osmosis-1')) return 'the answer names a second channel to the same other side';
  const sides = new Set<string>();
  for (const c of list) {
    if (!c.chainId) continue;
    const side = `${c.chainId}|${c.counterpartyPort}|${c.counterpartyChannel}`;
    if (sides.has(side)) return 'the answer names a second channel to the same other side';
    sides.add(side);
  }
  const lacks = prevRows.filter((p) => !list.some((c) => c.channel === p.channel)).length;
  if (lacks) return `the answer lacks ${lacks} of the channels on record`;
  for (const p of prevRows) {
    const c = list.find((x) => x.channel === p.channel);
    if (!c) continue;
    if (c.counterpartyPort !== p.counterpartyPort || c.counterpartyChannel !== p.counterpartyChannel) return 'the answer names another other side for a channel on record';
    if (c.chainId && p.chainId && c.chainId !== p.chainId) return 'the answer names another chain for a channel on record';
  }
  return null;
}

/**
 * One pass, at most once a tick: the channel list when it is due, then every chain's holding when that is due, all
 * chains at once. Writes the record and its health rows; returns the record, or null while the channel list has
 * never been read. A list that fails listRefusal is a failed read. A channel whose chain could not be read this
 * time keeps the chain it had, and the list counts as read (the next read a whole interval away) only when every
 * channel has its chain, else it is tried again after CHANNELS_RETRY_MS; every attempt is remembered, whatever came
 * of it, so a list is never asked for tick after tick. A pass cut by the tick's deadline blames no chain: it keeps
 * what was read before the cut and leaves the rest as it was, to be read at the next tick. A record that cannot be
 * read throws: the guards above rest on it, so nothing is done without it.
 */
export async function runBridges(env: { DB: D1Database }, health: SourceHealth[], now: number, opts: { read?: ReadOpts; signal?: AbortSignal; deps?: BridgeDeps } = {}): Promise<BridgesRecord | null> {
  const deps = opts.deps ?? {};
  const prev = await kvGetJson<BridgesRecord>(env.DB, BRIDGES_KV);
  const prevRows = prev?.rows ?? [];
  const prevBy = new Map(prevRows.map((r) => [r.channel, r]));
  let list: IbcChannel[] | null = prevRows.length ? prevRows.map(channelOf) : null;
  let channelsAt = prev?.channelsAt ?? 0, height = prev?.height ?? 0, provider = prev?.provider ?? '', triedAt = prev?.triedAt ?? 0;
  const channelsDue = (!list || now - channelsAt >= CHANNELS_EVERY_MS) && now - triedAt >= CHANNELS_RETRY_MS;
  /** The record as it stood, with this pass's attempt remembered. */
  const attempted = (): BridgesRecord => (prev ? { ...prev, triedAt } : { at: 0, channelsAt: 0, triedAt, height: 0, provider: '', rows: [] });
  let reread = false;
  if (channelsDue) {
    triedAt = now;
    try {
      const r = await (deps.channels ?? ibcChannels)(opts.read ?? {});
      const merged = r.channels.map((c): IbcChannel => {
        const p = prevBy.get(c.channel);
        return !c.chainId && p?.chainId ? { ...c, chainId: p.chainId } : c;
      });
      const refused = listRefusal(merged, prevRows);
      if (refused) throw new Error(refused);
      const unresolved = merged.filter((c) => !c.chainId).length;
      list = merged.slice(0, CHANNELS_MAX_ROWS);
      height = r.height; provider = r.provider; reread = true;
      if (!unresolved) channelsAt = now;
      const more = merged.length > list.length ? `; ${merged.length - list.length} more are not kept` : '';
      const passed = r.passed ? `; ${r.passed} whose other side is named in a form this site does not read ${r.passed === 1 ? 'is' : 'are'} left out` : '';
      // the list was read: a channel whose chain the chain's state does not say is said in the note and is no fault of a source
      health.push({ name: BRIDGE_HEALTH.channels, ok: true, at: now, note: `${merged.length} channels at block ${r.height.toLocaleString('en-US')} from ${r.provider}${unresolved ? `; the chain of ${unresolved} could not be read, so the list is read again soon` : ''}${more}${passed}` });
    } catch (e) {
      if (opts.signal?.aborted) {
        await kvSet(env.DB, BRIDGES_KV, attempted()).catch(() => {});
        return prev;
      }
      health.push({ name: BRIDGE_HEALTH.channels, ok: false, at: now, note: publicNote(`The channel list could not be read: ${String((e as Error)?.message ?? e).slice(0, 120)}`) });
    }
  }
  if (!list) {
    // never read: the attempt is remembered, so the next one waits its turn
    if (channelsDue) await kvSet(env.DB, BRIDGES_KV, attempted()).catch(() => {});
    return null;
  }
  // each chain's holding is read when its turn has come, and at once after the list was read anew; between turns the
  // stored record stands (the route that serves it puts the site's own minute reading of Osmosis in Osmosis's row)
  const heldDue = reread || !prev || !prevRows.length || now - prev.at >= HELD_EVERY_MS;
  if (!heldDue) {
    if (prev && triedAt !== (prev.triedAt ?? 0)) await kvSet(env.DB, BRIDGES_KV, attempted()).catch(() => {});
    return prev;
  }
  const done = await Promise.all(list.map((c) => bridgeRow(c, prevBy.get(c.channel), now, deps, opts.signal)));
  if (opts.signal?.aborted) {
    // cut by the tick's deadline: what answered before the cut is kept, a chain that had not is left as it stood
    // (never read: it says so), and the holdings stay due, so the next tick reads them; the list read is not lost
    const rows = done.map((d): BridgeChannelRow => {
      if (!d.failed) return d.row;
      const p = prevBy.get(d.row.channel);
      return { ...d.row, held: p && p.denom === d.row.denom ? p.held : { value: null, prov: missing(d.row.chain ? `${d.row.chain} node` : 'the other chain', 'Not read yet.') } };
    });
    const cut: BridgesRecord = { at: prev?.at ?? 0, channelsAt, triedAt, height, provider, rows };
    await kvSet(env.DB, BRIDGES_KV, cut).catch(() => {});
    return cut;
  }
  const rec: BridgesRecord = { at: now, channelsAt, triedAt, height, provider, rows: done.map((d) => d.row) };
  await kvSet(env.DB, BRIDGES_KV, rec);
  const asked = done.filter((d) => d.asked), failed = asked.filter((d) => d.failed);
  const unreadable = rec.rows.filter((r) => chainOf(r.chainId) && !readable(r)).map((r) => rowName(r, rec.rows));
  // the nodes asked are other chains' public nodes: one of them silent is said in the note and on its row, and is no
  // fault of this site's. Not ok only when none of them answered: then the fault is likelier on this side.
  health.push({
    name: BRIDGE_HEALTH.held, ok: asked.length === 0 || failed.length < asked.length, at: now,
    note: `${asked.length - failed.length} of ${asked.length} chains answered${failed.length ? `; no answer from ${failed.map((d) => d.failed).join(', ')}` : ''}${unreadable.length ? `; not readable: ${unreadable.join(', ')}` : ''}`,
  });
  return rec;
}

/**
 * The sums the page and the cross-check both state, over the figures current at `now`: NAM on every chain read, NAM
 * on the chains read other than through NAM's Osmosis voucher, and the rows with no current figure (never read, not
 * readable, or read too long ago to stand for now). No row at all gives nulls: nothing read is not zero. `heldKept`:
 * a figure in the sum was kept from an earlier reading, so the sum is not this reading's.
 */
export function bridgeSums(rec: BridgesRecord | null, now: number): { heldNam: number | null; heldAt: number | null; heldKept: boolean; otherNam: number | null; otherRead: string[]; unread: string[] } {
  const rows = rec?.rows ?? [];
  const read = rows.filter((r) => currentHeld(r, now) != null);
  const others = read.filter((r) => !osmosisRow(r));
  return {
    heldNam: read.length ? read.reduce((a, r) => a + (r.held.value as number), 0) : null,
    // the sum is as old as its oldest part
    heldAt: read.length ? Math.min(...read.map((r) => r.held.prov.at as number)) : null,
    // a part of the sum is a figure kept from an earlier reading because the last one failed
    heldKept: read.some((r) => r.held.prov.status !== 'live'),
    otherNam: others.length ? others.reduce((a, r) => a + (r.held.value as number), 0) : null,
    otherRead: others.map((r) => rowName(r, rows)),
    unread: rows.filter((r) => currentHeld(r, now) == null).map((r) => rowName(r, rows)),
  };
}

/** How old the bridge account's own reading, or the stuck list, may be before it is served as old (the tick writes both every minute). */
export const ACCOUNT_STALE_MS = 10 * 60_000;
/** How old the channel list may be before its stamp says so: two of its reads. */
export const CHANNELS_STALE_MS = 2 * CHANNELS_EVERY_MS;

const NOT_AGAIN = 'Not read again in its usual time.';
const stampOf = (source: string, at: number | null, now: number, maxAge: number, never: string): Provenance =>
  (at == null ? { source, at: null, status: 'missing', note: never } : now - at <= maxAge ? { source, at, status: 'live' } : { source, at, status: 'stale', note: NOT_AGAIN });

/**
 * GET /api/bridges: the stored record as an answer. The bridge account's balance is the tick's own minute reading
 * (metric supply.ibc_escrow), so the page states the figure the home page states. The row of NAM's Osmosis voucher
 * carries the newer of the tick's minute reading of Osmosis (metric supply.osmosis) and the record's own. A chain's
 * figure older than HELD_STALE_MS is served with its own time, marked old, and left out of the sum; the sum is dated
 * by its oldest part. The stuck transfers carry the time their status was last read. What is in the account beyond
 * both is stated only when the account is current, the stuck list was read and EVERY chain that can be read has a
 * current figure: a remainder made with a chain's figure missing would count that chain's NAM as unaccounted for.
 * (A stuck transfer whose status could not be read again this minute still counts, as it does in the cross-check;
 * its stamp says it is old, and the page's stamp of the remainder follows it.)
 */
export async function bridgesAnswer(db: D1Database, now: number): Promise<BridgesResponse> {
  const latest = (key: string) => db.prepare('SELECT ts, value FROM metrics WHERE key = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').bind(key, now).first<{ ts: number; value: number }>().catch(() => null);
  const [rec, account, osmosis, stuckRead] = await Promise.all([
    kvGetJson<BridgesRecord>(db, BRIDGES_KV).catch(() => null),
    latest('supply.ibc_escrow'),
    latest('supply.osmosis'),
    kvGetJson<StuckList>(db, STUCK_PACKETS_KV).then((v) => ({ list: v }), () => null),
  ]);
  const channels = (rec?.rows ?? []).map((r): BridgeChannelRow => {
    if (osmosisRow(r) && osmosis && (r.held.prov.at == null || osmosis.ts >= r.held.prov.at)) return { ...r, held: { value: osmosis.value, prov: stampOf('Osmosis node', osmosis.ts, now, HELD_STALE_MS, '') } };
    if (r.held.value != null && r.held.prov.at != null && r.held.prov.status === 'live' && now - r.held.prov.at > HELD_STALE_MS) return { ...r, held: { value: r.held.value, prov: { ...r.held.prov, status: 'stale', note: NOT_AGAIN } } };
    return r;
  });
  const shown: BridgesRecord | null = rec ? { ...rec, rows: channels } : null;
  const sums = bridgeSums(shown, now);
  const accountS = { value: account?.value ?? null, prov: stampOf('Namada node', account?.ts ?? null, now, ACCOUNT_STALE_MS, 'The bridge account has not been read.') };
  const held: BridgesResponse['held'] = sums.heldNam != null && sums.heldAt != null
    ? { value: sums.heldNam, prov: sums.heldKept
      ? { source: 'each chain\'s own node', at: sums.heldAt, status: 'stale', note: 'A chain in this sum did not answer at its last reading; its figure is the one before.' }
      : { source: 'each chain\'s own node', at: sums.heldAt, status: 'live' } }
    : { value: null, prov: missing('each chain\'s own node', 'No chain has a current figure.') };
  // the stuck transfers: their NAM, dated by the oldest reading of a transfer's status (the list's own time when it
  // holds none), old when a status could not be read again or the list was not rewritten in its usual time
  const list = stuckRead?.list ?? null;
  const stuck: BridgesResponse['stuck'] = !stuckRead
    ? { value: null, prov: missing('Namada indexer', 'The list of stuck transfers could not be read.') }
    : !list
      ? { value: null, prov: missing('Namada indexer', 'No list of stuck transfers has been written yet.') }
      : (() => {
          const at = list.packets.length ? Math.min(...list.packets.map((p) => p.verifiedAt).filter(Number.isFinite), list.at) : list.at;
          const old = list.packets.some((p) => p.stale) || now - list.at > ACCOUNT_STALE_MS;
          return { value: stuckTotalNam(list), prov: old ? { source: 'Namada indexer', at, status: 'stale' as const, note: NOT_AGAIN } : { source: 'Namada indexer', at, status: 'live' as const } };
        })();
  // every chain that can be read has a current figure, every channel's chain is known, and Osmosis, which holds
  // nearly all of it, is among the chains read
  const everyChain = channels.some((r) => osmosisRow(r) && currentHeld(r, now) != null)
    && channels.filter((r) => readable(r) || osmosisRow(r)).every((r) => currentHeld(r, now) != null) && channels.every((r) => r.chainId != null);
  const whole = accountS.value != null && accountS.prov.status === 'live' && held.value != null && stuck.value != null && everyChain;
  return {
    asOf: now,
    account: accountS,
    channels,
    held,
    unread: sums.unread,
    stuck,
    beyondNam: whole ? (accountS.value as number) - (held.value as number) - (stuck.value as number) : null,
    prov: rec && rec.rows.length
      ? { ...stampOf('Namada node', rec.channelsAt || null, now, CHANNELS_STALE_MS, 'The channel list has not been read whole yet.'), height: rec.height }
      : { source: 'Namada node', at: null, status: 'missing', note: 'The channel list has not been read yet.' },
  };
}
