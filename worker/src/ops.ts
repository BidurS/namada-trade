// The operator's incidents (scale plan, Stage 1 item 4): the owner hears of a failure while it lasts, not only in the
// 08:00 UTC digest. After each cron tick (cron.ts runCron, under the tick's lock, so two passes never run at once) the
// stored health rows (kv source.health) and the checks table are judged once: a name that is not ok on
// INCIDENT_OPEN_TICKS ticks in a row opens an incident, which is told to the operator once; while incidents stay open,
// one reminder at most every OPS_REMIND_MS lists them; one that is ok again on INCIDENT_RESOLVE_TICKS ticks in a row is
// resolved, and that is told once. A name judged ok on one tick between bad ones starts its count again, so a check
// that flips every few minutes (osmosis_index flipped 124 times in 9.6 h on 2026-10-29) opens nothing. Its bad state
// must also have been read afresh on INCIDENT_OPEN_READS of those ticks (the row's time or words changed): a source
// probed every 10 minutes (the Osmosis holder list) keeps one failed read on the sheet for ten ticks, and one failed
// read is not an outage; two in a row are.
//
// A cron that has stopped completing ticks cannot say so itself, so the live hub's alarm looks at the last completed
// tick at most once a minute (watchCronStall, live-hub.ts) and opens that incident once it is older than
// CRON_STALE_MS; the hub writes it to kv ops.cron_stall only, and the first tick after the gap takes it over and
// resolves it like any other. A gap the hub did not see (the hub down too) is opened by that first tick, so a gap is
// never left untold.
//
// Where it goes: the operator's own Discord channel (DISCORD_WEBHOOK_URL), through the operator's part of the alerts'
// own path (sources/discord.ts sendDiscordOperator: never cut, a short Retry-After waited out, a hook in its backoff
// skipped), and, when the secret TELEGRAM_OWNER_CHAT is set, that Telegram chat through the site's bot
// (sources/telegram.ts sendTelegramOwner). Only a Worker that sends alerts (SEND_ALERTS) posts, and kv ops.alerts.on
// set to '0' stops every post: the incidents are still kept, and the ones open are told when the switch is removed.
// A message that reached no channel is tried again on the next tick. Each line is the site's own words: the name,
// since when, and the health row's note (util.ts publicNote: never an upstream's answer or a URL) or the check's
// status and title; never a post, a label or anything else someone outside wrote. Nothing about any visitor is read.
import type { SourceHealth } from '../../shared/types';
import { fmtAge, fmtUtcLong } from '../../shared/format';
import { kvSet } from './db';
import { publicNote } from './util';
import { checkStaleMs } from './digest/freshness';
import { cutText, sendDiscordOperator, sendsAlerts, textSafe, SENDER } from './sources/discord';
import { sendTelegramOwner } from './sources/telegram';

/** kv key of the incidents' state (OpsState), written by the cron's tick only. */
export const OPS_KV = 'ops.incidents';
/** kv key of the stalled-cron incident the live hub opened (CronStall), removed by the tick that takes it over. */
export const OPS_STALL_KV = 'ops.cron_stall';
/** kv key of the kill switch: '0' stops every post of this module; anything else, or no row, leaves them on. */
export const OPS_SWITCH_KV = 'ops.alerts.on';
/** Ticks in a row a name must be not ok before its incident opens. */
export const INCIDENT_OPEN_TICKS = 10;
/** Of those ticks, how many must have read the bad state afresh (a new time or new words on its row) before it opens. */
export const INCIDENT_OPEN_READS = 2;
/** Ticks in a row an open incident's name must be ok again before it is resolved. */
export const INCIDENT_RESOLVE_TICKS = 3;
/** At most one reminder of the open incidents in this long (an open message counts as one). */
export const OPS_REMIND_MS = 60 * 60_000;
/** A cron whose last completed tick is older than this has stopped: the hub opens the incident. */
export const CRON_STALE_MS = 10 * 60_000;
/** The hub looks at the last completed tick at most this often (one kv read). */
export const OPS_STALL_LOOK_MS = 60_000;
/** A resolve that reached no channel is tried again on later ticks for this long, then let go. */
export const OPS_CLOSING_KEEP_MS = 24 * 3600_000;
/** /api/health answers 503 when the last completed tick is older than this. */
export const HEALTH_TICK_MAX_AGE_MS = 5 * 60_000;
/** The incident of the cron's own ticks (the hub's, or a gap the first tick after it saw). */
export const CRON_TICKS = 'Cron ticks';
/** A health row's note or a check's title is cut to this many characters in a line. */
export const OPS_WORDS_MAX = 160;
/** One message's text is at most this long (Discord's content takes 2,000 characters; Telegram 4,096). */
export const OPS_TEXT_MAX = 1900;

/**
 * A name not ok on the last ticks, not yet an incident: its first bad tick, how many in a row (`bad`), on how many of
 * them its bad state was read afresh (`reads`, `seen` the last reading's mark), and what is wrong now.
 */
export interface OpsWatch { since: number; bad: number; reads: number; seen: string; what: string; words: string }
/** What is wrong with a name at one tick (judge): its words, and the mark of the reading (`seen`: its row's time and words). */
export interface OpsBad { what: string; words: string; seen: string }
/**
 * An incident: its name, the first bad tick of the run that opened it (`since`), when it opened, what is wrong as last
 * judged (`what`, `words`), the good ticks in a row since its last bad one (`good`, the first of them `okSince`), and
 * whether its open message reached a channel (`told`). `resolvedAt`: set once it is resolved (OpsState.closing).
 */
export interface OpsIncident {
  name: string; since: number; openedAt: number; what: string; words: string;
  good: number; okSince?: number; told: boolean; resolvedAt?: number;
}
/**
 * kv ops.incidents. `lastTickAt`: when the last tick that completed (its ops pass) ended. `watch`: names not ok, not
 * yet open. `open`: the incidents. `closing`: incidents resolved after their open was told, whose resolve has not
 * reached a channel yet. `remindedAt`: the last message that listed open incidents. `stallSince`: the gap of the last
 * stalled-cron incident taken over (CronStall.since), so one gap is opened once.
 */
export interface OpsState {
  v: 1;
  lastTickAt: number | null;
  watch: Record<string, OpsWatch>;
  open: Record<string, OpsIncident>;
  closing: OpsIncident[];
  remindedAt: number | null;
  stallSince?: number | null;
}
/** kv ops.cron_stall: the hub's incident of a cron with no completed tick since `since`, opened at `openedAt`. */
export interface CronStall { since: number; openedAt: number; toldAt: number | null; remindedAt: number | null }
/** A check's row as the judging reads it. */
export interface OpsCheckRow { key: string; status: string; title: string; checked_at: number; every_ms?: number | null }
/** What this module reads of the Worker's environment. */
export interface OpsEnv { DB: D1Database; SEND_ALERTS?: string; DISCORD_WEBHOOK_URL?: string; TELEGRAM_BOT_TOKEN?: string; TELEGRAM_OWNER_CHAT?: string }

export const emptyOps = (): OpsState => ({ v: 1, lastTickAt: null, watch: {}, open: {}, closing: [], remindedAt: null, stallSince: null });

/** A stored state as this module reads it: anything that is not one is no state (the next tick starts a new one). */
export function opsOf(v: unknown): OpsState | null {
  const s = v as OpsState | null;
  if (!s || typeof s !== 'object' || s.v !== 1 || typeof s.watch !== 'object' || typeof s.open !== 'object' || !Array.isArray(s.closing)) return null;
  return s;
}
const parsed = (raw: string | null | undefined): unknown => {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
};
const stallOf = (v: unknown): CronStall | null => {
  const s = v as CronStall | null;
  return s && typeof s === 'object' && Number.isFinite(s.since) && Number.isFinite(s.openedAt) ? s : null;
};
/** Whether the kill switch is off ('0', or the JSON of it). */
export const switchedOff = (raw: string | null | undefined): boolean => raw != null && String(raw).replace(/"/g, '').trim() === '0';
/** Whether this Worker posts the incidents now: it sends alerts, the switch is not off, and a channel is set. */
export const opsSending = (env: OpsEnv, switchRaw: string | null | undefined): boolean =>
  sendsAlerts(env) && !switchedOff(switchRaw) && (!!env.DISCORD_WEBHOOK_URL || (!!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_OWNER_CHAT));

// ---------------------------------------------------------------- judging one tick

/** A check's incident name, as the health log names its changes (cron.ts checkFlips). */
export const checkName = (key: string) => `check:${key}`;
/** A note or a title on one line (a no-break space kept, as the times write it), safe to publish, cut to OPS_WORDS_MAX. */
const words = (s: string | null | undefined) => cutText(publicNote(String(s ?? '')).replace(/[ \t\r\n\v\f]+/g, ' ').trim(), OPS_WORDS_MAX);

/**
 * What is wrong with each name not ok at this tick: a health row not ok (its note), a check neither ok nor idle (its
 * status and title), and a check whose last run is older than its window (checkStaleMs: "no recent result", as the
 * Status page says). The cron's own row is written only by a tick that failed and stays until a skipped one replaces
 * it, so it counts only when this tick (`tickAt`) wrote it.
 */
export function judge(health: Record<string, SourceHealth>, checks: OpsCheckRow[], tickAt: number, now: number): Map<string, OpsBad> {
  const out = new Map<string, OpsBad>();
  for (const [name, h] of Object.entries(health)) {
    if (!h || h.ok) continue;
    if (name === 'cron' && !(Number(h.at) >= tickAt)) continue;
    out.set(name, { what: 'not ok', words: words(h.note), seen: `${h.at}|${h.note ?? ''}` });
  }
  for (const c of checks) {
    const stale = now - Number(c.checked_at) > checkStaleMs(c.every_ms);
    // a check gone quiet is read afresh on every tick: the time since its last run is what is wrong
    if (stale) out.set(checkName(c.key), { what: 'with no recent result', words: words(`last run ${fmtUtcLong(Number(c.checked_at))}; ${c.title}`), seen: `quiet|${tickAt}` });
    else if (c.status !== 'ok' && c.status !== 'idle') out.set(checkName(c.key), { what: words(c.status), words: words(c.title), seen: `${c.checked_at}|${c.status}` });
  }
  return out;
}

/**
 * One tick of the incidents: `bad` (judge) against the state before it. A name bad on INCIDENT_OPEN_TICKS ticks in a
 * row, read afresh on INCIDENT_OPEN_READS of them, opens, untold; a name of the watch that is ok leaves it; an open
 * incident ok on INCIDENT_RESOLVE_TICKS ticks in a row is resolved, kept in `closing` only when its open was told. A
 * resolve not told within OPS_CLOSING_KEEP_MS is let go. The state is a new object; `prev` is not changed.
 */
export function stepIncidents(prev: OpsState | null, bad: Map<string, OpsBad>, now: number): OpsState {
  const s: OpsState = prev ? structuredClone(prev) : emptyOps();
  for (const [name, b] of bad) {
    const inc = s.open[name];
    if (inc) { inc.good = 0; delete inc.okSince; inc.what = b.what; inc.words = b.words; continue; }
    const w = s.watch[name] ?? { since: now, bad: 0, reads: 0, seen: '', what: b.what, words: b.words };
    w.bad++;
    if (b.seen !== w.seen) { w.reads = (w.reads ?? 0) + 1; w.seen = b.seen; }
    w.what = b.what;
    w.words = b.words;
    if (w.bad >= INCIDENT_OPEN_TICKS && w.reads >= INCIDENT_OPEN_READS) {
      s.open[name] = { name, since: w.since, openedAt: now, what: b.what, words: b.words, good: 0, told: false };
      delete s.watch[name];
    } else s.watch[name] = w;
  }
  for (const name of Object.keys(s.watch)) if (!bad.has(name)) delete s.watch[name];
  for (const [name, inc] of Object.entries(s.open)) {
    if (bad.has(name)) continue;
    inc.good++;
    if (inc.good === 1) inc.okSince = now;
    if (inc.good >= INCIDENT_RESOLVE_TICKS) {
      delete s.open[name];
      if (inc.told) s.closing.push({ ...inc, resolvedAt: now });
    }
  }
  s.closing = s.closing.filter((c) => now - (c.resolvedAt ?? now) < OPS_CLOSING_KEEP_MS);
  s.lastTickAt = now;
  return s;
}

// ---------------------------------------------------------------- the messages

const when = (ms: number) => fmtUtcLong(ms);
const lasting = (ms: number) => { const a = fmtAge(ms); return a === 'now' ? 'under a minute' : a === '—' ? 'an unknown time' : a; };
/** A name as a line says it: a check by its key. */
const label = (name: string) => (name.startsWith('check:') ? `check ${name.slice(6)}` : name);
const tail = (w: string) => (w ? `: ${w.replace(/\.+$/, '')}` : '');

/** The line of an incident opened: what is wrong, since its first bad tick, and its words. */
export const openLine = (i: OpsIncident, now: number): string => i.name === CRON_TICKS
  ? `Opened: ${CRON_TICKS}: ${i.words.replace(/\.+$/, '')}.`
  : `Opened: ${label(i.name)}: ${i.what} since ${when(i.since)} (${lasting(now - i.since)}, at least ${INCIDENT_OPEN_TICKS} ticks in a row)${tail(i.words)}.`;
/** The line of an incident resolved: since when it is ok, and what it was for how long. */
export const resolveLine = (i: OpsIncident): string => {
  const ok = i.okSince ?? i.resolvedAt ?? i.since;
  return `Resolved: ${label(i.name)}: ok again since ${when(ok)} (${INCIDENT_RESOLVE_TICKS} ticks in a row); ${i.name === CRON_TICKS ? 'no tick completed' : i.what} from ${when(i.since)}, for ${lasting(ok - i.since)}.`;
};
/** The reminder's line of an incident still open. */
export const stillLine = (i: OpsIncident, now: number): string =>
  `Still open: ${label(i.name)}: ${i.what} since ${when(i.since)} (${lasting(now - i.since)})${tail(i.words)}.`;

/** The lines as one message's text: as many whole lines as fit in `max`, then how many more there are. */
export function fitLines(lines: string[], max = OPS_TEXT_MAX): string {
  const out: string[] = [];
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const more = lines.length - i - 1;
    const room = max - n - (more ? 40 : 0);
    if (lines[i].length + 1 > room) {
      out.push(`And ${lines.length - i} more (the Sources sheet lists them).`);
      break;
    }
    out.push(lines[i]);
    n += lines[i].length + 1;
  }
  return out.join('\n');
}

/**
 * The lines to the operator's channels: Discord (each line as text, never markdown or a mention) and the owner's
 * Telegram chat when set. True when either took it; a channel not set, or failing, costs nothing to the other.
 */
export async function tellOperator(env: OpsEnv, lines: string[], what: string): Promise<boolean> {
  if (!lines.length) return true;
  const [d, t] = await Promise.all([
    env.DISCORD_WEBHOOK_URL
      ? sendDiscordOperator(env.DISCORD_WEBHOOK_URL, { ...SENDER, content: fitLines(lines.map(textSafe)) }, env.DB, what).catch((e) => { console.error('ops: Discord', e); return false; })
      : Promise.resolve(false),
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OWNER_CHAT
      ? sendTelegramOwner(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_OWNER_CHAT.trim(), fitLines(lines)).catch((e) => { console.error('ops: Telegram', e); return false; })
      : Promise.resolve(false),
  ]);
  return d || t;
}

/**
 * What this tick tells, as one message: the incidents opened and not yet told, the resolves not yet told, and, when no
 * message listed the open incidents for OPS_REMIND_MS, the ones still not ok. Pure; `apply` marks what the message
 * carried once it reached a channel.
 */
export function outbox(s: OpsState, now: number): { lines: string[]; apply: (st: OpsState) => void } {
  const opened = Object.values(s.open).filter((i) => !i.told).sort((a, b) => a.since - b.since || a.name.localeCompare(b.name));
  const closing = [...s.closing].sort((a, b) => (a.resolvedAt ?? 0) - (b.resolvedAt ?? 0) || a.name.localeCompare(b.name));
  // an incident ok again on the last ticks is on its way to resolving: no reminder is made of it
  const told = Object.values(s.open).filter((i) => i.told && i.good === 0).sort((a, b) => a.since - b.since || a.name.localeCompare(b.name));
  const remind = told.length > 0 && (s.remindedAt == null || now - s.remindedAt >= OPS_REMIND_MS);
  const lines = [...opened.map((i) => openLine(i, now)), ...closing.map(resolveLine), ...(remind ? told.map((i) => stillLine(i, now)) : [])];
  const names = new Set(opened.map((i) => i.name));
  return {
    lines,
    apply: (st) => {
      for (const n of names) if (st.open[n]) st.open[n].told = true;
      st.closing = st.closing.filter((c) => !closing.includes(c));
      if (opened.length || remind) st.remindedAt = now;
    },
  };
}

// ---------------------------------------------------------------- the tick's pass

/** The reads of one pass, in one D1 call: the state, the hub's stall, the switch and the health map; and the checks. */
const READ_KV = `SELECT key, value FROM kv WHERE key IN ('${OPS_KV}', '${OPS_STALL_KV}', '${OPS_SWITCH_KV}', 'source.health')`;
const READ_CHECKS = `SELECT key, status, title, checked_at, CASE WHEN json_valid(detail) THEN json_extract(detail, '$.everyMs') END every_ms FROM checks`;

/**
 * The cron's pass, once a tick, after the tick's health rows and checks are written (`tickAt`: the tick's start). It
 * reads the state, the hub's stall, the switch, the health map and the checks (two statements, one batch), takes over
 * a stall (or a gap since the last completed tick longer than CRON_STALE_MS), judges the tick, tells what is due when
 * this Worker posts, and writes the state. A read that fails changes nothing: the next tick judges again.
 */
export async function runOps(env: OpsEnv, tickAt: number, now = Date.now()): Promise<OpsState | null> {
  let kv: Map<string, string>, checks: OpsCheckRow[];
  try {
    const [a, b] = await env.DB.batch([env.DB.prepare(READ_KV), env.DB.prepare(READ_CHECKS)]);
    kv = new Map(((a.results ?? []) as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    checks = (b.results ?? []) as OpsCheckRow[];
  } catch (e) {
    console.error('ops: not read', e);
    return null;
  }
  const prev = opsOf(parsed(kv.get(OPS_KV)));
  const health = (parsed(kv.get('source.health')) ?? {}) as Record<string, SourceHealth>;
  const stall = stallOf(parsed(kv.get(OPS_STALL_KV)));
  // The cron's own gap, the hub's incident or one it did not see: open as bad up to this tick, which is its first good
  // one (the step below counts it). A gap while the last one is still resolving keeps that incident (its start, whether
  // it was told) and counts its good ticks again.
  const before = prev ? structuredClone(prev) : emptyOps();
  const gapFrom = stall?.since ?? (prev?.lastTickAt != null && tickAt - prev.lastTickAt > CRON_STALE_MS ? prev.lastTickAt : null);
  if (gapFrom != null && gapFrom !== prev?.stallSince) {
    const cur = before.open[CRON_TICKS];
    before.open[CRON_TICKS] = {
      name: CRON_TICKS, since: cur?.since ?? gapFrom, openedAt: cur?.openedAt ?? stall?.openedAt ?? now, what: 'stopped', good: 0,
      told: !!cur?.told || !!stall?.toldAt,
      words: `no tick completed from ${when(gapFrom)} to ${when(tickAt)} (${lasting(tickAt - gapFrom)}); ticks complete again`,
    };
    if (stall?.remindedAt != null) before.remindedAt = Math.max(before.remindedAt ?? 0, stall.remindedAt);
    before.stallSince = gapFrom;
  }
  const s = stepIncidents(before, judge(health, checks, tickAt, now), now);
  if (opsSending(env, kv.get(OPS_SWITCH_KV))) {
    const o = outbox(s, now);
    if (o.lines.length && (await tellOperator(env, o.lines, 'ops incidents'))) o.apply(s);
  }
  s.lastTickAt = Date.now();
  try {
    await kvSet(env.DB, OPS_KV, s);
    if (stall) await env.DB.prepare(`DELETE FROM kv WHERE key = '${OPS_STALL_KV}' AND json_extract(value, '$.since') = ?`).bind(stall.since).run();
  } catch (e) {
    console.error('ops: not written', e);
  }
  return s;
}

// ---------------------------------------------------------------- the hub's look at the cron

/**
 * The live hub's look at the cron (live-hub.ts alarm, at most once every OPS_STALL_LOOK_MS): when the last completed
 * tick is older than CRON_STALE_MS, the stalled-cron incident is opened in kv ops.cron_stall (once per gap: the row is
 * keyed by the last completed tick's time) and told; while it stays, one reminder at most every OPS_REMIND_MS. Every
 * write is made only over the row of the same gap, so a tick that took it over in between is never undone. A state
 * never written (no tick has completed since this module was deployed) is not judged here; /api/health says it.
 */
export async function watchCronStall(env: OpsEnv, now = Date.now()): Promise<'fresh' | 'stalled' | 'unknown'> {
  let kv: Map<string, string>;
  try {
    const r = await env.DB.prepare(`SELECT key, value FROM kv WHERE key IN ('${OPS_KV}', '${OPS_STALL_KV}', '${OPS_SWITCH_KV}')`).all<{ key: string; value: string }>();
    kv = new Map((r.results ?? []).map((x) => [x.key, x.value]));
  } catch (e) {
    console.error('ops: the cron\'s last tick not read', e);
    return 'unknown';
  }
  const last = opsOf(parsed(kv.get(OPS_KV)))?.lastTickAt ?? null;
  if (last == null) return 'unknown';
  if (now - last <= CRON_STALE_MS) return 'fresh';
  let stall = stallOf(parsed(kv.get(OPS_STALL_KV)));
  if (!stall || stall.since !== last) {
    // opened over a row of another gap only (one the tick has not removed yet), never over this gap's
    const open: CronStall = { since: last, openedAt: now, toldAt: null, remindedAt: null };
    const r = await env.DB.prepare(`INSERT INTO kv (key, value, updated_at) VALUES ('${OPS_STALL_KV}', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE json_extract(kv.value, '$.since') IS NOT ?`)
      .bind(JSON.stringify(open), now, last).run().catch((e) => { console.error('ops: the stall row not written', e); return null; });
    // not written: the next look tries again, and nothing is told of a gap that is not on record
    if (!r || !(Number(r.meta?.changes ?? 0) > 0)) return 'stalled';
    stall = open;
  }
  if (!opsSending(env, kv.get(OPS_SWITCH_KV))) return 'stalled';
  const age = lasting(now - stall.since);
  const line = stall.toldAt == null
    ? `Opened: ${CRON_TICKS}: no tick has completed since ${when(stall.since)} (${age}); the live hub looked at ${when(now)}.`
    : stall.remindedAt == null || now - stall.remindedAt >= OPS_REMIND_MS
      ? `Still open: ${CRON_TICKS}: no tick has completed since ${when(stall.since)} (${age}).`
      : null;
  if (!line) return 'stalled';
  if (await tellOperator(env, [line], 'ops cron ticks')) {
    const next: CronStall = { ...stall, toldAt: stall.toldAt ?? now, remindedAt: now };
    await env.DB.prepare(`UPDATE kv SET value = ?, updated_at = ? WHERE key = '${OPS_STALL_KV}' AND json_extract(value, '$.since') = ?`)
      .bind(JSON.stringify(next), now, stall.since).run().catch((e) => console.error('ops: the stall row not written', e));
  }
  return 'stalled';
}

// ---------------------------------------------------------------- GET /api/health

/** The answer of GET /api/health: nothing but names and times, no note, no address, no secret. */
export interface HealthAnswer { ok: boolean; lastTickAt: number | null; lastTickAgeMs: number | null; failing: string[]; incidents: string[] }

/**
 * /api/health from the stored state and the hub's stall: `failing`, every name bad at the last tick (open or not yet);
 * `incidents`, the open incidents (the stalled cron among them). 503 when no tick has completed on record, the last
 * one is older than HEALTH_TICK_MAX_AGE_MS, or an incident is open.
 */
export function healthAnswer(state: OpsState | null, stall: CronStall | null, now: number): { status: 200 | 503; body: HealthAnswer } {
  const last = state?.lastTickAt ?? null;
  const age = last == null ? null : Math.max(0, now - last);
  const open = state ? Object.values(state.open) : [];
  const failing = [...new Set([...Object.keys(state?.watch ?? {}), ...open.filter((i) => i.good === 0).map((i) => i.name)])].sort();
  const incidents = [...new Set([...open.map((i) => i.name), ...(stall && stall.since === last ? [CRON_TICKS] : [])])].sort();
  const ok = age != null && age <= HEALTH_TICK_MAX_AGE_MS && incidents.length === 0;
  return { status: ok ? 200 : 503, body: { ok, lastTickAt: last, lastTickAgeMs: age, failing, incidents } };
}

/** The reads of GET /api/health: two kv rows by key, in one statement. */
export async function readHealth(db: D1Database, now = Date.now()): Promise<{ status: 200 | 503; body: HealthAnswer }> {
  const r = await db.prepare(`SELECT key, value FROM kv WHERE key IN ('${OPS_KV}', '${OPS_STALL_KV}')`).all<{ key: string; value: string }>();
  const kv = new Map((r.results ?? []).map((x) => [x.key, x.value]));
  return healthAnswer(opsOf(parsed(kv.get(OPS_KV))), stallOf(parsed(kv.get(OPS_STALL_KV))), now);
}
