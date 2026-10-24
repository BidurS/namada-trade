import { describe, expect, it } from 'vitest';
import { buildFlowDiscordBody } from '../worker/src/sources/discord';
import type { Flow } from '../shared/types';

const base: Flow = {
  id: 'osmosis:ABC:0', chain: 'osmosis', height: 1, ts: 1792300000000, txHash: 'ABC', kind: 'ibc_in',
  from: 'tnam1qexample', to: 'osmo1example', amount: 20000,
} as Flow;

describe('owner decision 14: moves found late', () => {
  it('a move from the catch-up search says it was found late, with the time it happened', () => {
    const body = buildFlowDiscordBody({ ...base, meta: { via: 'catch-up search' } } as Flow, {});
    const late = body.embeds[0].fields.find((f) => f.name === 'Found late');
    expect(late?.value).toContain('<t:1792300000:f>');
  });
  it('a move the Namada scan read late, being behind, says it was found late, with the time it happened', () => {
    const body = buildFlowDiscordBody({ ...base, chain: 'namada', kind: 'bond', meta: { via: 'late scan' } } as Flow, {});
    const late = body.embeds[0].fields.find((f) => f.name === 'Found late');
    expect(late?.value).toBe('The live scan was behind and read this move late; it happened <t:1792300000:f> (<t:1792300000:R>).');
  });
  it('another via is no late note', () => {
    const body = buildFlowDiscordBody({ ...base, meta: { via: 'something else' } } as Flow, {});
    expect(body.embeds[0].fields.some((f) => f.name === 'Found late')).toBe(false);
  });
  it('a live move has no late note', () => {
    const body = buildFlowDiscordBody(base, {});
    expect(body.embeds[0].fields.some((f) => f.name === 'Found late')).toBe(false);
  });
  it('the title says so too, so a lock screen does: " · found late" for either way a move is found late, and only then', () => {
    expect(buildFlowDiscordBody({ ...base, meta: { via: 'catch-up search' } } as Flow, {}).embeds[0].title).toBe('20,000 NAM bridged to Osmosis · found late');
    expect(buildFlowDiscordBody({ ...base, chain: 'namada', kind: 'bond', meta: { via: 'late scan' } } as Flow, {}).embeds[0].title).toBe('20,000 NAM staked · found late');
    expect(buildFlowDiscordBody({ ...base, meta: { via: 'something else' } } as Flow, {}).embeds[0].title).toBe('20,000 NAM bridged to Osmosis');
    expect(buildFlowDiscordBody(base, {}).embeds[0].title).toBe('20,000 NAM bridged to Osmosis');
  });
  it('an alert kept for a later alarm says it was sent late, in its title and its field, with the time the move happened', () => {
    const e = buildFlowDiscordBody(base, {}, true).embeds[0];
    expect(e.title).toBe('20,000 NAM bridged to Osmosis · sent late');
    expect(e.fields.find((f) => f.name === 'Found late')?.value).toBe('This alert waited for a later run; it happened <t:1792300000:f> (<t:1792300000:R>).');
    // the embed's time is the move's own, whenever the post went
    expect(e.timestamp).toBe(new Date(base.ts).toISOString());
  });
});
