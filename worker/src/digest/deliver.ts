// The daily and weekly digest in the cron's run, and its preview from Settings (the digest spec's sections 2, 3, 4.5
// and 10, with the owner's decisions of 2026-10-23). The cron asks which periods are due (the day's from 08:00 UTC,
// the week's from 08:00 UTC on Mondays), whether each is still open (one read of its claim and its delivery record),
// builds the open ones from D1 beside its intel read, and sends each through the alerts' own path
// (sources/discord.ts sendDiscordDigest) under the run's budget, the daily before the weekly, both after the
// governance alerts and before the forum's. A day with no run from 08:00 to midnight UTC gets no digest later: its
// key is never asked again, and the next day's health row and operator embed say so. Nothing here posts on its own,
// and nothing is built or claimed on a Worker that does not send alerts.
import { DIGEST_HOUR_UTC } from '../../../shared/alerts';
import type { SourceHealth } from '../../../shared/types';
import { alertsPaused, sendDiscordDigest, PAUSED_NOTE, type AlertBudget, type DigestDelivery, type DigestOutcome, type WebhookPost } from '../sources/discord';
import type { StoredSettings } from '../settings';
import { readAndBuildDigest, type DigestBuild, type DigestPost } from './build';
import type { OpeningMaker } from './opening';
import { DIGEST_LATE_NOTE_MS, ago, clock, dayMon, digestDueAt, digestKey, digestLabel, isoDate, lateNote, plural } from './message';
import { DIGEST_LAST_KV, DIGEST_PAUSED_KV, PAUSED_STRETCHES_KEPT, PAUSE_GAP_MS, PAUSE_NOTE_EVERY_MS, dailyClaimKey, digestLastKv, parsePaused, pausedInWindow, pausedThrough, type PausedStretch } from './operator';
import { DAY_MS, DB_NOT_ANSWERED, isNotRead, notRead, type DigestKind, type NotRead } from './types';
import { readWatchlists, type WatchResult } from './watchlists';

/** "08:00": the hour the digest is due, as its words name it. */
const hourWords = `${String(DIGEST_HOUR_UTC).padStart(2, '0')}:00`;

/** The Sources sheet's row for the digest: sent (with the time and the channels), waiting, not built, or not sent. */
export const DIGEST_HEALTH = 'Daily digest';
/**
 * The most posts one recipient's digest takes: the first message (the shared embed, its pictures and, when there is
 * room, the recipient's own embed) and a second one (the attention section with its picture, and the recipient's own
 * embed when the first had no room for it), as build.ts postsFor lays them out.
 */
export const DIGEST_MAX_POSTS = 2;
/** The Settings preview keeps the digest it built for this long, so a second press costs only that wallet's watchlist read. */
export const PREVIEW_KEEP_MS = 5 * 60_000;

/** The digests due at `now`: none before 08:00 UTC, the day's from then on, and on a Monday the week's after it. */
export function digestsDue(now: number): DigestKind[] {
  if (now < digestDueAt(now)) return [];
  return new Date(now).getUTCDay() === 1 ? ['daily', 'weekly'] : ['daily'];
}

/**
 * A period's delivery record (kv digest.last for the daily, digest.last.weekly for the weekly): when its first post
 * went (`at`), its channels in all (`targets`: those claimed so far and those waiting), those that took it
 * (`posted`), those claimed that did not (`skipped`), those still waiting for a later run (`waiting`; null when the
 * subscribers' settings could not be read, so who waits is not known), and when the record was last written.
 */
export interface DigestRecord { key: string; at: number; targets: number; posted: number; skipped: number; waiting: number | null; lastAt: number }

function parseRecord(raw: string | null | undefined): DigestRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.key !== 'string' || !Number.isFinite(v.at)) return null;
    const n = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);
    return { key: v.key, at: Number(v.at), targets: n(v.targets), posted: n(v.posted), skipped: n(v.skipped), waiting: v.waiting === null ? null : n(v.waiting), lastAt: Number.isFinite(v.lastAt) ? Number(v.lastAt) : Number(v.at) };
  } catch { return null; }
}

/** What this isolate knows of a period: every channel has its digest. A new isolate asks the database once. */
const known = new Set<string>();
/** The UTC dates whose day before this isolate has looked at for a missed digest. */
const missedAsked = new Set<string>();
/** When this isolate last recorded a run held by the pause (notePaused). */
let pausedNotedAt = 0;
/** Whether this isolate has looked, while sending, for a stretch of the pause left open (closePaused). */
let pausedClosed = false;
/** Forgets what this isolate knows (the tests' fresh isolate). */
export function resetDigestMemory() { known.clear(); missedAsked.clear(); previewBuild = null; pausedNotedAt = 0; pausedClosed = false; }

/**
 * A run that sends alerts closes the newest stretch of the pause, once an isolate: a held run after it starts a
 * stretch of its own, so the minutes in which alerts were sent are never counted as paused. The stretch is taken to
 * this run when its newest held run on record is within PAUSE_GAP_MS (held runs are recorded every PAUSE_NOTE_EVERY_MS
 * at most, so the runs between that one and this were held too). One read an isolate; one write the first time after
 * a pause.
 */
export async function closePaused(db: D1Database, now: number): Promise<void> {
  if (pausedClosed) return;
  // marked once the read has answered: a read that fails is made again on the isolate's next run
  const row = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(DIGEST_PAUSED_KV).first<{ value: string }>();
  pausedClosed = true;
  const list = parsePaused(row?.value);
  const newest = list[list.length - 1];
  if (!row || !newest || newest.closed) return;
  newest.closed = true;
  if (now > newest.to && now - newest.to <= PAUSE_GAP_MS) newest.to = now;
  await db.prepare('UPDATE kv SET value = ?, updated_at = ? WHERE key = ? AND value = ?').bind(JSON.stringify({ stretches: list }), now, DIGEST_PAUSED_KV, row.value).run();
}

/**
 * Records that this run was held by the pause (kv digest.paused), at most every PAUSE_NOTE_EVERY_MS in an isolate.
 * The newest stretch goes on while held runs keep coming; a held run more than PAUSE_GAP_MS after its newest starts
 * a stretch of its own, and the older ones are kept. The first record of all, written when the last daily digest on
 * record is more than a day old, starts at the hour the first digest after it was due: a digest was skipped then, and
 * before this record existed nothing else could say the runs were held (a day with no run had its own row at the
 * time). Any other stretch starts at its own first run.
 */
export async function notePaused(db: D1Database, now: number): Promise<void> {
  if (now - pausedNotedAt < PAUSE_NOTE_EVERY_MS) return;
  pausedNotedAt = now;
  const r = await db.prepare('SELECT key, value FROM kv WHERE key IN (?, ?)').bind(DIGEST_PAUSED_KV, DIGEST_LAST_KV).all<{ key: string; value: string }>();
  const rows = r.results ?? [];
  const had = rows.find((x) => x.key === DIGEST_PAUSED_KV);
  const list = parsePaused(had?.value);
  const newest = list[list.length - 1];
  if (newest && !newest.closed && now >= newest.to && now - newest.to <= PAUSE_GAP_MS) newest.to = now;
  else {
    const last = had ? null : parseRecord(rows.find((x) => x.key === DIGEST_LAST_KV)?.value);
    const skipped = last && now - last.at > DAY_MS ? Math.min(digestDueAt(last.at + DAY_MS), now) : null;
    list.push({ from: skipped ?? now, to: now });
  }
  await db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').bind(DIGEST_PAUSED_KV, JSON.stringify({ stretches: list.slice(-PAUSED_STRETCHES_KEPT) }), now).run();
}

/**
 * Whether a period is still open: 'new' when its key was never claimed, 'done' when its record says no channel waits,
 * else 'open' (a run took some channels and others wait, or its record was not written). One primary-key read of
 * the claim and the record.
 */
export async function periodState(db: D1Database, key: string, kind: DigestKind): Promise<{ state: 'new' | 'open' | 'done'; record: DigestRecord | null }> {
  const rk = digestLastKv(kind);
  const r = await db.prepare('SELECT key, value FROM kv WHERE key IN (?, ?)').bind(key, rk).all<{ key: string; value: string }>();
  const rows = r.results ?? [];
  const record = parseRecord(rows.find((x) => x.key === rk)?.value);
  if (!rows.some((x) => x.key === key)) return { state: 'new', record };
  if (record && record.key === key && record.waiting === 0) return { state: 'done', record };
  return { state: 'open', record };
}

/**
 * The health row of a day whose digest was never sent: the day before `now` had no run from 08:00 to midnight UTC
 * (its key was never claimed) while an earlier digest is on record (the first day after the deploy had none to
 * miss). Asked once a UTC day in an isolate, until that day's digest is sent; null when nothing was missed. A day
 * that ended inside a recorded stretch of the pause (kv digest.paused) had runs, each held: its digest was not
 * missed. Its row says so and is ok, so the row the held runs left ("Off while the alerts are paused") does not
 * stand on after the pause is lifted, until the next digest's own row replaces it.
 */
export async function missedYesterday(db: D1Database, now: number): Promise<SourceHealth | null> {
  const day = isoDate(now);
  if (missedAsked.has(day)) return null;
  const yKey = dailyClaimKey(now - DAY_MS);
  const r = await db.prepare('SELECT key, value FROM kv WHERE key IN (?, ?, ?)').bind(yKey, DIGEST_LAST_KV, DIGEST_PAUSED_KV).all<{ key: string; value: string }>();
  missedAsked.add(day);
  if (missedAsked.size > 8) missedAsked.delete(missedAsked.values().next().value!);
  const rows = r.results ?? [];
  if (rows.some((x) => x.key === yKey)) return null;
  if (pausedThrough(parsePaused(rows.find((x) => x.key === DIGEST_PAUSED_KV)?.value), Date.parse(`${day}T00:00:00Z`))) {
    return { name: DIGEST_HEALTH, ok: true, at: now, note: `No digest on ${dayMon(now - DAY_MS)}: alerts were paused. The next one is due at ${hourWords} UTC.` };
  }
  const rec = parseRecord(rows.find((x) => x.key === DIGEST_LAST_KV)?.value);
  if (!rec || rec.key >= yKey) return null;
  return { name: DIGEST_HEALTH, ok: false, at: now, note: `No digest on ${dayMon(now - DAY_MS)}: no run between ${hourWords} and 24:00 UTC.` };
}

/**
 * A period the run sends: its build, started beside the intel read, and what was known of it before. `opening` is the
 * period's opening or null; it starts once the build is done, is settled within OPENING_BUDGET_MS of that
 * (digest/opening.ts), and never rejects.
 */
export interface DigestJob { kind: DigestKind; key: string; what: string; now: number; state: 'new' | 'open'; record: DigestRecord | null; build: Promise<DigestBuild | { error: string }>; opening?: Promise<string | null> }
export interface DigestRun { jobs: DigestJob[]; rows: SourceHealth[] }

/** Why no digest is claimed or posted on this run: the pause (ALERTS_PAUSED, read as off on purpose) or no SEND_ALERTS. */
const offNote = () => (alertsPaused() ? PAUSED_NOTE : 'Not sent: SEND_ALERTS is not yes on this Worker, so no digest is claimed or posted.');
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, ' ').slice(0, 120);
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The run's first part, beside the intel read: the periods due and still open, each with its build started (reads of
 * D1 only), and the health rows known before any post (a missed day, a claim that could not be read, a Worker that
 * does not send). `sends` is sources/discord.ts sendsAlerts(env): a Worker that does not send builds nothing and
 * claims nothing, so a preview deployment or a local run on the same database never takes production's key.
 */
export async function prepareDigests(db: D1Database, now: number, sends: boolean, makeOpening?: OpeningMaker): Promise<DigestRun> {
  const rows: SourceHealth[] = [];
  const jobs: DigestJob[] = [];
  const due = digestsDue(now);
  if (!sends) {
    if (due.length) rows.push({ name: DIGEST_HEALTH, ok: false, at: now, note: offNote() });
    // held by the pause (a Worker that sends, paused; never one without SEND_ALERTS): the run is put on record, so
    // the days it covers are known as held once the pause is lifted. A write that fails costs the run nothing.
    if (alertsPaused()) await notePaused(db, now).catch((e) => console.error('digest: the paused run was not recorded', e));
    return { jobs, rows };
  }
  // The stretch in which runs were held by the pause, read once in a run that has a maker and a period due: a
  // period whose window reaches into it gets no written opening (pausedInWindow). A read that fails is taken as
  // reaching into it: a digest without an opening is whole, and an opening is never the reason one is late.
  let pausedRec: PausedStretch[] | undefined | 'unread';
  const heldIn = async (kind: DigestKind): Promise<boolean> => {
    if (pausedRec === undefined) {
      pausedRec = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(DIGEST_PAUSED_KV).first<{ value: string }>()
        .then((r) => parsePaused(r?.value), () => 'unread' as const);
    }
    return pausedRec === 'unread' || pausedInWindow(pausedRec, now, kind);
  };
  await closePaused(db, now).catch((e) => console.error('digest: the record of the pause was not closed', e));
  for (const kind of due) {
    const key = digestKey(now, kind), what = digestLabel(now, kind);
    if (known.has(key)) continue;
    let st: Awaited<ReturnType<typeof periodState>>;
    try { st = await periodState(db, key, kind); } catch (e) {
      rows.push({ name: DIGEST_HEALTH, ok: false, at: now, note: `${capFirst(what)}: not built: its claim could not be read (${errText(e)}).` });
      continue;
    }
    if (st.state === 'done') { known.add(key); continue; }
    const build: Promise<DigestBuild | { error: string }> = readAndBuildDigest(db, now, kind).catch((e) => ({ error: errText(e) }));
    const state = st.state;
    // A Worker that does not send never comes here (above), so the pause and a preview deployment make no model call.
    // A period whose window reaches into a time when alerts were paused has no written opening: it is the first of
    // its kind after the pause (or holds part of it), and it goes out as the figures alone.
    const plain = makeOpening ? await heldIn(kind) : false;
    if (plain) console.log(`${what}: no written opening: its window reaches into a time when alerts were paused`);
    const opening = makeOpening && !plain
      ? build.then((b) => ('error' in b ? null : makeOpening(b, state))).catch((e) => { console.error(`${what}: no opening: ${errText(e)}`); return null; })
      : undefined;
    jobs.push({ kind, key, what, now, state, record: st.record, build, opening });
  }
  // Until the day's digest is sent, the day before is looked at once for a missed digest (its row comes first, so a
  // send this run replaces it).
  if (!known.has(digestKey(now, 'daily'))) {
    const m = await missedYesterday(db, now).catch(() => null);
    if (m) rows.unshift(m);
  }
  return { jobs, rows };
}

/** A post as the dispatcher takes it. */
const toPost = (p: DigestPost): WebhookPost => ({
  body: p.payload as unknown as Record<string, unknown>,
  files: p.files.map((f) => ({ name: f.name, bytes: f.bytes, type: f.type })),
});
const walletOf = (u: StoredSettings) => ({ address: u.address, watchlistOn: u.notifications.watchlistOn, watchlist: u.notifications.watchlist });
const hasWatchlist = (u: StoredSettings) => !!u.notifications.watchlistOn && u.notifications.watchlist.length > 0;

/** The watchlists of these wallets, read in one bounded pass; a read that fails is every embed's "not read" line. */
async function watchOf(db: D1Database, wallets: StoredSettings[], b: DigestBuild): Promise<WatchResult | NotRead | null> {
  // the address cap is filled first saved first (spec 4.4), whatever order the day's rotation sends in, so wallets saved
  // later, made-up watchlists and all, can never take an earlier wallet's watchlist away
  const watched = wallets.filter(hasWatchlist).sort((a, b) => a.createdAt - b.createdAt || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
  if (!watched.length) return null;
  return readWatchlists(db, watched.map((u) => ({ address: u.address, watchlist: u.notifications.watchlist })), b.now, b.kind)
    .catch((e): NotRead => { console.error(`${b.what}: the watchlists were not read: ${errText(e)}`); return notRead('watchlist', null, DB_NOT_ANSWERED); });
}

/** One build as the dispatcher's DigestDelivery: the operator's posts and each subscriber's, with their watchlists read at the send. */
export function deliveryOf(b: DigestBuild, db: D1Database, opening: string | null = null): DigestDelivery {
  return {
    key: b.key,
    what: b.what,
    maxPosts: DIGEST_MAX_POSTS,
    operator: (t) => b.operatorPostsWith(t, opening).map(toPost),
    subscribers: async (wallets) => {
      const watch = await watchOf(db, wallets, b);
      const of = b.subscriberPostsWith(watch, opening);
      return { postsOf: (u) => of(walletOf(u)).map(toPost), capped: watch && !isNotRead(watch) ? watch.capped : 0 };
    },
  };
}

/**
 * The record after a run that posted: the period's first record (`at` the instant its digest was built for, the time
 * its header names), or the earlier one with this run's channels added; `lastAt` is when this run wrote it.
 */
export function nextRecord(prev: DigestRecord | null, key: string, builtAt: number, now: number, r: Extract<DigestOutcome, { state: 'sent' }>): DigestRecord {
  const same = prev && prev.key === key && !r.first ? prev : null;
  const posted = (same?.posted ?? 0) + r.reached;
  const skipped = (same?.skipped ?? 0) + (r.channels - r.reached);
  return { key, at: same?.at ?? builtAt, targets: posted + skipped + (r.left ?? 0), posted, skipped, waiting: r.left, lastAt: now };
}

/** The health row of a period sent so far: its first post's time, the channels that took it, those waiting, how late. */
export function sentWords(what: string, rec: DigestRecord): string {
  const late = rec.at - digestDueAt(rec.at);
  const notSent = rec.skipped ? `; ${rec.skipped} not sent (the Discord alert delivery row says why)` : '';
  const waits = rec.waiting == null ? "; the subscribers' settings could not be read, so theirs waits for the next run" : rec.waiting ? `; ${plural(rec.waiting, 'channel')} wait for the next run` : '';
  const lateWords = late > DIGEST_LATE_NOTE_MS ? `, ${ago(late)} after ${hourWords} UTC` : '';
  return `${capFirst(what)} sent ${dayMon(rec.at)} ${clock(rec.at)} UTC${lateWords} to ${rec.posted} of ${plural(rec.targets, 'channel')}${notSent}${waits}.`;
}

const writeRecord = (db: D1Database, kind: DigestKind, rec: DigestRecord) =>
  db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').bind(digestLastKv(kind), JSON.stringify(rec), rec.lastAt).run()
    .catch((e) => console.error(`digest: the delivery record of ${rec.key} was not written`, e));

/**
 * The run's second part, after the governance alerts: each open period's digest through sendDiscordDigest under the
 * run's budget, its delivery record, its health row and its console line (never an address, a figure of a watchlist
 * or a channel). A build that failed in its header part sends nothing and claims nothing this run; the next tries again.
 */
export async function sendDigests(db: D1Database, webhookUrl: string | undefined, run: DigestRun, budget: AlertBudget, health: SourceHealth[]): Promise<void> {
  for (const j of run.jobs) {
    const b = await j.build;
    if ('error' in b) {
      console.error(`${j.what}: not built: ${b.error}`);
      health.push({ name: DIGEST_HEALTH, ok: false, at: Date.now(), note: `${capFirst(j.what)}: not built: ${b.error}`.slice(0, 160) });
      continue;
    }
    for (const n of b.notes) console.warn(`${j.what}: ${n}`);
    const opening = j.opening ? await j.opening : null;
    let r: DigestOutcome;
    try { r = await sendDiscordDigest(webhookUrl, deliveryOf(b, db, opening), db, budget); } catch (e) {
      console.error(`${j.what}: not sent:`, e);
      health.push({ name: DIGEST_HEALTH, ok: false, at: Date.now(), note: `${capFirst(j.what)}: not sent: ${errText(e)}`.slice(0, 160) });
      continue;
    }
    const at = Date.now();
    if (r.state === 'off') {
      health.push({ name: DIGEST_HEALTH, ok: false, at, note: offNote() });
    } else if (r.state === 'done') {
      known.add(j.key);
      if (r.channels === 0 && j.state === 'new') {
        await writeRecord(db, j.kind, { key: j.key, at: j.now, targets: 0, posted: 0, skipped: 0, waiting: 0, lastAt: at });
        health.push({ name: DIGEST_HEALTH, ok: true, at, note: `${capFirst(j.what)}: no channel takes it (no operator channel is set and no subscriber has the digest on).` });
      } else if (j.record && j.record.key === j.key && j.record.waiting !== 0) {
        // the channels that waited are gone (their switch or their link was turned off since)
        const rec = { ...j.record, targets: j.record.posted + j.record.skipped, waiting: 0, lastAt: at };
        await writeRecord(db, j.kind, rec);
        health.push({ name: DIGEST_HEALTH, ok: true, at, note: sentWords(j.what, rec) });
      }
    } else if (r.state === 'waiting') {
      const why = r.unread ? "the subscribers' settings could not be read" : r.paused ? "Discord limited the site's address" : r.left == null ? 'its claims could not be read' : "this run's posts are spent";
      console.warn(`${j.what}: waiting for the next run (${why})`);
      health.push({ name: DIGEST_HEALTH, ok: true, at, note: `${capFirst(j.what)}: waiting for the next run (${why}).` });
    } else {
      const rec = nextRecord(j.record, j.key, j.now, at, r);
      await writeRecord(db, j.kind, rec);
      if (rec.waiting === 0) known.add(j.key);
      console.log(`${j.what}: sent to ${plural(r.channels, 'channel')}, ${r.channels - r.reached} not sent${r.left ? `, ${r.left} wait for the next run` : r.left == null ? ", the subscribers' settings not read" : ''}`);
      health.push({ name: DIGEST_HEALTH, ok: true, at, note: sentWords(j.what, rec).slice(0, 200) });
    }
  }
}

// ------------------------------------------------------------------------------------------------- the preview

let previewBuild: { at: number; build: Promise<DigestBuild> } | null = null;

/** The preview's opening words: the description begins with them, and a preview carries no late note. */
export const PREVIEW_LEAD = `This is how the digest looks; it is posted at ${hourWords} UTC every day while it is on.`;

/** A digest's first message as a preview: "Preview · " before its title, the lead before its description, no late note. */
function previewOf(p: DigestPost, now: number): DigestPost {
  const [first, ...rest] = p.payload.embeds;
  if (!first) return p;
  const late = lateNote(now);
  const desc = (first.description ?? '').replace(late, '');
  const embed = { ...first, ...(first.title ? { title: `Preview · ${first.title}`.slice(0, 256) } : {}), description: `${PREVIEW_LEAD}\n\n${desc}` };
  return { ...p, payload: { ...p.payload, embeds: [embed, ...rest] } };
}

/**
 * The posts a Settings preview sends to this wallet's channel: the daily digest as built now (kept for
 * PREVIEW_KEEP_MS, so a second press within it reads only the watchlist), with this wallet's watchlist only, never
 * the operator's embed. Throws when the digest could not be built (the route then posts nothing).
 */
export async function previewPosts(db: D1Database, u: StoredSettings, now = Date.now()): Promise<WebhookPost[]> {
  if (!previewBuild || now - previewBuild.at > PREVIEW_KEEP_MS || now < previewBuild.at) previewBuild = { at: now, build: readAndBuildDigest(db, now, 'daily') };
  const cached = previewBuild;
  let b: DigestBuild;
  try { b = await cached.build; } catch (e) {
    if (previewBuild === cached) previewBuild = null;
    throw e;
  }
  const watch = await watchOf(db, [u], b);
  const posts = b.subscriberPostsWith(watch)(walletOf(u));
  return posts.map((p, i) => toPost(i === 0 ? previewOf(p, b.now) : p));
}
