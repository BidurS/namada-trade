// Short plain summaries of Namada governance proposals (shared/proposal-summary.ts says what is written and checked).
//
// Once every SUMMARY_EVERY_MS the cron's tick reads every proposal from the Namada indexer (all its pages, its full
// text, which the alerts' reading cuts to 220 characters), and summarises up to SUMMARY_PER_RUN of those with no
// summary for their current text, newest first. Each summary is stored in kv `proposal.summaries` under the
// proposal's id with the sha-256 of the text it was written from, so a proposal is summarised once, and again only if
// its text changes. A summary that fails a check is stored as such (not shown, and not asked for again for the same
// text); a call that fails (no answer, a refusal, an error) stores nothing and is tried at a later run.
//
// Without ANTHROPIC_API_KEY (a Worker secret) nothing runs. The month's spend is counted in kv `proposal.summaries.spend`
// from each answer's usage, and no call is made once it reaches SUMMARY_MONTH_CAP_USD.
import Anthropic from '@anthropic-ai/sdk';
import {
  SOURCE_MAX_CHARS, SUMMARIES_KEY, SUMMARY_MODEL, SUMMARY_SCHEMA, SUMMARY_SYSTEM, VERIFY_SCHEMA, VERIFY_SYSTEM, checkSummary, proposalSourceText, sha256Hex, summaryPrompt, verifyPrompt,
  type StoredSummaries, type StoredSummary,
} from '../../shared/proposal-summary';
import { kvGetJson, kvSet } from './db';
import { fetchJson, type Env } from './util';

const INDEXER = 'https://indexer.namada.net/api/v1';
const RUN_KEY = 'proposal.summaries.run';
const SPEND_KEY = 'proposal.summaries.spend';

/** How often the proposals are read for new text: new proposals are rare, and a summary waits half an hour at most. */
export const SUMMARY_EVERY_MS = 30 * 60_000;
/** Summaries written in one run at most, so a first run over every past proposal is spread over several. */
export const SUMMARY_PER_RUN = 3;
/** The indexer's pages read at most (30 proposals a page; 43 proposals on 2026-11-08). */
const MAX_PAGES = 5;
/** Claude Haiku 5.5's prices per million tokens (prompts under 100,000 tokens), for the month's count. */
const PRICE_IN = 0.1;
const PRICE_OUT = 0.5;
/** No call once the month's counted spend reaches this. */
export const SUMMARY_MONTH_CAP_USD = 5;
/**
 * The run holds the tick's lock until it ends (cron.ts), so it ends at the tick's deadline: the indexer's pages and
 * every model call take the tick's signal. Within that, one attempt of at most CALL_TIMEOUT_MS a call, four calls a
 * proposal at most (a summary and its reading, twice), and no proposal started after RUN_BUDGET_MS.
 */
const CALL_TIMEOUT_MS = 12_000;
const RUN_BUDGET_MS = 15_000;

export interface IndexerProposal { id: number; type: string; content: Record<string, unknown> }

/** One model call: the summary it returned (may be empty), and its tokens. Throws when there is no usable answer. */
export type SummarizeFn = (id: number, type: string, source: string, refused?: string) => Promise<{ summary: string; inTokens: number; outTokens: number }>;

/** The second reading of a summary against the text. Throws when there is no usable answer: nothing unread is shown. */
export type VerifyFn = (source: string, summary: string) => Promise<{ supported: boolean; problem: string; inTokens: number; outTokens: number }>;

export function anthropicVerifier(apiKey: string, signal?: AbortSignal): VerifyFn {
  const client = new Anthropic({ apiKey, timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
  return async (source, summary) => {
    const res = await client.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 1024,
      system: VERIFY_SYSTEM,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: VERIFY_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: 'user', content: verifyPrompt(source, summary) }],
    }, { signal });
    if (res.stop_reason === 'refusal') throw new Error('the model declined the reading');
    if (res.stop_reason === 'max_tokens') throw new Error('the reading was cut off');
    let parsed: { supported?: unknown; problem?: unknown };
    try { parsed = JSON.parse(res.content.map((b) => (b.type === 'text' ? b.text : '')).join('')); } catch { throw new Error('the reading was not the asked shape'); }
    if (typeof parsed?.supported !== 'boolean') throw new Error('the reading had no verdict');
    return { supported: parsed.supported, problem: String(parsed.problem ?? '').slice(0, 200), inTokens: res.usage.input_tokens, outTokens: res.usage.output_tokens };
  };
}

/** The model call through the Anthropic SDK: structured output, low effort, one attempt (a failed call waits for the next run). */
export function anthropicSummarizer(apiKey: string, signal?: AbortSignal): SummarizeFn {
  const client = new Anthropic({ apiKey, timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
  return async (id, type, source, refused) => {
    const res = await client.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 1024,
      system: SUMMARY_SYSTEM,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SUMMARY_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: 'user', content: summaryPrompt(id, type, source, refused) }],
    }, { signal });
    if (res.stop_reason === 'refusal') throw new Error('the model declined');
    if (res.stop_reason === 'max_tokens') throw new Error('the answer was cut off');
    const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error('the answer was not the asked shape'); }
    const summary = (parsed as { summary?: unknown })?.summary;
    if (typeof summary !== 'string') throw new Error('the answer had no summary');
    return { summary, inTokens: res.usage.input_tokens, outTokens: res.usage.output_tokens };
  };
}

/** Every proposal on the indexer with its full text (the content field is JSON text on the indexer). */
export async function readAllProposals(fetcher: typeof fetchJson = fetchJson, signal?: AbortSignal): Promise<IndexerProposal[]> {
  const out: IndexerProposal[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetcher<any>(`${INDEXER}/gov/proposal?page=${page}`, { timeoutMs: 8000, retries: 1, signal });
    for (const p of r?.results ?? []) {
      let content: Record<string, unknown> = {};
      try { content = typeof p.content === 'string' ? JSON.parse(p.content) : p.content ?? {}; } catch { content = {}; }
      if (Number.isFinite(Number(p.id))) out.push({ id: Number(p.id), type: String(p.type ?? 'default'), content });
    }
    const total = Number(r?.pagination?.totalPages ?? 1);
    if (page >= total) break;
  }
  return out;
}

/**
 * The model's summary and the verdict on it: the word and number checks, then the second reading against the text. A
 * summary refused by either is asked for once more with the reason, and the second answer stands: both hold for it
 * just the same.
 */
export async function summarizeChecked(summarize: SummarizeFn, verify: VerifyFn, id: number, type: string, source: string, tally = { in: 0, out: 0 }) {
  const attempt = async (refused?: string) => {
    const r = await summarize(id, type, source, refused);
    tally.in += r.inTokens; tally.out += r.outTokens;
    let check = checkSummary(r.summary, source);
    if (check.ok) {
      const v = await verify(source, check.text);
      tally.in += v.inTokens; tally.out += v.outTokens;
      if (!v.supported) check = { ok: false, reason: `the second reading did not find it in the text: ${v.problem || 'no reason given'}` };
    }
    return { summary: r.summary, check };
  };
  let a = await attempt();
  if (!a.check.ok && a.summary.trim()) a = await attempt(a.check.reason);
  return { ...a, inTokens: tally.in, outTokens: tally.out };
}

const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/**
 * One run: the proposals whose text has no summary yet (or a different one), newest first, up to SUMMARY_PER_RUN.
 * Returns what it did, for the log and the tests.
 */
export async function summarizeProposals(
  db: D1Database,
  now: number,
  summarize: SummarizeFn,
  verify: VerifyFn,
  read: () => Promise<IndexerProposal[]> = () => readAllProposals(),
  clock: () => number = Date.now,
): Promise<{ written: number; failed: number; skipped: string | null }> {
  const spend = (await kvGetJson<{ month: string; usd: number }>(db, SPEND_KEY)) ?? { month: monthOf(now), usd: 0 };
  if (spend.month !== monthOf(now)) { spend.month = monthOf(now); spend.usd = 0; }
  if (spend.usd >= SUMMARY_MONTH_CAP_USD) return { written: 0, failed: 0, skipped: `the month's cap of $${SUMMARY_MONTH_CAP_USD} is reached` };

  const proposals = await read();
  const stored: StoredSummaries = (await kvGetJson<StoredSummaries>(db, SUMMARIES_KEY)) ?? {};
  const todo: { p: IndexerProposal; source: string; hash: string }[] = [];
  for (const p of [...proposals].sort((a, b) => b.id - a.id)) {
    const source = proposalSourceText(p.content);
    const hash = await sha256Hex(source);
    if (stored[String(p.id)]?.hash === hash) continue;
    todo.push({ p, source, hash });
  }

  let written = 0, failed = 0;
  const started = clock();
  for (const { p, source, hash } of todo) {
    if (written + failed >= SUMMARY_PER_RUN || spend.usd >= SUMMARY_MONTH_CAP_USD || clock() - started > RUN_BUDGET_MS) break;
    const base = { hash, model: SUMMARY_MODEL, at: now };
    let entry: StoredSummary;
    if (!source) entry = { ...base, text: null, status: 'none', reason: 'the proposal has no text' };
    else if (source.length > SOURCE_MAX_CHARS) entry = { ...base, text: null, status: 'too_long', reason: `the proposal's text is longer than ${SOURCE_MAX_CHARS} characters` };
    else {
      // counted on every path: a reading that fails comes after a summary that was paid for
      const tally = { in: 0, out: 0 };
      try {
        const r = await summarizeChecked(summarize, verify, p.id, p.type, source, tally);
        const c = r.check;
        entry = c.ok ? { ...base, text: c.text, status: 'ok', reason: null }
          : { ...base, text: null, status: r.summary.trim() ? 'rejected' : 'none', reason: c.reason };
      } catch (e) {
        failed++;
        console.error(`proposal summary #${p.id}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
        continue;
      } finally {
        spend.usd += (tally.in * PRICE_IN + tally.out * PRICE_OUT) / 1e6;
      }
    }
    stored[String(p.id)] = entry;
    written++;
  }
  if (written) await kvSet(db, SUMMARIES_KEY, stored);
  await kvSet(db, SPEND_KEY, spend);
  return { written, failed, skipped: null };
}

/** The cron's step: at most once every SUMMARY_EVERY_MS, and only with a key. Never throws. */
export async function runProposalSummaries(env: Env, now: number, signal?: AbortSignal): Promise<void> {
  if (!env.ANTHROPIC_API_KEY) return;
  try {
    const last = Number((await kvGetJson<{ at: number }>(env.DB, RUN_KEY))?.at ?? 0);
    if (now - last < SUMMARY_EVERY_MS) return;
    await kvSet(env.DB, RUN_KEY, { at: now });
    const r = await summarizeProposals(env.DB, now, anthropicSummarizer(env.ANTHROPIC_API_KEY, signal), anthropicVerifier(env.ANTHROPIC_API_KEY, signal), () => readAllProposals(fetchJson, signal));
    console.log(`proposal summaries: ${r.written} written, ${r.failed} failed${r.skipped ? `, skipped: ${r.skipped}` : ''}`);
  } catch (e) {
    console.error('proposal summaries', e);
  }
}
