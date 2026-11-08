// POST /api/ask and GET /api/ask: the Ask chat (shared/ask.ts holds the prompts and checks, shared/ask-words.ts the words).
//
// One question is one model call and one second reading, inside about ten seconds, and nothing about it is kept: not
// the question, not the answer, not the address. Only two counters are written, in kv: `ask.day` (questions today,
// UTC) and `ask.spend` (dollars this month from each answer's usage). Without ANTHROPIC_API_KEY, or with ASK_SHOWN off,
// the endpoint answers unavailable.
//
// A call that times out may still be billed and has no usage to count, so ASK_DAY_CAP also bounds the month on its own:
// 500 questions a day are under three minutes apart, the five-minute cache stays warm, and a question costs about $0.0005.
//
// While ASK_SHOWN is off, the cron runs the fixed questions of ASK_SELFTEST once through the same path and keeps the
// answers in kv `ask.selftest`, so real answers can be read before the chat is turned on. Those are the only answers
// ever stored, and no reader's words are among them.
import Anthropic from '@anthropic-ai/sdk';
import {
  ASK_MODEL, ASK_READING_RULES, ASK_READING_SCHEMA, ASK_RULES, ASK_SCHEMA, askFiguresBlock, askReadingMessage, askReferenceText, askRefusal, askUserMessage,
  checkAnswer, cleanHistory, cleanText, figuresUsed, followUpsFor, pagesFrom, type AskFigure,
} from '../../shared/ask';
import { ASK_QUESTION_MAX, ASK_SHOWN, ASK_WORDS, type AskAnswer, type AskState, type AskStatus } from '../../shared/ask-words';
import { HALT } from '../../shared/halt';
import { SUMMARY_MODEL_NAME } from '../../shared/proposal-summary';
import { metricAt } from './analytics';
import { kvGetJson, kvSet } from './db';
import type { Env } from './util';

export const ASK_DAY_KEY = 'ask.day';
export const ASK_SPEND_KEY = 'ask.spend';
/** Questions the whole site may ask in one UTC day. */
export const ASK_DAY_CAP = 500;
/** No call once this month's counted spend reaches this. */
export const ASK_MONTH_CAP_USD = 40;

/** Claude Haiku 5.5, per million tokens: input and output; a cache read is 0.1x the input rate, a five-minute cache write 1.25x. */
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;
const PRICE_CACHE_READ = PRICE_IN * 0.1;
const PRICE_CACHE_WRITE = PRICE_IN * 1.25;

/** The whole request stays under about ten seconds: at most one answer, then its reading, each in its own slot. */
export const ASK_BUDGET_MS = 9_500;
export const ASK_ANSWER_TIMEOUT_MS = 6_000;
export const ASK_READING_TIMEOUT_MS = 3_000;
/** Less time than this left: the reading does not fit, and an answer that was not read is not shown. */
export const ASK_READING_MIN_MS = 1_500;

export interface AskUsage { input: number; output: number; cacheWrite: number; cacheRead: number }
export interface AskCallResult { text: string; stopReason: string | null; usage: AskUsage }
export type AskParams = Anthropic.MessageCreateParamsNonStreaming;
/** One model call: injected, so the tests never reach the API. */
export type AskCall = (params: AskParams, timeoutMs: number) => Promise<AskCallResult>;

export function anthropicAsk(apiKey: string): AskCall {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  return async (params, timeoutMs) => {
    const res = await client.messages.create(params, { timeout: timeoutMs });
    return {
      text: res.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
      stopReason: res.stop_reason,
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheWrite: res.usage.cache_creation_input_tokens ?? 0, cacheRead: res.usage.cache_read_input_tokens ?? 0 },
    };
  };
}

/** The request: the stable reference first, marked for caching; the rules and the current figures after it; no tools. */
export function askParams(rules: string, volatile: string, schema: Record<string, unknown>, user: string): AskParams {
  return {
    model: ASK_MODEL,
    max_tokens: 1024,
    system: [
      { type: 'text', text: askReferenceText(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: `${rules}\n\n${volatile}` },
    ],
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  };
}

export const usageUsd = (u: AskUsage): number => (u.input * PRICE_IN + u.cacheWrite * PRICE_CACHE_WRITE + u.cacheRead * PRICE_CACHE_READ + u.output * PRICE_OUT) / 1e6;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** One more question today, counted in one statement so two at once cannot both read the same count. Returns the new count. */
async function countQuestion(db: D1Database, now: number): Promise<number> {
  const day = dayOf(now);
  const row = await db.prepare(
    `INSERT INTO kv (key,value,updated_at) VALUES (?1, json_object('day',?2,'n',1), ?3)
     ON CONFLICT(key) DO UPDATE SET updated_at=?3,
       value = CASE WHEN json_extract(value,'$.day')=?2 THEN json_set(value,'$.n',json_extract(value,'$.n')+1) ELSE json_object('day',?2,'n',1) END
     RETURNING json_extract(value,'$.n') AS n`,
  ).bind(ASK_DAY_KEY, day, now).first<{ n: number }>();
  return Number(row?.n ?? 1);
}

async function addSpend(db: D1Database, now: number, usd: number): Promise<void> {
  await db.prepare(
    `INSERT INTO kv (key,value,updated_at) VALUES (?1, json_object('month',?2,'usd',?3), ?4)
     ON CONFLICT(key) DO UPDATE SET updated_at=?4,
       value = CASE WHEN json_extract(value,'$.month')=?2 THEN json_set(value,'$.usd',json_extract(value,'$.usd')+?3) ELSE json_object('month',?2,'usd',?3) END`,
  ).bind(ASK_SPEND_KEY, monthOf(now), usd, now).run();
}

async function monthSpent(db: D1Database, now: number): Promise<number> {
  const s = await kvGetJson<{ month: string; usd: number }>(db, ASK_SPEND_KEY);
  return s && s.month === monthOf(now) ? Number(s.usd) : 0;
}
async function dayCount(db: D1Database, now: number): Promise<number> {
  const s = await kvGetJson<{ day: string; n: number }>(db, ASK_DAY_KEY);
  return s && s.day === dayOf(now) ? Number(s.n) : 0;
}

/** Past this age a figure is said to be an older reading. */
const FIGURE_OLD_MS = 30 * 60_000;
const whole = (v: number) => Math.round(v).toLocaleString('en-US');
/** A small set of public figures: the same stored readings the overview answer serves, each with its source and time. */
const FIGURES: { key: string; label: string; source: string; page: string; fmt: (v: number) => string }[] = [
  { key: 'price.usd', label: 'One NAM in US dollars', source: 'Osmosis route quote', page: 'trade', fmt: (v) => String(Number(v.toPrecision(3))) },
  { key: 'supply.total', label: 'All NAM in existence', source: 'Namada node', page: 'supply', fmt: whole },
  { key: 'supply.total_stake', label: 'NAM staked', source: 'Namada node', page: 'supply', fmt: whole },
  { key: 'supply.masp_shielded', label: 'NAM in the shielded pool', source: 'Namada node', page: 'shielded', fmt: whole },
  { key: 'supply.osmosis', label: 'NAM on Osmosis', source: 'Osmosis supply', page: 'supply', fmt: whole },
];

export async function readAskFigures(db: D1Database, now: number): Promise<AskFigure[]> {
  const rows = await Promise.all(FIGURES.map((f) => metricAt(db, f.key, now)));
  return FIGURES.flatMap((f, i) => {
    const r = rows[i];
    return r && Number.isFinite(r.value) ? [{ label: f.label, value: f.fmt(r.value), source: f.source, at: r.ts, old: now - r.ts > FIGURE_OLD_MS, page: f.page }] : [];
  });
}

const plain = (status: AskStatus, text: string): AskAnswer => ({ status, text, pages: [], stamps: [], followUps: [] });
const UNAVAILABLE = plain('unavailable', ASK_WORDS.unavailable);
const REFUSED = plain('refused', ASK_WORDS.refused);
const NOT_COVERED = plain('not_covered', ASK_WORDS.notCovered);
const FAILED = plain('failed', ASK_WORDS.failed);
const INVALID = plain('invalid', ASK_WORDS.invalid);

export interface AskDeps {
  db: D1Database;
  apiKey: string | undefined;
  now: number;
  /** Stands in for the API in tests. */
  call?: AskCall;
  clock?: () => number;
  /** ASK_SHOWN, unless a test asks. */
  shown?: boolean;
}

/** The chat's state for the page: whether to show the chat at all, and whether it is resting. */
export async function askState({ db, apiKey, now, shown = ASK_SHOWN }: Pick<AskDeps, 'db' | 'apiKey' | 'now' | 'shown'>): Promise<AskState> {
  if (!shown || !apiKey) return { state: 'unavailable', text: ASK_WORDS.unavailable };
  if ((await monthSpent(db, now)) >= ASK_MONTH_CAP_USD) return { state: 'resting', text: ASK_WORDS.restingMonth };
  if ((await dayCount(db, now)) >= ASK_DAY_CAP) return { state: 'resting', text: ASK_WORDS.restingDay };
  return { state: 'open', text: '' };
}

/** No error text is logged: it could carry a part of the prompt or the question. Only that a call failed, and its status. */
function logFailure(what: string, e: unknown): void {
  const status = (e as { status?: unknown })?.status;
  console.error(`ask: ${what}${typeof status === 'number' ? ` (status ${status})` : ''}`);
}

export async function answerAsk(body: unknown, deps: AskDeps): Promise<{ http: number; answer: AskAnswer }> {
  const { db, apiKey, now, shown = ASK_SHOWN, clock = Date.now } = deps;
  if (!shown || !apiKey) return { http: 503, answer: UNAVAILABLE };
  const call = deps.call ?? anthropicAsk(apiKey);

  const b = (body ?? {}) as { question?: unknown; history?: unknown };
  if (typeof b.question !== 'string') return { http: 400, answer: INVALID };
  const question = cleanText(b.question);
  if (!question || question.length > ASK_QUESTION_MAX) return { http: 400, answer: INVALID };

  // Refused before anything is spent or counted.
  const why = askRefusal(question);
  if (why === 'injection') return { http: 200, answer: NOT_COVERED };
  if (why) return { http: 200, answer: REFUSED };

  if ((await monthSpent(db, now)) >= ASK_MONTH_CAP_USD) return { http: 200, answer: plain('resting', ASK_WORDS.restingMonth) };
  if ((await countQuestion(db, now)) > ASK_DAY_CAP) return { http: 200, answer: plain('resting', ASK_WORDS.restingDay) };

  const started = clock();
  const history = cleanHistory(b.history);
  const figures = await readAskFigures(db, now);
  const volatile = askFiguresBlock(figures, HALT.on ? `${HALT.title}. ${HALT.here}` : null);

  let raw: AskCallResult;
  try {
    raw = await call(askParams(ASK_RULES, volatile, ASK_SCHEMA as unknown as Record<string, unknown>, askUserMessage(question, history)), ASK_ANSWER_TIMEOUT_MS);
  } catch (e) {
    logFailure('the answer call failed', e);
    return { http: 200, answer: FAILED };
  }
  await addSpend(db, now, usageUsd(raw.usage));
  if (raw.stopReason === 'refusal' || raw.stopReason === 'max_tokens') return { http: 200, answer: FAILED };

  let parsed: { answer?: unknown; pages?: unknown; answerable?: unknown };
  try { parsed = JSON.parse(raw.text); } catch { return { http: 200, answer: FAILED }; }
  if (parsed?.answerable === false) return { http: 200, answer: NOT_COVERED };
  if (parsed?.answerable !== true || typeof parsed.answer !== 'string') return { http: 200, answer: FAILED };

  const pages = pagesFrom(parsed.pages);
  const check = checkAnswer(parsed.answer, figures);
  if (!check.ok || !pages.length) return { http: 200, answer: FAILED };

  // The second reading, when it fits; an answer that could not be read is not shown.
  const left = started + ASK_BUDGET_MS - clock();
  if (left < ASK_READING_MIN_MS) return { http: 200, answer: FAILED };
  try {
    const read = await call(askParams(ASK_READING_RULES, volatile, ASK_READING_SCHEMA as unknown as Record<string, unknown>, askReadingMessage(check.text)), Math.min(ASK_READING_TIMEOUT_MS, left));
    await addSpend(db, now, usageUsd(read.usage));
    if (read.stopReason === 'refusal' || read.stopReason === 'max_tokens' || JSON.parse(read.text)?.supported !== true) return { http: 200, answer: FAILED };
  } catch (e) {
    logFailure('the second reading failed', e);
    return { http: 200, answer: FAILED };
  }

  const stamps = figuresUsed(figures, check.text).map(({ label, source, at, old }) => ({ label, source, at, old }));
  return { http: 200, answer: { status: 'answered', text: check.text, pages, stamps, followUps: followUpsFor(pages, [question, ...history.map((t) => t.q)]), model: SUMMARY_MODEL_NAME, at: now } };
}

/** Fixed questions for the one review run: common ones, a follow-up, and ones the chat must decline. */
export const ASK_SELFTEST: { question: string; history?: { q: string; a: string }[] }[] = [
  { question: 'What is the shielded pool?' },
  { question: 'How does staking work on Namada?' },
  { question: 'How long does unstaking take?' },
  { question: 'What is the price of NAM right now?' },
  { question: 'How much NAM is staked?' },
  { question: 'How do I buy NAM?' },
  { question: 'Where can NAM be traded?' },
  { question: 'Is the Namada network running?' },
  { question: 'How does it work?', history: [{ q: 'What is the shielded pool?', a: 'The shielded pool holds NAM and other coins whose owners and amounts are hidden.' }] },
  { question: 'Which validator pays the most?' },
  { question: 'Will NAM go up next month?' },
  { question: 'Who owns the largest shielded balance?' },
  { question: 'What is the weather in Paris?' },
];
const SELFTEST_KEY = 'ask.selftest';
/** Questions a tick asks at most: two, about twenty seconds at the very worst, so a tick is never held for long. */
const SELFTEST_PER_TICK = 2;

export interface AskSelfTestRow { question: string; status: string; text: string; pages: string[]; ms: number }

/** One tick of the review run. Never throws; stops for good once every question has an answer on record. */
export async function runAskSelfTest(env: Pick<Env, 'DB' | 'ANTHROPIC_API_KEY'>, now: number, opts: { call?: AskCall; shown?: boolean; clock?: () => number } = {}): Promise<void> {
  const { call, shown = ASK_SHOWN, clock = Date.now } = opts;
  if (shown || !env.ANTHROPIC_API_KEY) return;
  try {
    const rows = (await kvGetJson<AskSelfTestRow[]>(env.DB, SELFTEST_KEY)) ?? [];
    if (rows.length >= ASK_SELFTEST.length) return;
    for (const t of ASK_SELFTEST.slice(rows.length, rows.length + SELFTEST_PER_TICK)) {
      const t0 = clock();
      const { answer } = await answerAsk(t, { db: env.DB, apiKey: env.ANTHROPIC_API_KEY, now, shown: true, call, clock });
      rows.push({ question: t.question, status: answer.status, text: answer.text, pages: answer.pages.map((p) => p.id), ms: clock() - t0 });
    }
    await kvSet(env.DB, SELFTEST_KEY, rows);
  } catch {
    console.error('ask: the review run failed this tick');
  }
}
