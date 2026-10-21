import { explorerHashOf, isOtherCoin } from '../../../shared/flow-rules';
import type { Flow, ForumPost, GovernanceProposal } from '../../../shared/types';
import { safeHttpUrl } from '../../../shared/flow-rules';
import { EXPLORERS, NAM, NAMADA } from '../config';
import { evaluateFlow } from '../../../shared/alerts';
import { allDeliverable, inQuietHours, thresholdsOf, type StoredSettings } from '../settings';
import { SITE } from '../../../shared/site';
import { chainOf } from '../util';
import { kvGetJson, kvSet } from '../db';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * A webhook that accepts the request and never answers must not hold up its caller (the cron's tick, the live
 * stream): every post ends after this long.
 */
export const WEBHOOK_TIMEOUT_MS = 8000;
/**
 * Every post names no one: a mention in text an outsider wrote (a forum post, a proposal, a label, a bridge receiver
 * string) is shown as text, never turned into a notification.
 */
const postWebhook = (url: string, body: Record<string, unknown>) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });

/** Text an outsider wrote, with Discord's masked-link syntax broken ("](" becomes "] ("): no link can hide under other words. */
export const plainMd = (s: string) => s.replace(/\]\(/g, '] (');
/** A value shown inside a code span: a backtick or line break could close the span (an Osmosis bridge receiver is free text). */
const codeSafe = (s: string) => s.replace(/[`\r\n]/g, '');

/** Posts for one move or post run this many at a time (the runtime allows six outgoing connections at once). */
export const POST_CONCURRENCY = 6;
/**
 * Every post for one move starts within this long of the first; the rest are counted as skipped (kv `alerts.skipped`,
 * shown by the cron health view). A slow or hostile set of webhooks can then hold up alerts, never the block scan.
 */
export const FANOUT_DEADLINE_MS = 15_000;
/** A webhook that failed this many times in a row (unreachable, deleted, refused) is left alone for BACKOFF_MS. */
export const BACKOFF_AFTER = 3;
export const BACKOFF_MS = 10 * 60_000;
const failing = new Map<string, { n: number; until: number }>();
function noteResult(url: string, ok: boolean) {
  if (ok) { failing.delete(url); return; }
  const f = failing.get(url) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= BACKOFF_AFTER) f.until = Date.now() + BACKOFF_MS;
  failing.set(url, f);
}

/** kv `alerts.skipped`: posts that were not sent, in all and the last case. */
export interface AlertsSkipped { total: number; last: { what: string; n: number; at: number } }

/** One body to each webhook, a few at a time, within the deadline; what could not start is recorded, never dropped unseen. */
async function postAll(targets: { url: string; body: Record<string, unknown> }[], db: D1Database | undefined, what: string): Promise<{ posted: number; skipped: number }> {
  const started = Date.now();
  const queue = [...targets];
  let posted = 0, skipped = 0;
  const run = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const f = failing.get(t.url);
      if (f && f.until > Date.now()) { skipped++; continue; }
      if (Date.now() - started > FANOUT_DEADLINE_MS) { skipped++; continue; }
      try {
        const res = await postWebhook(t.url, t.body);
        // 429 is Discord asking for a pause, not a dead hook; 401/404 (deleted) and 5xx count against the hook.
        noteResult(t.url, res.ok || res.status === 429);
        if (res.ok) posted++;
      } catch { noteResult(t.url, false); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POST_CONCURRENCY, queue.length) }, run));
  if (skipped) {
    console.error(`alerts: ${skipped} of ${targets.length} posts for ${what} not sent (deadline passed or webhook backed off)`);
    if (db) {
      const cur = (await kvGetJson<AlertsSkipped>(db, 'alerts.skipped').catch(() => null)) ?? { total: 0, last: { what, n: 0, at: 0 } };
      await kvSet(db, 'alerts.skipped', { total: cur.total + skipped, last: { what, n: skipped, at: Date.now() } }).catch(() => {});
    }
  }
  return { posted, skipped };
}

let settingsKey: string | undefined;
/** The dispatcher needs the settings key; the Worker sets it once at startup (index.ts). */
export function configureAlerts(key: string | undefined) { settingsKey = key; }

const NAMADA_AVATAR =
  'https://raw.githubusercontent.com/anoma/namada-chain-registry/main/namada/images/namada.svg';

// In-memory fast-path deduplication cache (protects against simultaneous WS fanout within the same isolate)
const memoryAlertCache = new Set<string>();

function checkMemoryLock(keys: string[]): boolean {
  for (const k of keys) {
    if (memoryAlertCache.has(k)) return false;
  }
  for (const k of keys) {
    memoryAlertCache.add(k);
  }
  if (memoryAlertCache.size > 2000) {
    const first = memoryAlertCache.values().next().value;
    if (first) memoryAlertCache.delete(first);
  }
  return true;
}

/**
 * Atomically claim alert keys in the D1 `kv` table with INSERT OR IGNORE. True when this caller is the first to
 * claim every key, false when any was claimed before (already sent), so offering the same thing again never posts
 * it twice. Fails open: when D1 cannot be written the post goes ahead (a repeat post in another isolate is better
 * than a lost alert), and the memory lock still stops a repeat within this isolate.
 */
export async function claimDiscordAlert(
  db: D1Database | undefined,
  keys: string[],
  now = Date.now(),
): Promise<boolean> {
  if (!checkMemoryLock(keys)) return false;
  if (!db) return true;

  try {
    for (const key of keys) {
      const res = await db
        .prepare('INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)')
        .bind(key, '1', now)
        .run();
      if ((res.meta?.changes ?? 0) === 0) {
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error('claimDiscordAlert error:', err);
    return true;
  }
}

/**
 * Each key claimed on its own, where claimDiscordAlert takes a set together: the keys this caller is the first to
 * claim. Fails open the same way, for the keys D1 has not answered: when a batch cannot be written, its keys and
 * those of the batches after it count as claimed (the memory lock let them through), while a key an earlier batch
 * found claimed stays refused (another record of the same crossing has posted to that channel).
 */
async function claimEach(db: D1Database | undefined, keys: string[], now = Date.now()): Promise<Set<string>> {
  const fresh = keys.filter((k) => checkMemoryLock([k]));
  if (!db || !fresh.length) return new Set(fresh);
  const won = new Set<string>();
  let i = 0;
  try {
    for (; i < fresh.length; i += 80) {
      const part = fresh.slice(i, i + 80);
      const res = await db.batch(part.map((k) => db.prepare('INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').bind(k, '1', now)));
      part.forEach((k, j) => { if (Number(res[j]?.meta?.changes ?? 0) > 0) won.add(k); });
    }
    return won;
  } catch (err) {
    console.error('claimDiscordAlert error:', err);
    for (const k of fresh.slice(i)) won.add(k);
    return won;
  }
}

/**
 * The crossing a NAM bridge record belongs to: the packet both chains record, named by its source channel and its
 * sequence. The sending chain numbers the packets of a channel once each and the receiving chain's record carries
 * the same number, so a crossing's two records (Namada's and Osmosis's) give the same key and any other crossing
 * gives another, however alike its addresses, amount and time; no time window is involved. A crossing to Osmosis
 * leaves on Namada's channel (NAM.namadaChannel), one to Namada on Osmosis's (NAM.osmoChannel), and a record counts
 * only when it names its own end of that pair. Null for a record no packet was bound to (a Namada leg that no packet
 * of its own inner transaction fits) and for a move in another coin: such a record is posted on its own id and pairs
 * with nothing, since a guess could only make it hide a crossing it does not belong to.
 */
export function crossingOf(flow: Flow): string | null {
  if ((flow.kind !== 'ibc_in' && flow.kind !== 'ibc_out') || isOtherCoin(flow)) return null;
  if (flow.meta?.channel !== (flow.chain === 'namada' ? NAM.namadaChannel : NAM.osmoChannel)) return null;
  const seq = flow.meta?.packetSequence;
  if (typeof seq !== 'string' || !/^\d+$/.test(seq)) return null;
  const toOsmosis = (flow.chain === 'osmosis') === (flow.kind === 'ibc_in');
  return `${toOsmosis ? NAM.namadaChannel : NAM.osmoChannel}:${seq}`;
}

/** A channel in a stored key: the webhook URL holds the token that posts to it, so the key keeps a digest, never the URL. */
const channelKey = (url: string) => bytesToHex(sha256(new TextEncoder().encode(url))).slice(0, 32);

/** Settings are read at most once per this long per database (a saved change takes effect within it); decrypted copies live in memory only. */
export const USERS_CACHE_MS = 15_000;
const usersCache = new WeakMap<D1Database, { at: number; users: StoredSettings[] }>();
async function getUsers(db?: D1Database): Promise<StoredSettings[]> {
  if (!db) return [];
  const c = usersCache.get(db);
  if (c && Date.now() - c.at < USERS_CACHE_MS) return c.users;
  try {
    const users = await allDeliverable(db, settingsKey);
    usersCache.set(db, { at: Date.now(), users });
    return users;
  } catch { return []; }
}

/**
 * A NAM move at or above the whale size. A move in another coin (shielded USDC, OSMO…: meta.tokenSymbol) is never
 * one, whatever its size: its amount is in that coin's units, not NAM.
 */
export const isNamWhale = (flow: Flow, whaleNam: number): boolean => !isOtherCoin(flow) && flow.amount >= whaleNam;

/**
 * Whether the live alert pass (live-hub.ts alertFlows) offers a move to sendDiscordWhaleAlert at all. `minNam` is a
 * NAM size, so it reads NAM moves only. A move into or out of the shielded set is always offered, and so is a move
 * in another coin: no NAM size can measure it, and only a watchlist can match it (no rule or whale size is in its
 * coin), so it is offered for the watchers of its addresses whatever its size.
 */
export const offeredForAlerts = (flow: Flow, minNam: number): boolean =>
  isOtherCoin(flow) || flow.kind === 'shield' || flow.kind === 'unshield' || flow.amount >= minNam;

export function buildFlowDiscordBody(flow: Flow, usdPrice: number | null, customTag?: string) {
  // The coin the amount is in: a move in another coin is named by its own symbol (meta.tokenSymbol), never as NAM.
  const assetSymbol = isOtherCoin(flow)
    ? String(flow.meta!.tokenSymbol)
    : flow.chain === 'namada' && flow.counterDenom ? flow.counterDenom : 'NAM';

  const valueStr = flow.valueUsd
    ? `$${flow.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : assetSymbol === 'NAM' && usdPrice
    ? `$${(flow.amount * usdPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    : `${assetSymbol} Asset`;

  const amountStr = `${flow.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${assetSymbol}`;

  const txUrl =
    flow.chain === 'osmosis'
      ? EXPLORERS.osmoTx(flow.txHash)
      : NAMADA.explorerTx(explorerHashOf(flow));

  let title = `${customTag ? `[${customTag}] ` : ''}🐋 Whale Move on ${flow.chain.toUpperCase()}`;
  let color = 0x5865f2;

  const isToOsmosis =
    (flow.chain === 'osmosis' && flow.kind === 'ibc_in') ||
    (flow.chain === 'namada' && flow.kind === 'ibc_out');

  switch (flow.kind) {
    case 'buy':
      title = `${customTag ? `[${customTag}] ` : ''}🟢 BUY on Osmosis: ${amountStr}`;
      color = 0x57f287;
      break;
    case 'sell':
      title = `${customTag ? `[${customTag}] ` : ''}🔴 SELL on Osmosis: ${amountStr}`;
      color = 0xed4245;
      break;
    case 'ibc_in':
    case 'ibc_out':
      title = isToOsmosis
        ? `${customTag ? `[${customTag}] ` : ''}🌉 IBC Bridge Namada → Osmosis: ${amountStr}`
        : `${customTag ? `[${customTag}] ` : ''}🌉 IBC Bridge Osmosis → Namada: ${amountStr}`;
      color = 0xfee75c;
      break;
    case 'shield':
      title = `${customTag ? `[${customTag}] ` : ''}🛡️ MASP Shielded: ${amountStr}`;
      color = 0x9b59b6;
      break;
    case 'unshield':
      title = `${customTag ? `[${customTag}] ` : ''}🔓 MASP Unshielded: ${amountStr}`;
      color = 0xe67e22;
      break;
    case 'bond':
      title = `${customTag ? `[${customTag}] ` : ''}🥩 Staking Bond: ${amountStr}`;
      color = 0x3498db;
      break;
    case 'withdraw':
      title = `${customTag ? `[${customTag}] ` : ''}💸 Staking Withdrawal: ${amountStr}`;
      color = 0xe74c3c;
      break;
    default:
      title = `${customTag ? `[${customTag}] ` : ''}🐋 Flow [${flow.kind.toUpperCase()}]: ${amountStr}`;
  }

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: 'Amount', value: amountStr, inline: true },
    { name: 'Est. Value', value: valueStr, inline: true },
    { name: 'Block Height', value: `#${flow.height.toLocaleString()}`, inline: true },
  ];

  // Addresses and labels are text outsiders chose (a bridge receiver, a wallet's tag): shown, never rendered as markdown.
  const party = (addr: string, label: string | null | undefined) =>
    `\`${codeSafe(addr.slice(0, 14))}...${codeSafe(addr.slice(-6))}\`${label ? ` (${plainMd(codeSafe(label))})` : ''}${chainOf(addr) ? '' : ' (not an address)'}`;
  if (flow.from) fields.push({ name: 'From', value: party(flow.from, flow.fromLabel), inline: true });
  if (flow.to) fields.push({ name: 'To', value: party(flow.to, flow.toLabel), inline: true });
  // Owner decision 14: a move the live stream missed and the catch-up search found later says so, with the time
  // it happened (Discord renders <t:…:f> in each reader's time zone).
  if ((flow.meta as { via?: string } | undefined)?.via === 'catch-up search') {
    fields.push({
      name: 'Found late',
      value: `The live feed missed this move; it happened <t:${Math.floor(flow.ts / 1000)}:f> (<t:${Math.floor(flow.ts / 1000)}:R>).`,
      inline: false,
    });
  }
  if (flow.chain === 'osmosis' && flow.counterDenom && flow.counterAmount) {
    fields.push({
      name: 'Counter Asset',
      value: `${flow.counterAmount.toFixed(2)} ${flow.counterDenom}`,
      inline: true,
    });
  }

  return {
    username: 'Namada Whale Radar',
    avatar_url: NAMADA_AVATAR,
    embeds: [
      {
        title,
        url: txUrl,
        color,
        description: `Tx: [${flow.txHash.slice(0, 16)}...](${txUrl}) on **${flow.chain.toUpperCase()}**`,
        fields,
        footer: {
          text: `NamadaTrade • Deduplicated Cross-Chain Whale Monitor`,
        },
        timestamp: new Date(flow.ts || Date.now()).toISOString(),
      },
    ],
  };
}

export async function sendDiscordWhaleAlert(
  webhookUrl: string | undefined,
  flow: Flow,
  usdPrice: number | null,
  db?: D1Database,
  systemThreshold = 10000,
) {
  const targets: { url: string; body: Record<string, unknown> }[] = [];
  // 1. The operator's channel, for NAM moves at or above the whale size (another coin's units are not NAM).
  if (webhookUrl && isNamWhale(flow, systemThreshold)) targets.push({ url: webhookUrl, body: buildFlowDiscordBody(flow, usdPrice) });

  // 2. Fan out per user: the same rules as the UI and the replay harness, with that user's thresholds (the rules
  //    are in NAM, so a move in another coin can match a watchlist only). One post per webhook, whoever shares it
  //    (the first matching user's tag names it).
  const seen = new Set<string>(webhookUrl ? [webhookUrl] : []);
  for (const u of await getUsers(db)) {
    const url = u.channels.discord.webhookUrl!;
    if (seen.has(url)) continue;
    const p = u.notifications;
    if (inQuietHours(p)) continue;
    const watched = p.watchlistOn && p.watchlist.some((w) => w === flow.from || w === flow.to);
    const hits = evaluateFlow(flow, thresholdsOf(p));
    if (!watched && hits.length === 0) continue;
    seen.add(url);
    targets.push({ url, body: buildFlowDiscordBody(flow, usdPrice, watched ? 'WATCHLIST' : hits[0].ruleId.toUpperCase()) });
  }
  if (!targets.length) return;

  // 3. The claims, taken only for a move that will be posted, so a move that posts nothing holds no key another move
  //    needs. The first names the move itself (its flow id), never only its transaction: one transaction or Namada
  //    batch (whose moves all carry the wrapper hash) can hold several moves of one kind, and each is its own alert.
  //    The id is the move's identity on every path (the stream, the catch-up search and the Namada scan parse one
  //    transaction into the same ids, and `flows` stores rows by it), so one move is still posted once.
  if (!(await claimDiscordAlert(db, [`alert:flow:${flow.id}`], Date.now()))) return;
  //    A NAM bridge crossing is recorded on both chains under two ids, and its two records do not reach the same
  //    channels: the "NAM bridged to Osmosis" rule reads the Osmosis receive only, while the operator and watchers of
  //    either address hear of both. So the crossing (its packet, crossingOf) is claimed per channel: each channel
  //    hears of it once, from whichever record reaches it first, and the channels the first record took never keep
  //    the second record from the channels only it reaches.
  const crossing = crossingOf(flow);
  let send = targets;
  if (crossing) {
    const key = (url: string) => `alert:ibc:${crossing}:${channelKey(url)}`;
    const won = await claimEach(db, targets.map((t) => key(t.url)), Date.now());
    send = targets.filter((t) => won.has(key(t.url)));
  }
  if (send.length) await postAll(send, db, `move ${flow.id}`);
}

/**
 * Send a deduplicated Discord notification for new Namada Forum topics or replies
 */
export async function sendDiscordForumAlert(
  webhookUrl: string | undefined,
  post: ForumPost,
  db?: D1Database,
) {
  const allowed = await claimDiscordAlert(db, [`alert:forum:post:${post.id}`], Date.now());
  if (!allowed) return;

  const isNewTopic = post.isNewTopic || post.postNumber === 1;
  // Forum text is whatever its author wrote: shown as text (plainMd), so a reply cannot hide a link under other words.
  const title = isNewTopic
    ? `🏛️ New Namada Forum Topic: ${plainMd(post.topicTitle)}`
    : `💬 New Forum Reply: ${plainMd(post.topicTitle)} (#${post.postNumber})`;

  const authorDisplay = post.displayName
    ? `${plainMd(post.displayName)} (@${plainMd(post.username)})`
    : `@${plainMd(post.username)}`;

  const body = {
    username: 'Namada Forum & Governance Radar',
    avatar_url: NAMADA_AVATAR,
    embeds: [
      {
        title: title.slice(0, 250),
        url: post.url,
        color: isNewTopic ? 0xffff00 : 0x38bdf8,
        description: post.excerpt
          ? `> ${plainMd(post.excerpt)}\n\n[Read full post on forum.namada.net ↗](${post.url})`
          : `[View discussion on forum.namada.net ↗](${post.url})`,
        fields: [
          { name: 'Author', value: authorDisplay, inline: true },
          {
            name: 'Activity Type',
            value: isNewTopic ? 'New Thread (OP)' : `Reply #${post.postNumber}`,
            inline: true,
          },
          { name: 'Topic ID', value: `#${post.topicId}`, inline: true },
        ],
        footer: {
          text: 'NamadaTrade • Namada Discourse Forum Monitor',
        },
        timestamp: new Date(post.createdAt || Date.now()).toISOString(),
      },
    ],
  };

  const targets = new Set<string>();
  if (webhookUrl) targets.add(webhookUrl);
  for (const u of await getUsers(db)) {
    if (u.notifications.forumAndGov && !inQuietHours(u.notifications)) targets.add(u.channels.discord.webhookUrl!);
  }
  await postAll([...targets].map((url) => ({ url, body })), db, `forum post ${post.id}`);
}

/**
 * Send a deduplicated Discord notification for Namada On-Chain Governance Proposals
 */
export async function sendDiscordGovAlert(
  webhookUrl: string | undefined,
  prop: GovernanceProposal,
  isNew: boolean,
  db?: D1Database,
) {
  const allowed = await claimDiscordAlert(
    db,
    [`alert:gov:prop:${prop.id}:${prop.status}`],
    Date.now(),
  );
  if (!allowed) return;

  // Proposal text is whatever its author submitted on chain: shown as text (plainMd).
  const title = isNew
    ? `🗳️ New On-Chain Proposal #${prop.id}: ${plainMd(prop.title)}`
    : `⚖️ Proposal #${prop.id} Status → ${prop.status.toUpperCase()}: ${plainMd(prop.title)}`;

  const color =
    prop.status.toLowerCase().includes('pass')
      ? 0x10b981
      : prop.status.toLowerCase().includes('reject')
      ? 0xf43f5e
      : 0xa855f7;

  const propUrl =
    safeHttpUrl(prop.discussionsUrl) || `https://namada.valopers.com/proposals/${prop.id}`;

  const body = {
    username: 'Namada Forum & Governance Radar',
    avatar_url: NAMADA_AVATAR,
    embeds: [
      {
        title: title.slice(0, 250),
        url: propUrl,
        color,
        description: prop.abstract
          ? `${plainMd(prop.abstract)}\n\n[View Discussion / Proposal ↗](${propUrl})`
          : `[View Proposal #${prop.id} ↗](${propUrl})`,
        fields: [
          { name: 'Status', value: `\`${prop.status}\``, inline: true },
          { name: 'Type', value: `\`${prop.type}\``, inline: true },
          {
            name: 'Voting Window',
            value: `Epoch ${prop.startEpoch} → ${prop.endEpoch}`,
            inline: true,
          },
          {
            name: 'YAY Votes',
            value: `${Math.round(prop.yayNam).toLocaleString()} NAM`,
            inline: true,
          },
          {
            name: 'NAY Votes',
            value: `${Math.round(prop.nayNam).toLocaleString()} NAM`,
            inline: true,
          },
          {
            name: 'ABSTAIN',
            value: `${Math.round(prop.abstainNam).toLocaleString()} NAM`,
            inline: true,
          },
        ],
        footer: {
          text: 'NamadaTrade • On-Chain Governance Monitor',
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const targets = new Set<string>();
  if (webhookUrl) targets.add(webhookUrl);
  for (const u of await getUsers(db)) {
    if (u.notifications.forumAndGov && !inQuietHours(u.notifications)) targets.add(u.channels.discord.webhookUrl!);
  }
  await postAll([...targets].map((url) => ({ url, body })), db, `proposal ${prop.id} ${prop.status}`);
}

/**
 * Send a test Discord webhook message to verify user's webhook configuration
 */
export async function sendDiscordTestAlert(webhookUrl: string, u: StoredSettings): Promise<boolean> {
  const p = u.notifications;
  const on = Object.entries(p.rules).filter(([, r]) => r.on).map(([id, r]) => `${id} ≥ ${r.thresholdNam.toLocaleString()} NAM`);
  const body = {
    username: 'NamadaTrade',
    avatar_url: NAMADA_AVATAR,
    embeds: [
      {
        title: 'Discord channel connected',
        url: `${SITE.origin}/settings`,
        color: 0xffff00,
        description: `Alerts for \`${u.address.slice(0, 12)}…${u.address.slice(-6)}\` will arrive here.`,
        fields: [
          { name: 'Rules on', value: on.length ? on.join('\n') : 'none', inline: false },
          { name: 'Watchlist', value: p.watchlistOn && p.watchlist.length ? `${p.watchlist.length} address(es)` : 'off', inline: true },
          { name: 'Forum & governance', value: p.forumAndGov ? 'on' : 'off', inline: true },
          { name: 'Quiet hours (UTC)', value: p.quietHoursUtc ? `${p.quietHoursUtc.start}:00–${p.quietHoursUtc.end}:00` : 'none', inline: true },
        ],
        footer: { text: 'NamadaTrade · change these in Settings' },
        timestamp: new Date().toISOString(),
      },
    ],
  };
  const res = await postWebhook(webhookUrl, body);
  return res.ok;
}
