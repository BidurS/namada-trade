// Alert rules (decision D7). Pure functions over flows so the Worker, the UI and the
// replay harness evaluate exactly the same logic.
//
// Titles, conditions and hit texts are plain words (W9, brief section 4: "NAM bridged to Osmosis",
// "NAM unstaked", "Large trade", "NAM left the shielded set", "Large amount staked"). Rule ids, thresholds
// and every test() are unchanged, so `npm run test:replay` gives the same report.
import type { AlertHit, AlertRuleInfo, Flow } from './types';

/** As shared/flow-rules.ts explorerHashOf (copied: this file is also run by Node directly, in scripts/export-proof.ts,
    and must not import other modules' values). */
const explorerHashOf = (f: { txHash: string; meta?: Record<string, unknown> | null }): string => {
  const w = f.meta?.wrapper;
  return typeof w === 'string' && /^[0-9a-fA-F]{64}$/.test(w) ? w.toUpperCase() : f.txHash;
};

export const INTERNAL_ADDRESSES = {
  pos: 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp',
  ibc: 'tnam1qcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvtr7x4',
  masp: 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah',
  pgf: 'tnam1pgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkhgajr',
  governance: 'tnam1q5qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrw33g6',
  osmoTransfer: 'osmo1yl6hdjhmkf37639730gffanpzndzdpmhxy9ep3',
} as const;

const INTERNAL = new Set<string>(Object.values(INTERNAL_ADDRESSES));
export const isInternal = (a: string | null | undefined) => !!a && INTERNAL.has(a);

export interface AlertThresholds {
  ibcInventory: number;
  unlock: number;
  bigSwap: number;
  unshield: number;
  bond: number;
}

/** Defaults in NAM. Small on purpose: NAM trades in thin pools, so these sizes already move the price. */
export const DEFAULT_THRESHOLDS: AlertThresholds = {
  ibcInventory: 25_000,
  unlock: 100_000,
  bigSwap: 10_000,
  unshield: 50_000,
  bond: 1_000_000,
};

interface Rule {
  id: string;
  title: string;
  decision: string;
  key: keyof AlertThresholds;
  condition: (t: number) => string;
  test: (f: Flow, t: number) => { title: string; detail: string; address: string | null } | null;
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const short = (a: string | null | undefined, label?: string | null) =>
  label ? label : a ? `${a.slice(0, 10)}…${a.slice(-4)}` : '—';
/** The label as the site shows it when the Worker supplied one (worker/src/labels.ts), else the raw label. */
const from = (f: Flow) => short(f.from, f.fromLabelPlain ?? f.fromLabel);
const to = (f: Flow) => short(f.to, f.toLabelPlain ?? f.toLabel);

const RULES: Rule[] = [
  {
    id: 'ibc_inventory',
    title: 'NAM bridged to Osmosis',
    decision: 'D2',
    key: 'ibcInventory',
    condition: (t) => `${fmt(t)} NAM or more crossed from Namada to Osmosis in one transfer`,
    test: (f, t) =>
      f.chain === 'osmosis' && f.kind === 'ibc_in' && f.amount >= t
        ? { title: `${fmt(f.amount)} NAM bridged to Osmosis`, detail: `to ${to(f)} from ${from(f)}`, address: f.to }
        : null,
  },
  {
    id: 'unlock',
    title: 'NAM unstaked',
    decision: 'D3',
    key: 'unlock',
    condition: (t) => `${fmt(t)} NAM or more started unstaking, or finished unstaking and was withdrawn`,
    test: (f, t) =>
      f.chain === 'namada' && (f.kind === 'withdraw' || f.kind === 'unbond') && f.amount >= t
        ? { title: `${fmt(f.amount)} NAM ${f.kind === 'unbond' ? 'started unstaking (spendable when the wait ends)' : 'unlocked and withdrawn from staking'}`, detail: `by ${to(f)}`, address: f.to }
        : null,
  },
  {
    id: 'big_swap',
    title: 'Large trade',
    decision: 'D4',
    key: 'bigSwap',
    condition: (t) => `A single buy or sell of ${fmt(t)} NAM or more on Osmosis, bot trades left out`,
    test: (f, t) =>
      f.chain === 'osmosis' && (f.kind === 'buy' || f.kind === 'sell') && f.amount >= t && !f.meta?.arb
        ? {
            title: `${f.kind === 'buy' ? 'Bought' : 'Sold'} ${fmt(f.amount)} NAM${f.priceUsd ? ` at $${f.priceUsd.toFixed(6)}` : ''}`,
            detail: f.kind === 'buy' ? to(f) : from(f),
            address: f.kind === 'buy' ? f.to : f.from,
          }
        : null,
  },
  {
    id: 'unshield',
    title: 'NAM left the shielded set',
    decision: 'D5',
    key: 'unshield',
    condition: (t) => `${fmt(t)} NAM or more moved out of the shielded set to a personal address`,
    test: (f, t) =>
      f.chain === 'namada' && f.kind === 'unshield' && f.amount >= t && !isInternal(f.to)
        ? { title: `${fmt(f.amount)} NAM moved out of the shielded set`, detail: `to ${to(f)}`, address: f.to }
        : null,
  },
  {
    id: 'bond',
    title: 'Large amount staked',
    decision: 'D3',
    key: 'bond',
    condition: (t) => `${fmt(t)} NAM or more staked in one transaction`,
    test: (f, t) =>
      f.chain === 'namada' && f.kind === 'bond' && f.amount >= t
        ? { title: `${fmt(f.amount)} NAM staked`, detail: `by ${from(f)}`, address: f.from }
        : null,
  },
];

export function alertRules(th: AlertThresholds = DEFAULT_THRESHOLDS): AlertRuleInfo[] {
  return RULES.map((r) => ({ id: r.id, title: r.title, decision: r.decision, condition: r.condition(th[r.key]), thresholdNam: th[r.key] }));
}

export function evaluateFlow(f: Flow, th: AlertThresholds = DEFAULT_THRESHOLDS): AlertHit[] {
  const hits: AlertHit[] = [];
  for (const r of RULES) {
    const m = r.test(f, th[r.key]);
    if (m) hits.push({ ruleId: r.id, ts: f.ts, flowId: f.id, chain: f.chain, explorerHash: explorerHashOf(f), title: m.title, detail: m.detail, amountNam: f.amount, address: m.address });
  }
  return hits;
}

export function evaluateFlows(flows: Flow[], th: AlertThresholds = DEFAULT_THRESHOLDS): AlertHit[] {
  return flows.flatMap((f) => evaluateFlow(f, th)).sort((a, b) => b.ts - a.ts);
}
