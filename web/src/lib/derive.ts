// derive(): the provenance of a value computed from other values (system.md 8 and 12).
//
// A derived value is never fresher or more trustworthy than its weakest input:
// - `at` is the OLDEST input time (an input with an unknown time makes the result unknown),
// - `status` is the WORST input status (no data > sources disagree > old > fresh),
// - the stamp names every input, so the sheet can say "derived: price x alert size" and list
//   each input with its own source, time and state.
import type { Stamp, Status } from './prov';
import { plainSource, worstStatus } from './prov';
import type { Sourced } from '../../../shared/types';

export function derive(inputs: Stamp[], label: string): Stamp {
  const list = inputs.filter(Boolean);
  if (!list.length) return { source: 'derived', plain: 'Derived', at: null, status: 'missing', derivedFrom: label, inputs: [], note: 'Nothing to derive from.' };
  const status: Status = worstStatus(list.map((p) => p.status));
  const at = list.some((p) => p.at == null) ? null : Math.min(...list.map((p) => p.at as number));
  const names = list.map((p) => plainSource(p));
  const notes = list.map((p) => p.note).filter((n): n is string => !!n);
  return {
    source: 'derived',
    plain: 'Derived',
    at,
    status,
    derivedFrom: label,
    inputs: list.map((p, i) => ({ name: names[i], at: p.at, status: p.status })),
    note: notes.length ? Array.from(new Set(notes)).join(' ') : undefined,
  };
}

/** Names of a derived stamp's inputs, joined for a sentence ("Osmosis quote and Namada node"). */
export const inputNames = (p: Stamp): string => {
  const n = Array.from(new Set((p.inputs ?? []).map((i) => i.name)));
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
};

/**
 * A derived number with its stamp. `compute` runs only when every input value is present and
 * finite; otherwise the value is null and the stamp says no data (N2: no fallback numbers).
 */
export function derived<T extends unknown[]>(
  inputs: { [K in keyof T]: Sourced<T[K]> | { value: T[K] | null | undefined; prov: Stamp } },
  label: string,
  compute: (...values: T) => number,
): Sourced<number> & { prov: Stamp } {
  const stamps = inputs.map((s) => s.prov as Stamp);
  const prov = derive(stamps, label);
  const values = inputs.map((s) => s.value);
  const bad = values.some((v) => v == null || (typeof v === 'number' && !Number.isFinite(v)));
  if (bad) return { value: null, prov: { ...prov, status: 'missing', note: prov.note ?? 'An input has no value.' } };
  const v = compute(...(values as T));
  if (!Number.isFinite(v)) return { value: null, prov: { ...prov, status: 'missing', note: 'The inputs do not give a finite value.' } };
  return { value: v, prov };
}
