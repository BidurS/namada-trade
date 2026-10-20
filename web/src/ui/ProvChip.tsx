// ProvChip: the provenance control for HERO figures only (system.md 8): Home price, Trade
// "You get", the mini-ticket, the Supply and Shielded band figures. Never more than three on
// a screenful; every other single figure uses ProvDot, and panels use one SourceLine.
//
// A 24 px pill with a 44 px hit area (::after). The dot always sits beside a word:
// "{source} · {age}", "{source} · old {age}", "{source} · no data", "{source} · disagree {age}".
// Tap, click, Enter or Space opens the provenance Sheet; focus returns here on close.
import { useState } from 'react';
import type { Stamp } from '../lib/prov';
import { STATUS_WORD, plainSource, stampText, uiStatus } from '../lib/prov';
import { ProvSheet } from './Sheet';
import { useUiNow } from './now';

export interface ProvControlProps {
  /** The figure's stamp (a Provenance from the API is a valid Stamp). */
  p: Stamp | null | undefined;
  /** What the figure is: the sheet title and part of the accessible name ("NAM price"). */
  label?: string;
  /** Visible text instead of the default "{source} · {age}". It must still name a source. */
  text?: string;
  className?: string;
}

const NONE: Stamp = { source: 'No source recorded', at: null, status: 'missing' };

/** Shared by ProvChip and ProvDot. */
export function StampButton({ p, label, text, className, variant }: ProvControlProps & { variant: 'chip' | 'pdot' }) {
  const now = useUiNow();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const stamp = p ?? NONE;
  const ui = uiStatus(stamp.status);
  const visible = text ?? stampText(stamp, now);
  const what = label ?? plainSource(stamp);
  return (
    <>
      <button
        type="button"
        className={`${variant} ${className ?? ''}`}
        data-status={ui}
        data-prov=""
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${visible}, ${STATUS_WORD[ui]}. Where ${what} comes from.`}
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        <i className="dot" data-status={ui} aria-hidden="true" />
        <span>{visible}</span>
      </button>
      {mounted ? <ProvSheet p={stamp} label={what} open={open} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function ProvChip(props: ProvControlProps) {
  return <StampButton {...props} variant="chip" />;
}

export default ProvChip;
