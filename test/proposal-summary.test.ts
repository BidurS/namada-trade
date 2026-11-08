// Plain summaries of governance proposals (shared/proposal-summary.ts, worker/src/proposal-summaries.ts): what is
// checked before a summary is shown, and what a run asks the model for and stores.
import { describe, it, expect } from 'vitest';
import {
  SUMMARIES_KEY, checkSummary, numbersIn, proposalSourceText, sha256Hex, shownSummary, type StoredSummaries,
} from '../shared/proposal-summary';
import { summarizeProposals, SUMMARY_PER_RUN, type IndexerProposal, type SummarizeFn, type VerifyFn } from '../worker/src/proposal-summaries';
import { kvGetJson, kvSet } from '../worker/src/db';
import { testD1 } from './d1-sqlite';
import { pressure } from '../worker/src/analytics';
import { publicSummary } from '../shared/proposal-summary';
import type { GovernanceProposal } from '../shared/types';

// Proposal #40's shape on the indexer (read 2026-11-08): title, abstract, motivation, details and a link.
const SOURCE = proposalSourceText({
  title: 'Increase the shielded reward rate for USDC',
  abstract: 'Raise the maximum reward rate of USDC in the shielded pool from 0.05 to 0.10, paid from 1,000,000 NAM.',
  motivation: 'More USDC in the shielded pool. See https://forum.namada.net/t/123',
  details: 'Changes the parameter at epoch 2,500.',
});

describe('proposalSourceText', () => {
  it('puts the four parts under headings, in order, and leaves out empty ones and markup', () => {
    const t = proposalSourceText({ title: 'T', details: '<b>D</b> ![img](x.png)', abstract: '', motivation: null });
    expect(t).toBe('Title:\nT\n\nDetails:\nD');
  });
  it('is empty for a proposal with no text', () => {
    expect(proposalSourceText({})).toBe('');
  });
});

describe('numbersIn', () => {
  it('reads numbers with or without commas, and drops a trailing point', () => {
    expect(numbersIn('From 1,000,000 NAM at epoch 2,500. Rate 0.05.')).toEqual(['1000000', '2500', '0.05']);
  });
  it('counts a scale word, so the forms of one number agree and a different scale does not', () => {
    expect(numbersIn('41.8 million, 41.8M and 41,800,000')).toEqual(['41800000', '41800000', '41800000']);
    expect(numbersIn('100k, 5B')).toEqual(['100000', '5000000000']);
  });
});

describe('checkSummary', () => {
  it('passes a plain summary whose numbers are in the text, commas or not', () => {
    const r = checkSummary('It raises the USDC reward rate in the shielded pool from 0.05 to 0.10, paid from 1000000 NAM, at epoch 2,500.', SOURCE);
    expect(r).toEqual({ ok: true, text: 'It raises the USDC reward rate in the shielded pool from 0.05 to 0.10, paid from 1000000 NAM, at epoch 2,500.' });
  });
  it('refuses a number the text does not have: the model never computes one', () => {
    const r = checkSummary('It doubles the rate, a 100% rise, paid from 1,000,000 NAM.', SOURCE);
    expect(r).toEqual({ ok: false, reason: "the number 100 is not in the proposal's text" });
  });
  it('refuses a number at another scale than the text has', () => {
    expect(checkSummary('It sets a 5B limit.', proposalSourceText({ details: 'A limit of 5M.' })))
      .toEqual({ ok: false, reason: "the number 5000000000 is not in the proposal's text" });
    expect(checkSummary('It sets a limit of 5 million.', proposalSourceText({ details: 'A limit of 5M.' })).ok).toBe(true);
  });
  it('refuses advice, judgement, expert words, links, mentions and addresses', () => {
    for (const [s, why] of [
      ['Holders should vote yes on this change.', 'advice'],
      ['A safe change to the reward rate.', 'a judgement'],
      ['More NAM printed for public funding.', 'a judgement'],
      ['It changes the MASP reward rate.', 'an expert word'],
      ['Read more at https://forum.namada.net/t/123.', 'a link or a mention'],
      ['It pings @everyone about the reward rate.', 'a link or a mention'],
      ['It pays tnam1qxt7uxhj9r00mfm4u870e7ghz6j20jrdz58gm5kj.', 'an address'],
      ['It raises max_tx_bytes.', 'a code name'],
      ['It replaces tx_transfer.wasm on the chain.', 'a code name'],
    ] as const) {
      const r = checkSummary(s, SOURCE);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason.startsWith(why), s).toBe(true);
    }
  });
  it('refuses an empty or a long summary', () => {
    expect(checkSummary('   ', SOURCE)).toEqual({ ok: false, reason: 'the model returned no summary' });
    expect(checkSummary('word '.repeat(80), SOURCE).ok).toBe(false);
  });
});

describe('shownSummary', () => {
  it('shows only a summary that passed, named by the model', () => {
    expect(shownSummary({ hash: 'h', text: 'It pays.', status: 'ok', reason: null, model: 'claude-haiku-5-5', at: 5 }))
      .toEqual({ text: 'It pays.', model: 'Claude Haiku 5.5', at: 5 });
    expect(shownSummary({ hash: 'h', text: null, status: 'rejected', reason: 'x', model: 'claude-haiku-5-5', at: 5 })).toBeNull();
    expect(shownSummary(undefined)).toBeNull();
  });
});

const NOW = Date.UTC(2026, 10, 8, 12);
const prop = (id: number, title: string, details = 'Pays 10 NAM.'): IndexerProposal => ({ id, type: 'default', content: { title, details } });

function fakeModel(answers: Record<number, string | Error>): SummarizeFn & { calls: number[]; refusals: (string | undefined)[] } {
  const calls: number[] = [];
  const refusals: (string | undefined)[] = [];
  const fn = (async (id: number, _t: string, _s: string, refused?: string) => {
    calls.push(id);
    refusals.push(refused);
    const a = answers[id] ?? 'It pays 10 NAM.';
    if (a instanceof Error) throw a;
    return { summary: a, inTokens: 2000, outTokens: 60 };
  }) as SummarizeFn & { calls: number[]; refusals: (string | undefined)[] };
  fn.calls = calls;
  fn.refusals = refusals;
  return fn;
}

const readsFine: VerifyFn = async () => ({ supported: true, problem: '', inTokens: 0, outTokens: 0 });

describe('summarizeProposals', () => {
  it('does not show a summary the second reading refuses twice, and asks once more with what it found', async () => {
    const db = testD1() as unknown as D1Database;
    const model = fakeModel({ 30: 'It will pay 10 NAM.' });
    const verify: VerifyFn = async () => ({ supported: false, problem: 'the text only hopes to pay', inTokens: 100, outTokens: 10 });
    await summarizeProposals(db, NOW, model, verify, async () => [prop(30, 'P')]);
    expect(model.refusals).toEqual([undefined, 'the second reading did not find it in the text: the text only hopes to pay']);
    expect((await kvGetJson<StoredSummaries>(db, SUMMARIES_KEY))!['30']).toMatchObject({ status: 'rejected', text: null });
  });

  it('shows the second answer when the reading accepts it', async () => {
    const db = testD1() as unknown as D1Database;
    let n = 0;
    const verify: VerifyFn = async () => ({ supported: n++ > 0, problem: 'stated as settled', inTokens: 0, outTokens: 0 });
    await summarizeProposals(db, NOW, fakeModel({}), verify, async () => [prop(31, 'P')]);
    expect((await kvGetJson<StoredSummaries>(db, SUMMARIES_KEY))!['31']).toMatchObject({ status: 'ok', text: 'It pays 10 NAM.' });
  });

  it('stores and shows nothing when the reading cannot be made, so a later run tries again', async () => {
    const db = testD1() as unknown as D1Database;
    const verify: VerifyFn = async () => { throw new Error('no answer'); };
    expect(await summarizeProposals(db, NOW, fakeModel({}), verify, async () => [prop(32, 'P')])).toEqual({ written: 0, failed: 1, skipped: null });
    expect(await kvGetJson<StoredSummaries>(db, SUMMARIES_KEY)).toBeNull();
  });

  it('counts the summary it paid for when the reading then fails', async () => {
    const db = testD1() as unknown as D1Database;
    const paid: SummarizeFn = async () => ({ summary: 'It pays 10 NAM.', inTokens: 1_000_000, outTokens: 0 });
    await summarizeProposals(db, NOW, paid, async () => { throw new Error('no answer'); }, async () => [prop(33, 'P')]);
    expect((await kvGetJson<{ usd: number }>(db, 'proposal.summaries.spend'))!.usd).toBeCloseTo(0.1);
  });

  it('summarises the newest proposals first, at most SUMMARY_PER_RUN a run, and stores each with its text hash', async () => {
    const db = testD1() as unknown as D1Database;
    const list = [1, 2, 3, 4, 5].map((id) => prop(id, `Proposal ${id}`));
    const model = fakeModel({});
    const r = await summarizeProposals(db, NOW, model, readsFine, async () => list);
    expect(r).toEqual({ written: SUMMARY_PER_RUN, failed: 0, skipped: null });
    expect(model.calls).toEqual([5, 4, 3]);
    const stored = (await kvGetJson<StoredSummaries>(db, SUMMARIES_KEY))!;
    expect(stored['5']).toMatchObject({ text: 'It pays 10 NAM.', status: 'ok', reason: null, model: 'claude-haiku-5-5', at: NOW });
    expect(stored['5'].hash).toBe(await sha256Hex(proposalSourceText(list[4].content)));

    // the next run takes the rest, and a third asks for nothing: a text already summarised is not asked for again
    const next = fakeModel({});
    await summarizeProposals(db, NOW + 1, next, readsFine, async () => list);
    expect(next.calls).toEqual([2, 1]);
    const third = fakeModel({});
    expect(await summarizeProposals(db, NOW + 2, third, readsFine, async () => list)).toEqual({ written: 0, failed: 0, skipped: null });
    expect(third.calls).toEqual([]);
  });

  it('summarises a proposal again when its text changes', async () => {
    const db = testD1() as unknown as D1Database;
    await summarizeProposals(db, NOW, fakeModel({}), readsFine, async () => [prop(7, 'Old title')]);
    const model = fakeModel({ 7: 'It pays 10 NAM under a new title.' });
    await summarizeProposals(db, NOW + 1, model, readsFine, async () => [prop(7, 'New title')]);
    expect(model.calls).toEqual([7]);
    expect((await kvGetJson<StoredSummaries>(db, SUMMARIES_KEY))!['7'].text).toBe('It pays 10 NAM under a new title.');
  });

  it('asks once more with the reason when a check refuses, and shows a second answer that passes', async () => {
    const db = testD1() as unknown as D1Database;
    let n = 0;
    const reasons: (string | undefined)[] = [];
    const model: SummarizeFn = async (_i, _t, _s, refused) => {
      reasons.push(refused);
      return { summary: n++ ? 'It pays 10 NAM for transfers between chains.' : 'It pays 10 NAM for IBC.', inTokens: 1000, outTokens: 50 };
    };
    const r = await summarizeProposals(db, NOW, model, readsFine, async () => [prop(20, 'P')]);
    expect(r).toEqual({ written: 1, failed: 0, skipped: null });
    expect(reasons).toEqual([undefined, 'an expert word ("IBC")']);
    expect((await kvGetJson<StoredSummaries>(db, SUMMARIES_KEY))!['20']).toMatchObject({ status: 'ok', text: 'It pays 10 NAM for transfers between chains.' });
    expect((await kvGetJson<{ usd: number }>(db, 'proposal.summaries.spend'))!.usd).toBeCloseTo((2000 * 0.1 + 100 * 0.5) / 1e6, 12);
  });

  it('does not ask again after an empty answer: the text does not say what the proposal would do', async () => {
    const db = testD1() as unknown as D1Database;
    const model = fakeModel({ 21: '' });
    await summarizeProposals(db, NOW, model, readsFine, async () => [prop(21, 'P')]);
    expect(model.calls).toEqual([21]);
    expect((await kvGetJson<StoredSummaries>(db, SUMMARIES_KEY))!['21']).toMatchObject({ status: 'none', text: null });
  });

  it('stores a summary that fails its check twice as not shown, with why, and does not ask again for the same text', async () => {
    const db = testD1() as unknown as D1Database;
    const twice = fakeModel({ 8: 'It pays 20 NAM.' });
    await summarizeProposals(db, NOW, twice, readsFine, async () => [prop(8, 'P')]);
    expect(twice.calls).toEqual([8, 8]);
    expect(twice.refusals).toEqual([undefined, "the number 20 is not in the proposal's text"]);
    expect((await kvGetJson<StoredSummaries>(db, SUMMARIES_KEY))!['8']).toMatchObject({ text: null, status: 'rejected', reason: "the number 20 is not in the proposal's text" });
    const again = fakeModel({});
    await summarizeProposals(db, NOW + 1, again, readsFine, async () => [prop(8, 'P')]);
    expect(again.calls).toEqual([]);
  });

  it('stores nothing for a call that fails, so a later run tries again', async () => {
    const db = testD1() as unknown as D1Database;
    const r = await summarizeProposals(db, NOW, fakeModel({ 9: new Error('no answer') }), readsFine, async () => [prop(9, 'P')]);
    expect(r).toEqual({ written: 0, failed: 1, skipped: null });
    expect(await kvGetJson<StoredSummaries>(db, SUMMARIES_KEY)).toBeNull();
    const again = fakeModel({});
    await summarizeProposals(db, NOW + 1, again, readsFine, async () => [prop(9, 'P')]);
    expect(again.calls).toEqual([9]);
  });

  it('asks nothing for a proposal with no text or a text too long, and says why', async () => {
    const db = testD1() as unknown as D1Database;
    const model = fakeModel({});
    await summarizeProposals(db, NOW, model, readsFine, async () => [{ id: 10, type: 'default', content: {} }, prop(11, 'P', 'x'.repeat(25_000))]);
    expect(model.calls).toEqual([]);
    const stored = (await kvGetJson<StoredSummaries>(db, SUMMARIES_KEY))!;
    expect(stored['10']).toMatchObject({ status: 'none', text: null });
    expect(stored['11']).toMatchObject({ status: 'too_long', text: null });
  });

  it("makes no call once the month's counted spend reaches the cap, and counts a new month from zero", async () => {
    const db = testD1() as unknown as D1Database;
    await kvSet(db, 'proposal.summaries.spend', { month: '2026-11', usd: 5 });
    const model = fakeModel({});
    const r = await summarizeProposals(db, NOW, model, readsFine, async () => [prop(12, 'P')]);
    expect(r.skipped).toMatch(/cap/);
    expect(model.calls).toEqual([]);
    const dec = await summarizeProposals(db, Date.UTC(2026, 11, 1), model, readsFine, async () => [prop(12, 'P')]);
    expect(dec.written).toBe(1);
    expect(await kvGetJson(db, 'proposal.summaries.spend')).toEqual({ month: '2026-12', usd: (2000 * 0.1 + 60 * 0.5) / 1e6 });
  });
});

describe('the proposals /supply is served', () => {
  const row = (id: number, status: string): GovernanceProposal => ({ id, title: `P${id}`, authors: null, abstract: null, type: 'default', status, startEpoch: 1, endEpoch: 2, activationEpoch: 3, yayNam: 0, nayNam: 0, abstainNam: 0, discussionsUrl: null });
  it('lists the five newest decided apart from the open ones, each with the summary the flag allows', async () => {
    const db = testD1() as unknown as D1Database;
    const list = [row(50, 'voting'), row(49, 'pending'), ...[12, 40, 7, 33, 21, 38, 3].map((id, i) => row(id, i % 2 ? 'rejected' : 'passed'))];
    await kvSet(db, 'intel.cache', { proposals: list, fetchedAt: NOW });
    const stored: StoredSummaries = {
      40: { hash: 'h', text: 'It pays 10 NAM.', status: 'ok', reason: null, model: 'claude-haiku-5-5', at: NOW },
      50: { hash: 'h', text: 'It pays 20 NAM.', status: 'ok', reason: null, model: 'claude-haiku-5-5', at: NOW },
    };
    await kvSet(db, SUMMARIES_KEY, stored);
    const p = await pressure(db as any, NOW, false);
    expect(p.decided!.map((x) => x.id)).toEqual([40, 38, 33, 21, 12]);
    expect(p.proposals.map((x) => x.id)).toEqual([50, 49]);
    for (const x of [...p.proposals, ...p.decided!]) expect(x.summary).toEqual(publicSummary(stored[String(x.id)]));
  });
});
