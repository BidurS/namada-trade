// The six alert rules as the Alerts and Settings screens show them (S6; the sixth, a shielded exit sent over the bridge, from 2026-10-30).
//
// Sizes come from the server (/api/alerts/rules, `thresholdNam`): a number is never typed here (N2).
// Titles and conditions are the plain words of shared/alerts.ts (W9), built for the server's sizes,
// so the page reads the same before and after a worker deploy. Rule ids and logic are unchanged.
import { useEffect, useState } from 'react';
import type { AlertHit, AlertRuleInfo } from '../../../../shared/types';
import { alertRules, type AlertThresholds } from '../../../../shared/alerts';
import { fetchAlertRules } from '../../api';
import type { Stamp, TagKind } from '../../ui/index';

/** Rule id to its threshold key in shared/alerts.ts. */
const KEY: Record<string, keyof AlertThresholds> = {
  ibc_inventory: 'ibcInventory',
  unlock: 'unlock',
  big_swap: 'bigSwap',
  unshield: 'unshield',
  bond: 'bond',
  exit_bridge: 'exitBridge',
};

/** The flow tag a rule is drawn with (plain word and hue from lib/kinds). */
export const RULE_KIND: Record<string, TagKind> = {
  ibc_inventory: 'toOsmosis', // fires on Osmosis ibc_in: NAM bridged to Osmosis (home/data.ts hitKind maps it the same way)
  unlock: 'unstaking',
  big_swap: 'sell',
  unshield: 'shieldOut',
  bond: 'staked',
  exit_bridge: 'shieldOut',
};

export interface RuleView {
  id: string;
  /** Plain title ("NAM bridged to Osmosis"). */
  title: string;
  /** Plain condition for the server's size ("25,000 NAM or more crossed …"). */
  condition: string;
  /** The server's size in NAM. */
  thresholdNam: number;
  kind: TagKind;
}

const blank = (): AlertThresholds => ({ ibcInventory: NaN, unlock: NaN, bigSwap: NaN, unshield: NaN, bond: NaN, exitBridge: NaN });

/** Plain words for the server's rule list, in the server's order; unknown ids keep the server's words. */
export function plainRules(api: AlertRuleInfo[]): RuleView[] {
  const th = blank();
  for (const r of api) if (KEY[r.id]) th[KEY[r.id]] = r.thresholdNam;
  const plain = new Map(alertRules(th).map((r) => [r.id, r]));
  return api.map((r) => {
    const p = plain.get(r.id);
    return { id: r.id, title: p?.title ?? r.title, condition: p?.condition ?? r.condition, thresholdNam: r.thresholdNam, kind: RULE_KIND[r.id] ?? 'transfer' };
  });
}

/** The condition sentence for a size of your own (Settings). */
export function conditionFor(id: string, size: number): string | null {
  const k = KEY[id];
  if (!k || !Number.isFinite(size)) return null;
  const th = blank();
  th[k] = size;
  return alertRules(th).find((r) => r.id === id)?.condition ?? null;
}

/** The tag for one hit: buy or sell for a trade, started or finished for unstaking. */
export function hitKind(h: AlertHit): TagKind {
  if (h.ruleId === 'big_swap') return /^bought/i.test(h.title) ? 'buy' : 'sell';
  if (h.ruleId === 'unlock') return /withdr|unlocked/i.test(h.title) ? 'unlocked' : 'unstaking';
  return RULE_KIND[h.ruleId] ?? 'transfer';
}

/** The transaction hash inside a hit's flow id ("osmosis:<hash>:swap"). */
export const hitTx = (h: AlertHit): string => h.explorerHash || (h.flowId.split(':')[1] ?? '');

// ---- the rule list, read once per page load ---------------------------------------------------
let cache: Promise<{ rules: AlertRuleInfo[]; at: number }> | null = null;

export interface RulesState {
  rules: RuleView[] | null;
  /** The stamp for the sizes: read from the server's rule list at this time. */
  stamp: Stamp | null;
  error: string | null;
}

export function useAlertRules(): RulesState {
  const [state, setState] = useState<RulesState>({ rules: null, stamp: null, error: null });
  useEffect(() => {
    let alive = true;
    cache ??= fetchAlertRules().then((r) => ({ rules: r.rules, at: Date.now() }));
    cache
      .then((r) => {
        if (alive) setState({ rules: plainRules(r.rules), stamp: { source: 'Alert rules', plain: 'Alert rules', at: r.at, status: 'live' }, error: null });
      })
      .catch(() => {
        cache = null;
        if (alive) setState({ rules: null, stamp: { source: 'Alert rules', plain: 'Alert rules', at: null, status: 'missing', note: 'The rule list did not load.' }, error: 'The rule list did not load.' });
      });
    return () => {
      alive = false;
    };
  }, []);
  return state;
}
