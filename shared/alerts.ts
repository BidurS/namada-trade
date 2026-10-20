// Alert rules (decision D7). Pure functions over flows so the Worker, the UI and the
// replay harness evaluate exactly the same logic.
//
// Titles, conditions and hit texts are plain words (W9, brief section 4: "NAM bridged to Osmosis",
// "NAM unstaked", "Large trade", "NAM left the shielded set", "Large amount staked"). Rule ids, thresholds
// and every test() are unchanged, so `npm run test:replay` gives the same report.
import type { AlertHit, AlertRuleInfo, Flow, MaspPassthroughLink } from './types';

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

/**
 * Scale `bigSwap` and `ibcInventory` thresholds dynamically against the active reference pool NAM reserve
 * (`dex.ref_pool_nam`, Pool 3005), so alerts reflect constant-product / CL price impact rather than a fixed nominal
 * number across regimes. Falls back to `base` when `refPoolNam` is missing or non-positive.
 */
export function liquidityNormalizedThresholds(
  refPoolNam: number | null | undefined,
  base: AlertThresholds = DEFAULT_THRESHOLDS,
): AlertThresholds {
  if (refPoolNam == null || !Number.isFinite(refPoolNam) || refPoolNam <= 0) return { ...base };
  return {
    ...base,
    // 2.5% of active reference pool NAM reserve (~5% constant-product impact), floored at 2,500 NAM
    bigSwap: Math.max(2_500, Math.round(refPoolNam * 0.025)),
    // 6.0% of active reference pool NAM reserve arriving over IBC, floored at 5,000 NAM
    ibcInventory: Math.max(5_000, Math.round(refPoolNam * 0.06)),
  };
}

export interface TraderTurnaround {
  address: string;
  buys: number;
  sells: number;
  buyNam: number;
  sellNam: number;
  netNam: number;
  /** 1 - |buyNam - sellNam| / (buyNam + sellNam) in [0, 1]; 1 = pure round-trip volume */
  turnaroundRatio: number;
  /** True when the trader executes >= minSwaps on both sides with turnaroundRatio >= minTurnaround */
  crossBlockArb: boolean;
}

/**
 * Identify cross-block non-atomic arbitrageurs / solvers on Osmosis whose swaps span multiple blocks (so single-tx
 * `meta.arb` is false) but whose rolling volume round-trips within `windowMs`.
 */
export function detectCrossBlockArbTraders(
  flows: Flow[],
  minSwaps = 6,
  minTurnaround = 0.85,
): Map<string, TraderTurnaround> {
  const byTrader = new Map<string, { buys: number; sells: number; buyNam: number; sellNam: number }>();
  for (const f of flows) {
    if (f.chain !== 'osmosis' || (f.kind !== 'buy' && f.kind !== 'sell')) continue;
    if (f.meta?.arb) continue;
    const addr = f.kind === 'buy' ? f.to : f.from;
    if (!addr) continue;
    const cur = byTrader.get(addr) ?? { buys: 0, sells: 0, buyNam: 0, sellNam: 0 };
    if (f.kind === 'buy') {
      cur.buys++;
      cur.buyNam += f.amount;
    } else {
      cur.sells++;
      cur.sellNam += f.amount;
    }
    byTrader.set(addr, cur);
  }
  const out = new Map<string, TraderTurnaround>();
  for (const [address, s] of byTrader) {
    const gross = s.buyNam + s.sellNam;
    const netNam = s.buyNam - s.sellNam;
    const turnaroundRatio = gross > 0 ? 1 - Math.abs(netNam) / gross : 0;
    const crossBlockArb = s.buys + s.sells >= minSwaps && s.buys > 0 && s.sells > 0 && turnaroundRatio >= minTurnaround;
    out.set(address, { address, ...s, netNam, turnaroundRatio, crossBlockArb });
  }
  return out;
}

/**
 * Detect sub-threshold TWAP execution bursts on Osmosis: a single trader splitting an order into `>= minClips`
 * same-direction swaps within `windowMs`, where individual clips sit below `th.bigSwap` (evading single-flow
 * `evaluateFlow`) while cumulative volume reaches `>= th.bigSwap`. Excludes atomic and cross-block arb bots.
 */
export function detectTwapBursts(
  flows: Flow[],
  th: AlertThresholds = DEFAULT_THRESHOLDS,
  windowMs = 2 * 3600_000,
  minClips = 3,
): AlertHit[] {
  const arbs = detectCrossBlockArbTraders(flows);
  const candidates = flows
    .filter(
      (f) =>
        f.chain === 'osmosis' &&
        (f.kind === 'buy' || f.kind === 'sell') &&
        !f.meta?.arb &&
        f.amount > 0 &&
        f.amount < th.bigSwap,
    )
    .sort((a, b) => a.ts - b.ts);

  const byKey = new Map<string, Flow[]>();
  for (const f of candidates) {
    const addr = f.kind === 'buy' ? f.to : f.from;
    if (!addr || arbs.get(addr)?.crossBlockArb) continue;
    const key = `${addr}:${f.kind}`;
    const list = byKey.get(key) ?? [];
    list.push(f);
    byKey.set(key, list);
  }

  const hits: AlertHit[] = [];
  for (const [, list] of byKey) {
    let i = 0;
    while (i < list.length) {
      let j = i;
      let sumNam = 0;
      while (j < list.length && list[j].ts - list[i].ts <= windowMs) {
        sumNam += list[j].amount;
        j++;
      }
      const clips = j - i;
      if (clips >= minClips && sumNam >= th.bigSwap) {
        const first = list[i];
        const last = list[j - 1];
        const addr = first.kind === 'buy' ? first.to : first.from;
        const mins = Math.max(1, Math.round((last.ts - first.ts) / 60_000));
        const who = first.kind === 'buy' ? to(last) : from(last);
        hits.push({
          ruleId: 'twap_burst',
          ts: last.ts,
          flowId: last.id,
          chain: 'osmosis',
          explorerHash: explorerHashOf(last),
          title: `${first.kind === 'buy' ? 'Bought' : 'Sold'} ${fmt(sumNam)} NAM across ${clips} split clips`,
          detail: `${who} over ${mins}m (sub-threshold TWAP execution)`,
          amountNam: sumNam,
          address: addr,
        });
        i = j; // consume burst so overlapping sub-windows do not double-fire
      } else {
        i++;
      }
    }
  }
  return hits.sort((a, b) => b.ts - a.ts);
}

/**
 * A multi-stage causal trajectory linking supply unlock/unshield on Namada to bridge arrival and DEX execution on
 * Osmosis (Anoma-style partial intent reconstruction).
 */
export interface IntentChain {
  /** Primary Osmosis execution address or Namada origin address */
  entityAddress: string;
  namadaOrigin: string | null;
  osmosisTarget: string | null;
  /** Highest stage reached: 1=Unbond, 2=Withdraw/Unshield, 3=IBC Bridge to Osmosis, 4=DEX Sell/TWAP */
  stage: 1 | 2 | 3 | 4;
  stagesSeen: ('unbond' | 'withdraw_or_unshield' | 'masp_passthrough' | 'burner_hop' | 'ibc_bridge' | 'dex_sell')[];
  firstTs: number;
  lastTs: number;
  unlockedOrUnshieldedNam: number;
  bridgedNam: number;
  soldNam: number;
  /** Calibrated Bayesian posterior probability in [0, 1] that this trajectory results in net DEX sell pressure */
  dumpHazardScore: number;
  leadFlow: Flow;
}

/**
 * Reconstruct multi-stage causal intent chains across Namada and Osmosis flows, incorporating 1-hop Namada burner
 * transfers and MASP turnstile passthrough links.
 * Multi-stage chains (stage >= 3 with prior unlock/unshield/passthrough or stage 4 sell initiation) provide a
 * high-precision signal that defeats the 90% single-flow base rate documented in `docs/replay-report.md`.
 */
export function reconstructIntentChains(
  flows: Flow[],
  osmoToNamada: ReadonlyMap<string, string> = new Map(),
  passthroughs: readonly MaspPassthroughLink[] = [],
  windowMs = 7 * 86400_000,
): IntentChain[] {
  const sorted = [...flows].sort((a, b) => a.ts - b.ts);
  const namadaToOsmo = new Map<string, string>();
  for (const [osmo, nam] of osmoToNamada) namadaToOsmo.set(nam, osmo);

  // 1-hop Namada transfer map: burner -> upstream vault when burner receives >= 10,000 NAM
  const burnerToOrigin = new Map<string, { from: string; amount: number; ts: number }>();
  for (const f of sorted) {
    if (f.chain === 'namada' && f.kind === 'transfer' && f.from && f.to && !isInternal(f.from) && !isInternal(f.to) && f.amount >= 10_000) {
      if (!burnerToOrigin.has(f.to)) burnerToOrigin.set(f.to, { from: f.from, amount: f.amount, ts: f.ts });
    }
  }

  // MASP passthrough lookup by outTo address
  const passthroughByOut = new Map<string, MaspPassthroughLink>();
  for (const p of passthroughs) {
    if (p.outTo && p.inFrom && (p.confidence === 'high' || p.confidence === 'medium')) {
      passthroughByOut.set(p.outTo, p);
    }
  }

  type Acc = {
    namadaOrigin: string | null;
    osmosisTarget: string | null;
    stages: Set<IntentChain['stagesSeen'][number]>;
    firstTs: number;
    lastTs: number;
    unlockedOrUnshieldedNam: number;
    bridgedNam: number;
    soldNam: number;
    leadFlow: Flow;
  };
  const chains = new Map<string, Acc>();

  const resolveKey = (f: Flow): { key: string; namOrigin: string | null; osmoTarget: string | null; hop?: boolean; masp?: boolean } | null => {
    if (f.chain === 'namada') {
      const actor = f.kind === 'bond' || f.kind === 'ibc_out' || f.kind === 'shield' || f.kind === 'transfer' ? f.from : f.to;
      if (!actor || isInternal(actor)) return null;
      const hop = burnerToOrigin.get(actor);
      const masp = passthroughByOut.get(actor);
      const origin = hop && f.ts >= hop.ts && f.ts - hop.ts <= 48 * 3600_000 ? hop.from : masp?.inFrom ?? actor;
      const osmo = (f.kind === 'ibc_out' && f.to?.startsWith('osmo1') ? f.to : null) ?? namadaToOsmo.get(actor) ?? namadaToOsmo.get(origin) ?? null;
      return { key: origin, namOrigin: origin, osmoTarget: osmo, hop: !!hop, masp: !!masp };
    }
    if (f.chain === 'osmosis') {
      const osmo = f.kind === 'ibc_in' || f.kind === 'buy' ? f.to : f.from;
      if (!osmo || !osmo.startsWith('osmo1')) return null;
      const directNam = osmoToNamada.get(osmo) ?? (f.kind === 'ibc_in' && f.from?.startsWith('tnam1') && !isInternal(f.from) ? f.from : null);
      const masp = passthroughByOut.get(osmo) ?? (directNam ? passthroughByOut.get(directNam) : undefined);
      const hop = directNam ? burnerToOrigin.get(directNam) : undefined;
      const namOrigin = (hop ? hop.from : null) ?? masp?.inFrom ?? directNam ?? null;
      return { key: namOrigin ?? osmo, namOrigin, osmoTarget: osmo, hop: !!hop, masp: !!masp };
    }
    return null;
  };

  for (const f of sorted) {
    if (f.meta?.arb) continue;
    if (!['unbond', 'withdraw', 'unshield', 'ibc_out', 'ibc_in', 'sell'].includes(f.kind)) continue;
    if (f.amount < 5_000) continue;
    const r = resolveKey(f);
    if (!r) continue;
    let c = chains.get(r.key);
    if (c && f.ts - c.firstTs > windowMs) {
      c = undefined;
    }
    if (!c) {
      c = {
        namadaOrigin: r.namOrigin,
        osmosisTarget: r.osmoTarget,
        stages: new Set(),
        firstTs: f.ts,
        lastTs: f.ts,
        unlockedOrUnshieldedNam: 0,
        bridgedNam: 0,
        soldNam: 0,
        leadFlow: f,
      };
      chains.set(r.key, c);
    }
    c.lastTs = Math.max(c.lastTs, f.ts);
    c.leadFlow = f;
    if (r.namOrigin && !c.namadaOrigin) c.namadaOrigin = r.namOrigin;
    if (r.osmoTarget && !c.osmosisTarget) c.osmosisTarget = r.osmoTarget;
    if (r.hop) c.stages.add('burner_hop');
    if (r.masp) c.stages.add('masp_passthrough');

    if (f.kind === 'unbond') {
      c.stages.add('unbond');
      c.unlockedOrUnshieldedNam += f.amount;
    } else if (f.kind === 'withdraw' || f.kind === 'unshield') {
      c.stages.add('withdraw_or_unshield');
      c.unlockedOrUnshieldedNam += f.amount;
    } else if (f.kind === 'ibc_out' || f.kind === 'ibc_in') {
      // Avoid double counting paired Namada ibc_out + Osmosis ibc_in within 15m
      if (!c.stages.has('ibc_bridge') || f.chain === 'osmosis') {
        c.bridgedNam = Math.max(c.bridgedNam, f.amount);
      }
      c.stages.add('ibc_bridge');
    } else if (f.kind === 'sell') {
      c.stages.add('dex_sell');
      c.soldNam += f.amount;
    }
  }

  const out: IntentChain[] = [];
  for (const [key, c] of chains) {
    const stagesSeen = [...c.stages];
    const stage: 1 | 2 | 3 | 4 = c.stages.has('dex_sell')
      ? 4
      : c.stages.has('ibc_bridge')
        ? 3
        : c.stages.has('withdraw_or_unshield')
          ? 2
          : 1;
    // Bayesian hazard model: base prior 0.15 for Stage 1, 0.35 for Stage 2, 0.65 for Stage 3, 0.92 for Stage 4,
    // boosted when preceded by an unlock/unshield, burner hop, or MASP turnstile passthrough.
    let score = stage === 4 ? 0.92 : stage === 3 ? 0.62 : stage === 2 ? 0.32 : 0.12;
    if (stage >= 3 && c.stages.has('withdraw_or_unshield')) score = Math.min(0.98, score + 0.18);
    if (c.stages.has('masp_passthrough')) score = Math.min(0.98, score + 0.12);
    if (c.stages.has('burner_hop')) score = Math.min(0.98, score + 0.08);
    out.push({
      entityAddress: key,
      namadaOrigin: c.namadaOrigin,
      osmosisTarget: c.osmosisTarget,
      stage,
      stagesSeen,
      firstTs: c.firstTs,
      lastTs: c.lastTs,
      unlockedOrUnshieldedNam: c.unlockedOrUnshieldedNam,
      bridgedNam: c.bridgedNam,
      soldNam: c.soldNam,
      dumpHazardScore: Number(score.toFixed(3)),
      leadFlow: c.leadFlow,
    });
  }
  return out.sort((a, b) => b.dumpHazardScore - a.dumpHazardScore || b.lastTs - a.lastTs);
}

