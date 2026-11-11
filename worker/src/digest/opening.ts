// The digest's opening: one or two sentences written by Claude Haiku 5.5 from figures the digest has already computed
// (shared/digest-opening.ts says what is asked and checked). It runs by itself in the cron's digest path.
//
// It starts when a period's build is done, beside the intel read, and is settled within OPENING_BUDGET_MS, whatever the
// model or the database do: a run that reaches its send before then waits for what is left of that time and no longer.
// Any refusal, failure or timeout, a missing ANTHROPIC_API_KEY or the month's cap means no opening, and the digest goes
// out as it does without one.
//
// One opening a period, in kv under `digest.opening:<period>`: the row is claimed before the first call, so a run that
// retries the period, or a second isolate, makes no second call and every channel gets the same text. An opening that
// could not be stored is not shown, since the next run could not give the channels it reaches the same words; a period
// whose first run wrote nothing stays without one.
//
// The month's spend is counted in kv `digest.opening.spend` from each answer's usage. A call cut off by the time allowed
// has no usage to count; it is at most one 1,024-token answer.
import Anthropic from '@anthropic-ai/sdk';
import {
  OPENING_MODEL, OPENING_READ_SCHEMA, OPENING_READ_SYSTEM, OPENING_SCHEMA, OPENING_SYSTEM, checkOpening, openingPrompt, openingReadPrompt, type OpeningFact,
} from '../../../shared/digest-opening';
import { kvGetJson, kvSet } from '../db';
import type { Env } from '../util';
import type { DigestBuild } from './build';
import { int, isNotRead, nam, namadaScanBehind, osmosisIndexUpToDate, pct, usd, usdPrice, type DigestFigures, type MetricFigure } from './message';

/** The time from a period's finished build to its opening being settled: four calls of about two seconds at most. */
export const OPENING_BUDGET_MS = 8_000;
/** No call once the month's counted spend reaches this. */
export const OPENING_MONTH_CAP_USD = 3;
/** Claude Haiku 5.5's prices per million tokens, for the month's count. */
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;
export const OPENING_SPEND_KEY = 'digest.opening.spend';
/** The facts an opening needs besides the period; with fewer, the digest has too little to open on. */
const MIN_FACTS = 3;
/** How long an opening is kept, for reading back what went out. */
const KEEP_MS = 35 * 86_400_000;

/** The kv key of a period's opening, from its claim key (alert:digest:daily:<date> or alert:digest:weekly:<week>). */
export const openingKey = (periodKey: string): string => `digest.opening:${periodKey.replace('alert:digest:', '')}`;

/** A period's row: 'pending' from its claim until the run ends, then what the run came to. */
export interface StoredOpening {
  text: string | null;
  status: 'pending' | 'ok' | 'rejected' | 'none' | 'failed';
  /** why there is no opening; null when there is */
  reason: string | null;
  model: string;
  at: number;
}

/** One writing call. Throws when there is no usable answer. */
export type OpeningWriteFn = (facts: OpeningFact[], refused: string | undefined, signal: AbortSignal) => Promise<{ opening: string; inTokens: number; outTokens: number }>;
/** The second reading of an opening. Throws when there is no usable answer: nothing unread is shown. */
export type OpeningReadFn = (facts: OpeningFact[], opening: string, signal: AbortSignal) => Promise<{ supported: boolean; problem: string; inTokens: number; outTokens: number }>;
export interface OpeningDeps { write: OpeningWriteFn; read: OpeningReadFn; budgetMs?: number }
export interface OpeningJob { key: string; state: 'new' | 'open'; facts: OpeningFact[]; now: number }

/** What the digest path calls with a finished build: the period's opening or null. */
export type OpeningMaker = (b: DigestBuild, state: 'new' | 'open') => Promise<string | null>;

// ------------------------------------------------------------------------------------------------- the facts

/**
 * The digest's own figures as labelled facts, each value as the digest prints it, and only figures read to the end of
 * the window: a section not read, or counted only part of the way (the scan or the index behind, more trades than the
 * read holds), is left out, never described. Nothing about a wallet, a validator or a proposal goes in, only totals.
 */
export function openingFacts(fig: DigestFigures): OpeningFact[] {
  const window = fig.kind === 'daily' ? '24 h' : '7 d';
  const facts: OpeningFact[] = [{ label: 'Period', value: fig.kind === 'daily' ? 'one day' : 'one week' }];
  const add = (label: string, value: string) => { facts.push({ label, value }); };
  const metric = (label: string, m: MetricFigure, fmt: (x: number) => string) => {
    if (isNotRead(m)) return;
    add(label, fmt(m.value));
    const b = m.bases[0];
    if (b && b.label === window && 'at' in b.base && b.base.value) add(`${label}, change over the period`, pct(m.value / b.base.value - 1));
  };

  if (!isNotRead(fig.staked)) metric('Total stake', fig.staked.value.totalStake, nam);
  if (!isNotRead(fig.price)) metric('NAM price', fig.price.value.quote, usdPrice);

  const namadaCounted = !!fig.anchors.namada && fig.anchors.namada.cursor != null && !namadaScanBehind(fig.anchors.namada, fig.now);
  if (namadaCounted) {
    if (!isNotRead(fig.requests) && fig.requests.value.decodeFailures === 0) {
      const { bonds, unbonds } = fig.requests.value;
      add('Bond requests', int(bonds.n));
      add('NAM bonded', nam(bonds.nam));
      add('Unbond requests', int(unbonds.n));
      add('NAM unbonded', nam(unbonds.nam));
    }
    if (!isNotRead(fig.rewards)) {
      add('Reward claims', int(fig.rewards.value.n));
      add('NAM claimed as rewards', nam(fig.rewards.value.nam));
    }
    if (!isNotRead(fig.masp)) {
      const v = fig.masp.value;
      add('NAM into the shielded pool', nam(v.shield.nam + v.ibcIn.nam));
      add('NAM out of the shielded pool', nam(v.unshield.nam + v.ibcOut.nam + v.feesNam));
    }
  }
  if (!isNotRead(fig.masp)) metric('NAM in the shielded pool', fig.masp.value.balance, nam);

  if (osmosisIndexUpToDate(fig.anchors.osmosis, fig.now)) {
    if (!isNotRead(fig.trades) && !fig.trades.value.window.overBound) {
      const w = fig.trades.value.window;
      add('Trades on Osmosis', int(w.n));
      add('NAM traded on Osmosis', nam(w.nam));
      if (w.usd != null) add('Value of those trades', usd(w.usd));
    }
    if (!isNotRead(fig.bridge)) {
      add('NAM moved from Namada to Osmosis', nam(fig.bridge.value.ibcIn.nam));
      add('NAM moved from Osmosis to Namada', nam(fig.bridge.value.ibcOut.nam));
    }
  }

  if (!isNotRead(fig.validators) && !fig.validators.value.noListingToday && !fig.validators.value.baseIsOldest && !fig.validators.value.baseIsEarlier) {
    add('Validators that joined', int(fig.validators.value.joined));
    add('Validators that left', int(fig.validators.value.left));
  }
  return facts;
}

// ------------------------------------------------------------------------------------------------- the calls

/** An answer's text, or an error when the model declined or was cut off. */
function answerText(res: Anthropic.Message): string {
  if (res.stop_reason === 'refusal') throw new Error('the model declined');
  if (res.stop_reason === 'max_tokens') throw new Error('the answer was cut off');
  return res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

function parsed(text: string): Record<string, unknown> {
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new Error('the answer was not the asked shape'); }
}

/** The writing call through the Anthropic SDK: structured output, low effort, no retry of its own. */
export function anthropicOpeningWriter(apiKey: string): OpeningWriteFn {
  const client = new Anthropic({ apiKey, timeout: OPENING_BUDGET_MS, maxRetries: 0 });
  return async (facts, refused, signal) => {
    const res = await client.messages.create({
      model: OPENING_MODEL,
      max_tokens: 1024,
      system: OPENING_SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: OPENING_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: 'user', content: openingPrompt(facts, refused) }],
    }, { signal });
    const opening = parsed(answerText(res)).opening;
    if (typeof opening !== 'string') throw new Error('the answer had no opening');
    return { opening, inTokens: res.usage.input_tokens, outTokens: res.usage.output_tokens };
  };
}

/** The second reading through the Anthropic SDK. */
export function anthropicOpeningReader(apiKey: string): OpeningReadFn {
  const client = new Anthropic({ apiKey, timeout: OPENING_BUDGET_MS, maxRetries: 0 });
  return async (facts, opening, signal) => {
    const res = await client.messages.create({
      model: OPENING_MODEL,
      max_tokens: 1024,
      system: OPENING_READ_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: OPENING_READ_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: 'user', content: openingReadPrompt(facts, opening) }],
    }, { signal });
    const r = parsed(answerText(res));
    if (typeof r.supported !== 'boolean') throw new Error('the reading had no verdict');
    return { supported: r.supported, problem: String(r.problem ?? '').slice(0, 200), inTokens: res.usage.input_tokens, outTokens: res.usage.output_tokens };
  };
}

// ------------------------------------------------------------------------------------------------- one period

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** The month's count goes up in one statement, so two periods sent in one run (a Monday's) cannot lose one's cost. */
const addSpend = (db: D1Database, now: number, usd: number) => {
  const month = monthOf(now);
  return db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, json_object('month', ?, 'usd', ?), ?)
     ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at, value = json_object('month', ?, 'usd',
       CASE WHEN json_extract(kv.value, '$.month') = ? THEN json_extract(kv.value, '$.usd') + ? ELSE ? END)`,
  ).bind(OPENING_SPEND_KEY, month, usd, now, month, month, usd, usd).run();
};

/** The writing and its checks: one retry with the reason, then the second answer stands or falls. Adds to `tally` as it goes. */
async function writeChecked(deps: OpeningDeps, facts: OpeningFact[], signal: AbortSignal, tally: { in: number; out: number }) {
  const attempt = async (refused?: string) => {
    const r = await deps.write(facts, refused, signal);
    tally.in += r.inTokens; tally.out += r.outTokens;
    let check = checkOpening(r.opening, facts);
    if (check.ok) {
      const v = await deps.read(facts, check.text, signal);
      tally.in += v.inTokens; tally.out += v.outTokens;
      if (!v.supported) check = { ok: false, reason: `the second reading did not find it in the figures: ${v.problem || 'no reason given'}` };
    }
    return { opening: r.opening, check };
  };
  let a = await attempt();
  if (!a.check.ok && a.opening.trim()) a = await attempt(a.check.reason);
  return a;
}

async function runOpening(db: D1Database, job: OpeningJob, deps: OpeningDeps, signal: AbortSignal): Promise<string | null> {
  const key = openingKey(job.key);
  const stored = await kvGetJson<StoredOpening>(db, key);
  if (stored) return stored.status === 'ok' ? stored.text : null;
  // A period some channels already have, with no row: whatever those channels got had no opening, and a retry makes no call.
  if (job.state !== 'new') return null;
  if (job.facts.length - 1 < MIN_FACTS) return null;
  const spend = await kvGetJson<{ month: string; usd: number }>(db, OPENING_SPEND_KEY);
  if (spend && spend.month === monthOf(job.now) && spend.usd >= OPENING_MONTH_CAP_USD) return null;

  const base = { model: OPENING_MODEL, at: job.now };
  const pending: StoredOpening = { ...base, text: null, status: 'pending', reason: null };
  const claim = await db.prepare('INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(pending), job.now).run();
  if (Number(claim.meta?.changes ?? 0) === 0) return null;

  const tally = { in: 0, out: 0 };
  let entry: StoredOpening;
  try {
    const a = await writeChecked(deps, job.facts, signal, tally);
    entry = a.check.ok ? { ...base, text: a.check.text, status: 'ok', reason: null }
      : { ...base, text: null, status: a.opening.trim() ? 'rejected' : 'none', reason: a.check.reason };
  } catch (e) {
    entry = { ...base, text: null, status: 'failed', reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
  if (signal.aborted && entry.status === 'ok') entry = { ...base, text: null, status: 'failed', reason: 'past the time allowed' };
  await addSpend(db, job.now, (tally.in * PRICE_IN + tally.out * PRICE_OUT) / 1e6).catch((e) => console.error('digest opening: the spend was not counted', e));
  await kvSet(db, key, entry);
  await db.prepare(`DELETE FROM kv WHERE key >= 'digest.opening:' AND key < 'digest.opening;' AND updated_at < ?`).bind(job.now - KEEP_MS).run().catch(() => {});
  // The writes can carry an accepted opening past the budget: the race has then answered null, so no later channel may get it.
  if (signal.aborted && entry.status === 'ok') {
    entry = { ...base, text: null, status: 'failed', reason: 'past the time allowed' };
    await kvSet(db, key, entry);
  }
  if (entry.status !== 'ok') console.warn(`digest opening ${job.key}: ${entry.status}: ${entry.reason}`.slice(0, 200));
  return entry.status === 'ok' ? entry.text : null;
}

/**
 * The period's opening, or null. Settles within the budget and never rejects: past the budget the calls are aborted and
 * null is answered, whatever is still running.
 */
export function openingFor(db: D1Database, job: OpeningJob, deps: OpeningDeps): Promise<string | null> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => { ac.abort(); resolve(null); }, deps.budgetMs ?? OPENING_BUDGET_MS);
  });
  const work = runOpening(db, job, deps, ac.signal).catch((e) => {
    console.error(`digest opening ${job.key}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    return null;
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/** The digest path's maker over any model functions (the tests' fakes). */
export const openingMakerWith = (db: D1Database, deps: OpeningDeps): OpeningMaker => async (b, state) =>
  openingFor(db, { key: b.key, state, facts: openingFacts(b.messageFigures), now: b.now }, deps);

/**
 * The cron's maker, or undefined when no opening can be written or would be posted: no ANTHROPIC_API_KEY, or no
 * operator channel, the one channel a sending Worker always posts to. A Worker that does not send never asks (deliver.ts).
 */
export function digestOpeningMaker(env: Env): OpeningMaker | undefined {
  if (!env.ANTHROPIC_API_KEY || !env.DISCORD_WEBHOOK_URL) return undefined;
  return openingMakerWith(env.DB, { write: anthropicOpeningWriter(env.ANTHROPIC_API_KEY), read: anthropicOpeningReader(env.ANTHROPIC_API_KEY) });
}
