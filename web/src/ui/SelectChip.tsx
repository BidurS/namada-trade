// Selectable chips (system.md 8): pills, min-height 44, 1.5 px border, selected = inverse fill,
// an optional count suffix in mono 12. `layout="presets"` is the amount-preset row: a horizontal
// scroll row with an edge fade on phones that wraps from 640 px.
// Single choice uses radios, `multiple` uses checkboxes; both are real inputs over the pill.
import React, { useId } from 'react';

export interface ChipOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Count suffix ("Foundation 7"). */
  count?: number | null;
  disabled?: boolean;
}

interface Base<T extends string> {
  options: ChipOption<T>[];
  /** Group name, shown as the legend unless `hideLegend`. */
  label: string;
  hideLegend?: boolean;
  layout?: 'chips' | 'presets';
  className?: string;
}

export type SelectChipProps<T extends string> = Base<T> &
  ({ multiple?: false; value: T | null; onChange: (v: T) => void } | { multiple: true; value: T[]; onChange: (v: T[]) => void });

export function SelectChip<T extends string>(props: SelectChipProps<T>) {
  const { options, label, hideLegend, layout = 'chips', className = '' } = props;
  const id = useId();
  const isOn = (v: T) => (props.multiple ? props.value.includes(v) : props.value === v);
  const toggle = (v: T) => {
    if (props.multiple) props.onChange(props.value.includes(v) ? props.value.filter((x) => x !== v) : [...props.value, v]);
    else props.onChange(v);
  };
  const type = props.multiple ? 'checkbox' : 'radio';

  if (layout === 'presets') {
    return (
      <div className={`presets ${className}`} role={props.multiple ? 'group' : 'radiogroup'} aria-label={label}>
        {options.map((o) => (
          <label key={o.value} className="pre">
            <input type={type} name={`pre${id}`} value={o.value} checked={isOn(o.value)} disabled={o.disabled} onChange={() => toggle(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    );
  }
  return (
    <fieldset className={`fset ${className}`}>
      <legend className={hideLegend ? 'sr-only' : 'fset__l'}>{label}</legend>
      <div className="chipsel" role={props.multiple ? 'group' : 'radiogroup'} aria-label={label}>
        {options.map((o) => (
          <label key={o.value} className="chipsel__o">
            <input type={type} name={`chip${id}`} value={o.value} checked={isOn(o.value)} disabled={o.disabled} onChange={() => toggle(o.value)} />
            <span>
              {o.label}
              {o.count != null ? <span className="chipsel__n">{o.count.toLocaleString('en-US')}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export default SelectChip;
