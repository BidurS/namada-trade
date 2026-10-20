// Field (system.md 8): label row (13 px 500) with an optional right-aligned state; a 60 px box
// with a 2 px ink border and 2 px radius; the value at 24 px 500; the unit in mono 12 on the
// right; a 13 px hint below ("Worth about $5.13"). Numeric fields use inputmode="decimal".
// Errors are a Notice under the field (pass it as `error`), never red text alone.
import React, { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon';

export interface FieldProps {
  label: React.ReactNode;
  /** Right side of the label row, e.g. a state marker ("live quote not answering"). */
  state?: React.ReactNode;
  unit?: string;
  /** 13 px line under the box. */
  hint?: React.ReactNode;
  /** 12 px note under the hint ("Listed sizes only: …"). */
  note?: React.ReactNode;
  /** A <Notice> shown under the field when the value is not usable. */
  error?: React.ReactNode;
  value: string;
  onChange?: (v: string) => void;
  /** Numeric input (inputmode decimal, no spinner). Default true. */
  numeric?: boolean;
  placeholder?: string;
  disabled?: boolean;
  /** Read-only value (the box shows it as text, e.g. when only listed sizes can be quoted). */
  readOnly?: boolean;
  name?: string;
  className?: string;
  onBlur?: () => void;
}

export function Field({ label, state, unit, hint, note, error, value, onChange, numeric = true, placeholder, disabled, readOnly, name, className = '', onBlur }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}h` : undefined;
  return (
    <div className={`field${error ? ' field--invalid' : ''} ${className}`} aria-disabled={disabled || undefined}>
      <div className="field__top">
        <label className="field__l" htmlFor={id}>{label}</label>
        {state ? <span className="field__state">{state}</span> : null}
      </div>
      <div className="field__box" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
        <input
          id={id}
          name={name}
          className="field__in"
          type="text"
          inputMode={numeric ? 'decimal' : undefined}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          aria-describedby={hintId}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange?.(e.target.value)}
          onBlur={onBlur}
        />
        {unit ? <span className="field__u" aria-hidden="true">{unit}</span> : null}
      </div>
      {hint ? <p className="field__hint" id={hintId}>{hint}</p> : null}
      {note ? <p className="field__note">{note}</p> : null}
      {error ?? null}
    </div>
  );
}

/**
 * SearchField: the compact text variant for search boxes (Activity filters, the tab bar): a 48 px pill box
 * (44 px in a bar), 16 px text so iOS does not zoom, a leading search icon and a 44 px clear button. The
 * value is applied 300 ms after typing stops (or on Enter).
 */
export function SearchField({
  label,
  value,
  onChange,
  placeholder,
  compact,
}: {
  label: string;
  /** In the tab bar: the label is for screen readers only. */
  compact?: boolean;
  /** The applied value (the parent's state). */
  value: string;
  /** Called 300 ms after typing stops, with the trimmed text. */
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  /** The last value this field sent: its echo back through `value` must not overwrite what is being typed. */
  const lastSent = useRef(value);
  const cb = useRef(onChange);
  cb.current = onChange;
  const send = (v: string) => {
    lastSent.current = v;
    cb.current(v);
  };
  // The parent cleared or changed the value (e.g. "Clear filters"). Not the echo of what this field sent:
  // after "namada " the parent holds "namada", and writing that back would eat the space being typed.
  useEffect(() => {
    if (value !== lastSent.current) {
      lastSent.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (text.trim() !== value) send(text.trim());
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, value]);
  return (
    <div className={`field-search${compact ? ' field-search--bar' : ''}`}>
      <label className={compact ? 'sr-only' : 'fset__l'} htmlFor={id}>{label}</label>
      <div className="field-search__box">
        <Icon name="search" className="ico" />
        <input
          id={id}
          type="search"
          inputMode="search"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send(text.trim());
          }}
        />
        {text ? (
          <button
            type="button"
            className="field-search__x"
            aria-label="Clear search"
            onClick={() => {
              setText('');
              send('');
            }}
          >
            <Icon name="close" className="ico" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default Field;
