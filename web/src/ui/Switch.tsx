// Switch (system.md 8, alert rules): a row of at least 56 px with the label and a plain
// condition sentence, a 52 x 32 pill track with a 24 px thumb, role="switch", selected =
// inverse fill. `locked` shows the signed-out state ("Sign in to choose") and disables it.
import React, { useId } from 'react';
import { Ico } from './ico';

export interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  /** The plain condition ("50,000 NAM or more moved out of the shielded set to a personal address"). */
  description?: React.ReactNode;
  disabled?: boolean;
  /** Signed-out lock line; disables the switch. */
  locked?: React.ReactNode;
  className?: string;
}

export function Switch({ checked, onChange, label, description, disabled, locked, className = '' }: SwitchProps) {
  const id = useId();
  const off = disabled || !!locked;
  return (
    <div className={`swrow ${className}`}>
      <span className="swrow__t" id={`${id}l`}>{label}</span>
      {description ? <span className="swrow__d" id={`${id}d`}>{description}</span> : null}
      <button
        type="button"
        role="switch"
        className="sw"
        aria-checked={checked}
        aria-labelledby={`${id}l`}
        aria-describedby={description ? `${id}d` : undefined}
        disabled={off}
        onClick={() => onChange(!checked)}
      >
        <span className="sw__k" aria-hidden="true" />
      </button>
      {locked ? (
        <span className="swrow__lock">
          <Ico name="lock" className="gly" />
          {locked}
        </span>
      ) : null}
    </div>
  );
}

export default Switch;
