// Num, SNum, Derived: a number that knows where it came from (system.md 8, 12).
//
// Renders <span data-num data-status="fresh|old|none|disagree">. The four states are distinct:
// - fresh: plain ink;
// - old: ink-2 with a dotted underline and the age beside it ("old 3.2 h"); inside a scope that
//   is old as a whole (.is-old) the list is dimmed once and the age is said once, not per number;
// - no data: "—" with a dashed underline and the reason inline, in view (never cut, never hover);
// - sources disagree: a wavy underline (black on yellow).
// There is no fallback path (N2): if the value is missing you see that, never a stand-in.
import React from 'react';
import type { Sourced } from '../../../shared/types';
import type { Stamp, UiStatus } from '../lib/prov';
import { plainSource, uiStatus } from '../lib/prov';
import { derive } from '../lib/derive';
import { NBSP, ageOf, splitPrice } from '../lib/format';
import { useUiNow } from './now';
import { ProvDot } from './ProvDot';
import { ProvChip } from './ProvChip';

export interface NumProps {
  v: number | null | undefined;
  /** The figure's stamp. Absent: the figure sits in a ProvScope whose SourceLine covers it. */
  prov?: Stamp | null;
  /** Formatter (format.ts rules). May return a node, e.g. <Price> with dimmed leading zeros. */
  fmt?: (n: number) => React.ReactNode;
  /** Unit after the value, mono 12 px ink-2 ("NAM", "USDC", "days"). */
  unit?: string;
  /** Age beside the value. Default: shown when old or disagreeing, hidden when fresh. */
  showAge?: boolean;
  /** Reason beside a missing value. Default true (the reason must be in view). */
  showReason?: boolean;
  /** Its own stamp control after the value: a ProvDot or (hero figures only) a ProvChip. */
  stamp?: 'dot' | 'chip';
  /** What the figure is (stamp sheet title). */
  label?: string;
  /** Element to render (default span). */
  as?: 'span' | 'b' | 'strong' | 'p' | 'dd' | 'div';
  className?: string;
  /** Force a state (e.g. a holder row whose two staked readings differ). */
  status?: UiStatus;
}

const defaultFmt = (n: number) => n.toLocaleString('en-US');

/** A sub-dollar price with the leading "$0.00" dimmed: <span class="lz">$0.00</span>1025. */
export function Price({ v }: { v: number }) {
  const { lead, sig } = splitPrice(v);
  return lead ? (
    <>
      <span className="lz">{lead}</span>
      {sig}
    </>
  ) : (
    <>{sig}</>
  );
}
export const fmtPriceNode = (n: number): React.ReactNode => <Price v={n} />;

export function Num({ v, prov, fmt = defaultFmt, unit, showAge, showReason = true, stamp, label, as: El = 'span', className = '', status }: NumProps) {
  const now = useUiNow();
  const missing = v == null || !Number.isFinite(v) || prov?.status === 'missing';
  const ui: UiStatus = status ?? (missing ? 'none' : prov ? uiStatus(prov.status) : 'fresh');
  const ctl = stamp && prov ? (stamp === 'chip' ? <ProvChip p={prov} label={label} /> : <ProvDot p={prov} label={label} />) : null;

  if (missing) {
    const reason = prov?.note ?? (prov ? `${plainSource(prov)} has no value right now` : 'no value recorded');
    return (
      <span className={`num ${className}`}>
        <El data-num="" data-status="none">—</El>
        {showReason ? <span className="num__x num__x--why">{reason}</span> : null}
        {ctl ? <> {ctl}</> : null}
      </span>
    );
  }

  // With a unit, the figure sits in .num__v so the old / disagree underline runs under the number only, not "NAM".
  const body = unit ? (
    <>
      <span className="num__v">{fmt(v as number)}</span>
      {/* a no-break space: "19,926,988 NAM" never splits into "19,926,988" / "NAM" */}
      <span className="u">{`${NBSP}${unit}`}</span>
    </>
  ) : (
    fmt(v as number)
  );
  const age = prov?.at != null ? ageOf(prov.at, now) : null;
  const wantAge = showAge ?? (ui === 'old' || ui === 'disagree');
  const ageText = wantAge && age ? (ui === 'old' ? `old ${age}` : ui === 'disagree' ? `disagree ${age}` : age === 'now' ? 'just now' : age) : null;

  if (!ageText && !ctl) {
    return (
      <El data-num="" data-status={ui} className={className || undefined}>
        {body}
      </El>
    );
  }
  return (
    <span className={`num ${className}`}>
      <El data-num="" data-status={ui}>
        {body}
      </El>
      {ageText ? <span className="num__x num__x--age">{ageText}</span> : null}
      {ctl ? <> {ctl}</> : null}
    </span>
  );
}

/** A Sourced<number> from the API: value and stamp together. */
export function SNum({ s, ...rest }: Omit<NumProps, 'v' | 'prov'> & { s: Sourced<number> | null | undefined }) {
  return <Num v={s?.value ?? null} prov={s?.prov ?? null} {...rest} />;
}

/**
 * A value computed from stamped inputs. The stamp is derive(): oldest time, worst state, and
 * the sheet names every input. `compute` only runs when every input has a value.
 */
export function Derived({
  inputs,
  label,
  compute,
  name,
  ...rest
}: Omit<NumProps, 'v' | 'prov' | 'label'> & {
  /** What the figure is (stamp sheet title). Default: the derivation label. */
  name?: string;
  inputs: { value: number | null | undefined; prov: Stamp }[];
  /** What was combined ("price x alert size"). */
  label: string;
  compute: (...values: number[]) => number;
}) {
  const prov = derive(inputs.map((i) => i.prov), label);
  const vals = inputs.map((i) => i.value);
  const ok = vals.every((x) => x != null && Number.isFinite(x));
  const v = ok ? compute(...(vals as number[])) : null;
  const p: Stamp = ok && v != null && Number.isFinite(v) ? prov : { ...prov, status: 'missing', note: prov.note ?? 'An input has no value right now.' };
  return <Num v={ok ? v : null} prov={p} label={name ?? label} {...rest} />;
}

export default Num;
