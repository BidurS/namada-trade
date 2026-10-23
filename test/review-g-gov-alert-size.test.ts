// Security review (2026-10-22), governance alert size: a proposal's discussions-to link is its author's own text,
// which the chain bounds only with the whole proposal (10,000 bytes on mainnet). Discord refuses a whole message
// whose embed url is over 2048 characters or whose description is over 4096, and the alert's claim is taken before
// the post, so a long link could keep every channel from ever hearing of that proposal. An alert carries the link
// only up to GOV_LINK_MAX characters, links the proposal's page otherwise and says so, and a refused post is
// recorded for the health view (kv alerts.skipped).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { testD1 } from './d1-sqlite';
import { fetchGovernanceAndValidators } from '../worker/src/sources/intel';
import { sendDiscordGovAlert, GOV_LINK_MAX } from '../worker/src/sources/discord';
import type { GovernanceProposal } from '../shared/types';

afterEach(() => vi.unstubAllGlobals());

const prop = (id: number, discussionsUrl: string | null, over: Partial<GovernanceProposal> = {}): GovernanceProposal => ({
  id, title: 't', authors: null, abstract: 'a', type: 'default', status: 'pending', startEpoch: 1, endEpoch: 2, activationEpoch: 3,
  yayNam: 0, nayNam: 0, abstainNam: 0, discussionsUrl, ...over,
});

/** Discord's answer to a body with a field over its limit. */
const INVALID_FORM = JSON.stringify({ message: 'Invalid Form Body', code: 50035, errors: { embeds: { 0: { url: { _errors: [{ code: 'BASE_TYPE_MAX_LENGTH', message: 'Must be 2048 or fewer in length.' }] } } } } });

/** Records each webhook body and answers with `status` (a 400 is Discord's Invalid Form Body). */
function hooks(status = 204) {
  const bodies: any[] = [];
  const f = vi.fn(async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(status === 204 ? null : status === 400 ? INVALID_FORM : '{}', { status }); });
  vi.stubGlobal('fetch', f);
  return { f, bodies };
}

/** The characters Discord counts toward an embed's 6000 (title, description, field names and values, footer). */
const counted = (e: any) => (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0)
  + (e.fields ?? []).reduce((n: number, x: any) => n + x.name.length + x.value.length, 0);

/** Every limit Discord sets on an embed that this body could cross. */
function withinDiscordLimits(e: any) {
  expect(e.title.length).toBeLessThanOrEqual(256);
  expect(e.url.length).toBeLessThanOrEqual(2048);
  expect(e.description.length).toBeLessThanOrEqual(4096);
  for (const x of e.fields) { expect(x.name.length).toBeLessThanOrEqual(256); expect(x.value.length).toBeLessThanOrEqual(1024); }
  expect(counted(e)).toBeLessThanOrEqual(6000);
}

describe('governance alert size', () => {
  it('a discussions-to link of 460 euro signs (4173 characters once serialized) is left out and the alert still fits', async () => {
    const long = 'https://forum.namada.net/t/x/1?q=' + '€'.repeat(460);
    vi.stubGlobal('fetch', vi.fn(async (u: string) => String(u).includes('/gov/proposal?page=1')
      ? Response.json({ results: [{ id: 990101, type: 'default', status: 'pending', content: JSON.stringify({ title: 't', abstract: 'a', 'discussions-to': long }) }] })
      : Response.json({})));
    const { proposals } = await fetchGovernanceAndValidators();
    expect(proposals[0].discussionsUrl!.length).toBe(4173);

    const db = testD1();
    const { f, bodies } = hooks();
    await sendDiscordGovAlert('https://discord.com/api/webhooks/1/g59a', proposals[0], true, db as any);
    expect(f).toHaveBeenCalledTimes(1);
    const e = bodies[0].embeds[0];
    withinDiscordLimits(e);
    expect(e.url).toBe('https://namada.valopers.com/proposals/990101');
    expect(e.description).toContain('[View Discussion / Proposal ↗](https://namada.valopers.com/proposals/990101)');
    expect(e.description).toContain('4173 characters long, too long to post here');
    expect(e.description).not.toContain('%E2%82%AC');
  });

  it('a plain ASCII link of 2100 characters, which fits the chain limit, is left out too', async () => {
    const long = 'https://forum.namada.net/t/x/1?q=' + 'a'.repeat(2100 - 33);
    const { bodies } = hooks();
    await sendDiscordGovAlert('https://discord.com/api/webhooks/1/g59b', prop(990102, long, { abstract: null }), true, testD1() as any);
    const e = bodies[0].embeds[0];
    withinDiscordLimits(e);
    expect(e.url).toBe('https://namada.valopers.com/proposals/990102');
    expect(e.description.startsWith('[View Proposal #990102 ↗](https://namada.valopers.com/proposals/990102)')).toBe(true);
  });

  it('the worst case the author controls (a 10 KB title, the longest abstract, a link just inside the bound) stays within every limit', async () => {
    expect(GOV_LINK_MAX).toBeGreaterThanOrEqual(200);
    expect(GOV_LINK_MAX).toBeLessThanOrEqual(2048);
    const edge = 'https://forum.namada.net/t/' + 'x'.repeat(GOV_LINK_MAX - 27);
    expect(edge.length).toBe(GOV_LINK_MAX);
    const { bodies } = hooks();
    await sendDiscordGovAlert('https://discord.com/api/webhooks/1/g59c', prop(990103, edge, { title: '](x'.repeat(3400), abstract: '](x'.repeat(73) + 'z' }), false, testD1() as any);
    const e = bodies[0].embeds[0];
    withinDiscordLimits(e);
    expect(e.url).toBe(edge);
    expect(e.description).not.toContain('too long to post here');
  });

  it('a link one character over the bound is left out', async () => {
    const over = 'https://forum.namada.net/t/' + 'x'.repeat(GOV_LINK_MAX - 26);
    const { bodies } = hooks();
    await sendDiscordGovAlert('https://discord.com/api/webhooks/1/g59d', prop(990104, over), true, testD1() as any);
    expect(bodies[0].embeds[0].url).toBe('https://namada.valopers.com/proposals/990104');
  });

  it('a real forum link is posted exactly as before', async () => {
    const link = 'https://forum.namada.net/t/proposal-to-turn-off-pgf-treasury-inflation/1908';
    const { bodies } = hooks();
    await sendDiscordGovAlert('https://discord.com/api/webhooks/1/g59e', prop(990105, link), true, testD1() as any);
    const e = bodies[0].embeds[0];
    expect(e.url).toBe(link);
    expect(e.description).toBe(`a\n\n[View Discussion / Proposal ↗](${link})`);
    const { bodies: b2 } = hooks();
    await sendDiscordGovAlert('https://discord.com/api/webhooks/1/g59e', prop(990106, null, { abstract: null }), true, testD1() as any);
    expect(b2[0].embeds[0].url).toBe('https://namada.valopers.com/proposals/990106');
    expect(b2[0].embeds[0].description).toBe('[View Proposal #990106 ↗](https://namada.valopers.com/proposals/990106)');
  });

  it('a post Discord refuses (400) is recorded for the health view; a sent one records nothing', async () => {
    const db = testD1();
    hooks(204);
    await sendDiscordGovAlert('https://discord.com/api/webhooks/1/g59f', prop(990107, null), true, db as any);
    expect(db.raw.prepare("SELECT COUNT(*) n FROM kv WHERE key = 'alerts.skipped'").get().n).toBe(0);
    hooks(400);
    await sendDiscordGovAlert('https://discord.com/api/webhooks/1/g59f', prop(990108, null), true, db as any);
    const rec = JSON.parse(db.raw.prepare("SELECT value FROM kv WHERE key = 'alerts.skipped'").get().value);
    expect(rec.total).toBe(1);
    expect(rec.last.n).toBe(1);
    expect(rec.last.what).toContain('proposal 990108 pending');
    expect(rec.last.what).toContain('refused by Discord');
  });
});
