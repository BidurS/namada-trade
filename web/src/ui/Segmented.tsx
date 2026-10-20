// Segmented (system.md 8): a pill radiogroup; option min-height 44 (the range variant is 32
// with 6 px above and below, a 44 px hit); selected = inverse fill, never a yellow box.
// Real radio inputs laid over each option: arrow keys, focus ring and form semantics for free.
import React, { useId } from 'react';

export interface SegOption<T extends string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: SegOption<T>[];
  onChange: (v: T) => void;
  /** Accessible group name ("Side", "Chart range"). */
  label: string;
  /** `range`: the compact mono variant (24h, 7d, 30d). */
  variant?: 'default' | 'range';
  block?: boolean;
  className?: string;
  name?: string;
}

export function Segmented<T extends string>({ value, options, onChange, label, variant = 'default', block, className = '', name }: SegmentedProps<T>) {
  const id = useId();
  const group = name ?? `seg${id}`;
  return (
    <div className={`seg${variant === 'range' ? ' seg--range' : ''}${block ? ' seg--block' : ''} ${className}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className="seg__opt">
          <input type="radio" name={group} value={o.value} checked={o.value === value} disabled={o.disabled} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export default Segmented;
