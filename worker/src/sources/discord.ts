import { explorerHashOf } from '../../../shared/flow-rules';
import type { Flow, ForumPost, GovernanceProposal } from '../../../shared/types';
import { safeHttpUrl } from '../../../shared/flow-rules';
import { EXPLORERS, NAMADA } from '../config';
import { evaluateFlow } from '../../../shared/alerts';
import { allDeliverable, inQuietHours, thresholdsOf, type StoredSettings } from '../settings';
import { SITE } from '../../../shared/site';

/**
 * A webhook that accepts the request and never answers must not hold up its caller (the cron's tick, the live
 * stream): every post ends after this long.
 */
export const WEBHOOK_TIMEOUT_MS = 8000;
const postWebhook = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });

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
 * Atomically claim an alert key in D1 `kv` table using INSERT OR IGNORE.
 * Returns true if this caller is the FIRST to claim the alert key, false if already sent.
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

async function getUsers(db?: D1Database): Promise<StoredSettings[]> {
  if (!db) return [];
  try { return await allDeliverable(db, settingsKey); } catch { return []; }
}

export function buildFlowDiscordBody(flow: Flow, usdPrice: number | null, customTag?: string) {
  const assetSymbol =
    flow.chain === 'namada' && flow.counterDenom ? flow.counterDenom : 'NAM';

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

  if (flow.from) {
    const fromLabel = flow.fromLabel ? ` (${flow.fromLabel})` : '';
    fields.push({
      name: 'From',
      value: `\`${flow.from.slice(0, 14)}...${flow.from.slice(-6)}\`${fromLabel}`,
      inline: true,
    });
  }
  if (flow.to) {
    const toLabel = flow.toLabel ? ` (${flow.toLabel})` : '';
    fields.push({
      name: 'To',
      value: `\`${flow.to.slice(0, 14)}...${flow.to.slice(-6)}\`${toLabel}`,
      inline: true,
    });
  }
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
  const dedupKeys = [
    `alert:flow:${flow.id}`,
    `alert:tx:${flow.chain}:${flow.txHash}:${flow.kind}`,
  ];

  if ((flow.kind === 'ibc_in' || flow.kind === 'ibc_out') && flow.from && flow.to) {
    const bucket10m = Math.floor((flow.ts || Date.now()) / 600000);
    dedupKeys.push(
      `alert:ibc:${flow.from}:${flow.to}:${Math.round(flow.amount)}:${bucket10m}`,
    );
  }

  const allowed = await claimDiscordAlert(db, dedupKeys, Date.now());
  if (!allowed) {
    return;
  }

  // 1. Dispatch to main system webhook if >= systemThreshold
  if (webhookUrl && flow.amount >= systemThreshold) {
    try {
      const body = buildFlowDiscordBody(flow, usdPrice);
      await postWebhook(webhookUrl, body);
    } catch (err) {
      console.error('Failed to dispatch Discord whale webhook:', err);
    }
  }

  // 2. Fan out per user: the same rules as the UI and the replay harness, with that user's thresholds.
  const users = await getUsers(db);
  for (const u of users) {
    const url = u.channels.discord.webhookUrl!;
    if (url === webhookUrl) continue;
    const p = u.notifications;
    if (inQuietHours(p)) continue;
    const watched = p.watchlistOn && p.watchlist.some((w) => w === flow.from || w === flow.to);
    const hits = evaluateFlow(flow, thresholdsOf(p));
    if (!watched && hits.length === 0) continue;
    const tag = watched ? 'WATCHLIST' : hits[0].ruleId.toUpperCase();
    try {
      await postWebhook(url, buildFlowDiscordBody(flow, usdPrice, tag));
    } catch {}
  }
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
  const title = isNewTopic
    ? `🏛️ New Namada Forum Topic: ${post.topicTitle}`
    : `💬 New Forum Reply: ${post.topicTitle} (#${post.postNumber})`;

  const authorDisplay = post.displayName
    ? `${post.displayName} (@${post.username})`
    : `@${post.username}`;

  const body = {
    username: 'Namada Forum & Governance Radar',
    avatar_url: NAMADA_AVATAR,
    embeds: [
      {
        title: title.slice(0, 250),
        url: post.url,
        color: isNewTopic ? 0xffff00 : 0x38bdf8,
        description: post.excerpt
          ? `> ${post.excerpt}\n\n[Read full post on forum.namada.net ↗](${post.url})`
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

  for (const url of targets) {
    try {
      await postWebhook(url, body);
    } catch (err) {
      console.error('Failed to dispatch Discord forum webhook:', err);
    }
  }
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

  const title = isNew
    ? `🗳️ New On-Chain Proposal #${prop.id}: ${prop.title}`
    : `⚖️ Proposal #${prop.id} Status → ${prop.status.toUpperCase()}: ${prop.title}`;

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
          ? `${prop.abstract}\n\n[View Discussion / Proposal ↗](${propUrl})`
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

  for (const url of targets) {
    try {
      await postWebhook(url, body);
    } catch (err) {
      console.error('Failed to dispatch Discord governance webhook:', err);
    }
  }
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
