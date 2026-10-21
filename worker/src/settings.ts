// Per-user settings, encrypted at rest.
//
// What the operator can and cannot see: everything a user saves (watchlist, thresholds, Discord webhook)
// is stored as one AES-256-GCM blob under `kv` key `user:<address>`, keyed by the SETTINGS_KEY secret.
// D1 exports and backups therefore contain ciphertext only. The API never returns the webhook URL,
// only a mask and whether one is set. The decrypted settings exist in memory only while an alert
// is being dispatched. (An operator who changes this code can of course read anything; that is true of
// every hosted service and is said plainly in the Privacy section of the UI.)
import { base64 } from '@scure/base';
import type { AlertRuleId, NotificationPrefs, UserSettings } from '../../shared/types';
import { DEFAULT_THRESHOLDS, type AlertThresholds } from '../../shared/alerts';
import { kvGetJson, kvSet } from './db';

export interface StoredSettings {
  address: string;
  notifications: NotificationPrefs;
  channels: { discord: { enabled: boolean; webhookUrl: string | null } };
  createdAt: number;
  updatedAt: number;
}

const RULE_IDS: AlertRuleId[] = ['ibc_inventory', 'unlock', 'big_swap', 'unshield', 'bond'];
const KEY_OF: Record<AlertRuleId, keyof AlertThresholds> = { ibc_inventory: 'ibcInventory', unlock: 'unlock', big_swap: 'bigSwap', unshield: 'unshield', bond: 'bond' };

export function defaultPrefs(): NotificationPrefs {
  return {
    rules: Object.fromEntries(RULE_IDS.map((id) => [id, { on: true, thresholdNam: DEFAULT_THRESHOLDS[KEY_OF[id]] }])) as NotificationPrefs['rules'],
    watchlist: [],
    watchlistOn: true,
    forumAndGov: false,
    quietHoursUtc: null,
  };
}

export function thresholdsOf(p: NotificationPrefs): AlertThresholds {
  const th = { ...DEFAULT_THRESHOLDS };
  for (const id of RULE_IDS) {
    const r = p.rules[id];
    // A disabled rule gets an unreachable threshold so evaluateFlow never fires it.
    th[KEY_OF[id]] = r?.on ? Math.max(1, Number(r.thresholdNam) || DEFAULT_THRESHOLDS[KEY_OF[id]]) : Number.MAX_SAFE_INTEGER;
  }
  return th;
}

export function inQuietHours(p: NotificationPrefs, now = Date.now()): boolean {
  const q = p.quietHoursUtc;
  if (!q) return false;
  const h = new Date(now).getUTCHours();
  return q.start <= q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end;
}

// ---------------------------------------------------------------- crypto

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = base64.decode(secret.trim());
  if (raw.length !== 32) throw new Error('SETTINGS_KEY must be 32 bytes, base64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function seal(secret: string, obj: unknown): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  return `v1.${base64.encode(iv)}.${base64.encode(ct)}`;
}

async function open(secret: string, blob: string): Promise<any> {
  const [v, ivB, ctB] = blob.split('.');
  if (v !== 'v1') throw new Error('unknown settings format');
  const key = await aesKey(secret);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64.decode(ivB) }, key, base64.decode(ctB));
  return JSON.parse(new TextDecoder().decode(pt));
}

// ---------------------------------------------------------------- storage

export function requireKey(env: { SETTINGS_KEY?: string }): string {
  if (!env.SETTINGS_KEY) throw new Error('SETTINGS_KEY is not configured; run `wrangler secret put SETTINGS_KEY`');
  return env.SETTINGS_KEY;
}

export async function loadSettings(db: D1Database, secret: string, address: string): Promise<StoredSettings | null> {
  const blob = await kvGetJson<{ blob: string }>(db, `user:${address}`);
  // The plaintext alert settings from before sign-in existed (`webhook:user:<address>`) are not read: nothing
  // proves a row there belongs to whoever signs in as the address, and its webhook URL never passed applyUpdate's
  // check. None existed in production on 2026-10-21; sweepAuth deletes any a restore brings back.
  return blob?.blob ? ((await open(secret, blob.blob)) as StoredSettings) : null;
}

export async function saveSettings(db: D1Database, secret: string, s: StoredSettings): Promise<void> {
  await kvSet(db, `user:${s.address}`, { blob: await seal(secret, s), updatedAt: s.updatedAt });
}

export async function deleteSettings(db: D1Database, address: string): Promise<void> {
  await db.prepare('DELETE FROM kv WHERE key = ? OR key = ?').bind(`user:${address}`, `webhook:user:${address}`).run();
}

/** Users read per dispatch at most (the cap is logged when reached). */
export const DELIVERABLE_MAX = 500;
/** Decrypted settings of every user with an enabled Discord channel — used only by the dispatcher. */
export async function allDeliverable(db: D1Database, secret: string | undefined): Promise<StoredSettings[]> {
  if (!secret) return [];
  // A key range the primary key answers (a LIKE prefix would scan the whole table), newest settings first.
  const rows = await db.prepare(`SELECT value FROM kv WHERE key >= 'user:' AND key < 'user;' ORDER BY updated_at DESC LIMIT ${DELIVERABLE_MAX}`).all<{ value: string }>().catch(() => ({ results: [] as { value: string }[] }));
  if ((rows.results || []).length >= DELIVERABLE_MAX) console.warn(`allDeliverable: ${DELIVERABLE_MAX} user rows read; users beyond that are not served`);
  const out: StoredSettings[] = [];
  for (const r of rows.results || []) {
    try {
      const { blob } = JSON.parse(r.value);
      const s = (await open(secret, blob)) as StoredSettings;
      if (s.channels.discord.enabled && s.channels.discord.webhookUrl) out.push(s);
    } catch {}
  }
  return out;
}

/** Public view: no secrets. */
export function publicView(s: StoredSettings): UserSettings {
  const url = s.channels.discord.webhookUrl;
  return {
    address: s.address,
    notifications: s.notifications,
    channels: { discord: { enabled: s.channels.discord.enabled, hasUrl: !!url, webhookUrlMasked: url ? `${url.slice(0, 38)}••••${url.slice(-4)}` : null } },
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Validate and merge a client update onto stored settings. Secrets only change when explicitly sent. */
export function applyUpdate(cur: StoredSettings, body: any): StoredSettings | string {
  const n = structuredClone(cur);
  const np = body.notifications;
  if (np) {
    if (np.rules) for (const id of RULE_IDS) {
      const r = np.rules[id];
      if (r) n.notifications.rules[id] = { on: !!r.on, thresholdNam: Math.min(1e12, Math.max(1, Number(r.thresholdNam) || n.notifications.rules[id].thresholdNam)) };
    }
    if (Array.isArray(np.watchlist)) {
      const list = [...new Set(np.watchlist.map((a: any) => String(a).trim()).filter((a: string) => /^(tnam1|osmo1)[0-9a-z]{20,80}$/.test(a)))].slice(0, 100);
      n.notifications.watchlist = list as string[];
    }
    if (typeof np.watchlistOn === 'boolean') n.notifications.watchlistOn = np.watchlistOn;
    if (typeof np.forumAndGov === 'boolean') n.notifications.forumAndGov = np.forumAndGov;
    if (np.quietHoursUtc === null) n.notifications.quietHoursUtc = null;
    else if (np.quietHoursUtc && Number.isInteger(np.quietHoursUtc.start) && Number.isInteger(np.quietHoursUtc.end)) {
      const { start, end } = np.quietHoursUtc;
      if (start < 0 || start > 23 || end < 0 || end > 24) return 'quiet hours must be 0–23 / 0–24 UTC';
      n.notifications.quietHoursUtc = { start, end };
    }
  }
  const d = body.channels?.discord;
  if (d) {
    if (typeof d.enabled === 'boolean') n.channels.discord.enabled = d.enabled;
    if (typeof d.webhookUrl === 'string') {
      const u = d.webhookUrl.trim();
      if (u === '') n.channels.discord.webhookUrl = null;
      else if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(u)) return 'that is not a Discord webhook URL';
      else n.channels.discord.webhookUrl = u;
    }
    if (!n.channels.discord.webhookUrl) n.channels.discord.enabled = false;
  }
  n.updatedAt = Date.now();
  return n;
}
