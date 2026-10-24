// Governance and forum cards: a proposal's state or outcome in the title ("New proposal" only while it is open), its
// status in plain words, the votes with their shares as Supply shows them (Yes and No), the epochs with the current
// one and clock times ahead only as estimates (late by up to one epoch), Supply's votes link only while Supply lists
// the proposal; a forum post's topic, opening words, author and category, every outsider's text shown as text.
import { describe, it, expect } from 'vitest';
import { fits, forumCard, govCard, COLOUR } from '../worker/src/sources/discord';
import { proposalStatusWords } from '../shared/flow-words';
import { BANNED } from './banned-words';
import type { ForumPost, GovernanceProposal } from '../shared/types';

const READ = Date.UTC(2026, 9, 23, 15, 41);
const EPOCH_SEC = 21636;
const g = { nowEpoch: 2698, epochSec: EPOCH_SEC, epochNote: 'about 6.01 h an epoch, measured over the last 31 epochs', readAt: READ };
const prop = (over: Partial<GovernanceProposal> = {}): GovernanceProposal => ({
  id: 43, title: 'Raise the minimum stake', authors: 'Someone', abstract: 'A short abstract.', type: 'default_with_wasm', status: 'pending',
  startEpoch: 2700, endEpoch: 2740, activationEpoch: 2745, yayNam: 0, nayNam: 0, abstainNam: 0, discussionsUrl: 'https://forum.namada.net/t/raise/1999', ...over,
});
const embed = (p: GovernanceProposal, isNew: boolean) => fits(govCard(p, isNew, g));
const at = (e: number) => Math.floor((READ + (e - g.nowEpoch) * EPOCH_SEC * 1000) / 1000);

describe('a governance proposal', () => {
  it('a new pending one: no votes yet, and when voting opens and closes, each an estimate said to be late by up to one epoch', () => {
    const e = embed(prop(), true);
    expect(e.title).toBe('New proposal 43: Raise the minimum stake');
    const d = String(e.description);
    expect(d.split('\n')[0]).toBe('Voting not started. No votes cast yet.');
    expect(d).toContain(`Code change by Someone · voting epochs 2,700 to 2,740, now epoch 2,698 · voting opens around <t:${at(2700)}:D> and closes around <t:${at(2740)}:D> (estimate, late by up to one epoch: about 6.01 h an epoch, measured over the last 31 epochs).`);
    expect(d).toContain('[Votes on NamadaTrade](https://namada.trade/supply)');
    expect(e.author).toEqual({ name: 'Governance · indexer.namada.net', url: 'https://namada.trade/supply' });
    expect(e.color).toBe(COLOUR.governance);
    expect(e.timestamp).toBe(new Date(READ).toISOString());
    expect(e.footer!.text).toBe('NamadaTrade · status and votes as read from indexer.namada.net');
  });
  it('voting now: when it closes; the shares of Yes and No as Supply prints them, Abstain with no share', () => {
    const e = embed(prop({ status: 'voting', startEpoch: 2690, yayNam: 7_953_841, nayNam: 12_439, abstainNam: 14_870_410 }), false);
    expect(e.title).toBe('Voting opened on proposal 43: Raise the minimum stake');
    const d = String(e.description);
    expect(d.split('\n')[0]).toBe('Voting now. Yes 7,953,841 NAM (34.8%), no 12,439 NAM (0.1%), abstain 14,870,410 NAM, of 22,836,690 NAM voted.');
    expect(d).toContain(`now epoch 2,698 · voting closes around <t:${at(2740)}:D> (estimate`);
    expect(d).not.toContain(':R>');
    expect(e.fields).toEqual([
      { name: 'Yes', value: '7,953,841 NAM (34.8%)', inline: true },
      { name: 'No', value: '12,439 NAM (0.1%)', inline: true },
      { name: 'Abstain', value: '14,870,410 NAM', inline: true },
    ]);
  });
  it('an executed rejection reads "rejected", with no clock time and no link to Supply, which no longer lists it', () => {
    const e = embed(prop({ status: 'executedRejected', startEpoch: 1827, endEpoch: 1867, yayNam: 7_953_841, nayNam: 12_439, abstainNam: 14_870_410 }), false);
    expect(e.title).toBe('Proposal 43 rejected: Raise the minimum stake');
    expect(String(e.description).split('\n')[0]).toMatch(/^Rejected\. Yes 7,953,841 NAM \(34\.8%\)/);
    expect(String(e.description)).not.toContain('<t:');
    expect(String(e.description)).not.toContain('namada.trade/supply');
    expect(e.author).toEqual({ name: 'Governance · indexer.namada.net' });
    expect(String(e.description)).toContain('[Discussion on forum.namada.net](https://forum.namada.net/t/raise/1999) · [Proposal 43 on namada.valopers.com](https://namada.valopers.com/proposals/43)');
  });
  it('a proposal first read past its vote is titled by its outcome, never "New proposal"', () => {
    expect(embed(prop({ status: 'executedPassed', yayNam: 1 }), true).title).toBe('Proposal 43 passed and executed: Raise the minimum stake');
    expect(embed(prop({ status: 'passed', yayNam: 1 }), true).title).toBe('Proposal 43 passed: Raise the minimum stake');
  });
  it('the status in the words Supply uses too', () => {
    expect(proposalStatusWords('executedRejected')).toBe('Rejected');
    expect(proposalStatusWords('executedPassed')).toBe('Passed and executed');
    expect(proposalStatusWords('pending')).toBe('Voting not started');
    expect(proposalStatusWords('votingPeriod')).toBe('Voting now');
  });
  it('the author\'s text is shown as text: no masked link, no markdown, no mention', () => {
    const e = embed(prop({ title: 'x [y](https://evil.invalid) **z**', authors: '@everyone <@1> [a](https://evil.invalid)', abstract: '> # [b](https://evil.invalid) _c_' }), true);
    const all = JSON.stringify(e);
    expect(all).not.toContain('](https://evil');
    expect(String(e.description)).not.toMatch(/(^|[^\\])<@1>/);
    for (const t of [e.title, e.description, e.author!.name, e.footer!.text]) expect(t).not.toMatch(BANNED);
  });
});

describe('a forum post', () => {
  const post = (over: Partial<ForumPost> = {}): ForumPost => ({
    id: 5001, topicId: 1950, topicTitle: 'A topic', topicSlug: 'a-topic', postNumber: 6, url: 'https://forum.namada.net/t/a-topic/1950/6',
    username: 'someone', displayName: 'Some One', avatarUrl: null, createdAt: '2026-10-13T11:43:58.023Z', excerpt: 'The opening words of the post.', isNewTopic: false, ...over,
  });
  it('the topic in the title, the opening words first, then who wrote it and when; the category above the title', () => {
    const e = fits(forumCard(post(), 'General'));
    expect(e.author).toEqual({ name: 'Forum · General', url: 'https://forum.namada.net' });
    expect(e.title).toBe('Reply 6 in: A topic');
    expect(e.description).toBe(`The opening words of the post.\n\nBy Some One (@someone) · <t:${Math.floor(Date.parse('2026-10-13T11:43:58.023Z') / 1000)}:R> · [Read on forum.namada.net](https://forum.namada.net/t/a-topic/1950/6)`);
    expect(e.color).toBe(COLOUR.forum);
    expect(fits(forumCard(post({ isNewTopic: true, postNumber: 1 }), null)).title).toBe('New topic: A topic');
    expect(fits(forumCard(post(), null)).author!.name).toBe('Forum · forum.namada.net');
  });
  it('names, category and excerpt are kept to their bounds, so a body is never refused for them', () => {
    const e = fits(forumCard(post({ displayName: 'D'.repeat(5000), username: 'u'.repeat(5000), topicTitle: 'T'.repeat(10_000), excerpt: 'e'.repeat(50_000) }), 'C'.repeat(5000)));
    expect(e.author!.name.length).toBeLessThanOrEqual(256);
    expect(e.title!.length).toBeLessThanOrEqual(256);
    expect(e.description!.length).toBeLessThan(600);
    expect(e.description).toContain(`By ${'D'.repeat(79)}… (@${'u'.repeat(59)}…)`);
  });
  it('a link that is not http(s) is no link', () => {
    const e = fits(forumCard(post({ url: 'javascript:alert(1)' }), null));
    expect(e.url).toBeUndefined();
    expect(String(e.description)).not.toContain('javascript:');
  });
});
