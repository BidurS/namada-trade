// Sheet: the one overlay pattern (system.md 8 "Sheet"; build-plan 2 "Overlays").
//
// A modal <dialog>: top layer, focus moves in and is contained, Escape closes, a tap on the
// scrim closes (light dismiss), focus returns to the invoker, max-height calc(100dvh - 16px)
// with internal scroll. Bottom sheet on phones, centred dialog from 640 px, right panel
// (size="side") from 1024 px. The heading inside it fits the page outline (h2 by default).
import React, { useEffect, useId, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Ico } from './ico';
import type { Stamp } from '../lib/prov';
import { STATUS_WORD, plainSource, scopeRowText, uiStatus } from '../lib/prov';
import { ageOf, fmtUtcLong } from '../lib/format';
import { defaultRewindHref, linkClick, useUiConfig, useUiNow } from './now';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  size?: 'md' | 'lg' | 'side';
  /** One sentence under the title. */
  lead?: React.ReactNode;
  /** Actions at the foot (safe-area padded). */
  foot?: React.ReactNode;
  /** Heading level of the title (2 by default). */
  level?: 2 | 3;
  className?: string;
  children?: React.ReactNode;
}

export function Sheet({ open, onClose, title, size = 'md', lead, foot, level = 2, className = '', children }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /** Where the last press started and ended: the scrim closes the sheet only when both were on it. */
  const press = useRef({ down: false, up: false });
  const tid = useId();

  const restoreFocus = () => {
    const r = returnTo.current;
    returnTo.current = null;
    if (r && r.isConnected && typeof r.focus === 'function') r.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = (document.activeElement as HTMLElement) ?? null;
      d.setAttribute('closedby', 'any'); // native light dismiss where supported; the click handler covers the rest
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onDialogClose = () => {
      restoreFocus();
      onCloseRef.current();
    };
    d.addEventListener('close', onDialogClose);
    return () => {
      d.removeEventListener('close', onDialogClose);
      // unmounted while open: the close event never fires, so give focus back here
      if (d.open) restoreFocus();
    };
  }, []);

  const H = level === 3 ? 'h3' : 'h2';
  // Portalled to <body>: a stamp often sits inside running text (<p>), where a <dialog> cannot nest.
  // The dialog is modal and in the top layer either way.
  return createPortal(
    <dialog
      ref={ref}
      className={`sheet ground-ink${size === 'lg' ? ' sheet--lg' : size === 'side' ? ' sheet--side' : ''} ${className}`}
      aria-labelledby={tid}
      onClick={(e) => {
        // The scrim (the dialog box itself is covered by .sheet__in): pressed and released there. A text
        // selection dragged out of the sheet also ends in a click on the dialog (the common ancestor) and
        // must not close it.
        const p = press.current;
        press.current = { down: false, up: false };
        if (e.target === ref.current && p.down && p.up) ref.current.close();
        e.stopPropagation(); // React bubbles portal events to the invoker's ancestors (a row, a label): not here
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        press.current = { down: e.target === ref.current, up: false };
        e.stopPropagation();
      }}
      onPointerUp={(e) => {
        press.current.up = e.target === ref.current;
      }}
    >
      <div className="sheet__in">
        <div>
          <div className="sheet__head">
            <H id={tid} className="sheet__t">{title}</H>
            <button type="button" className="icon-btn" aria-label="Close" onClick={() => ref.current?.close()}>
              <Ico name="close" className="ico" />
            </button>
          </div>
          {lead ? <p className="sheet__lead">{lead}</p> : null}
          {children}
        </div>
        {foot ? <div className="sheet__foot">{foot}</div> : null}
      </div>
    </dialog>,
    document.body,
  );
}

/** "Rewind to this time" for a sheet foot: a real link (?at=), followed client-side when the shell provides a navigator. */
export function RewindLink({ at, onDone }: { at: number | null | undefined; onDone?: () => void }) {
  const cfg = useUiConfig();
  if (at == null) return null;
  const href = (cfg.rewindHref ?? defaultRewindHref)(at);
  return (
    <a className="btn btn--secondary" href={href} onClick={linkClick(cfg, href, onDone)}>
      Rewind to this time
      <Ico name="rewind" className="ico ico--btn" />
    </a>
  );
}

/** The provenance sheet for one figure (ProvChip, ProvDot). */
export function ProvSheet({ p, label, open, onClose }: { p: Stamp; label: string; open: boolean; onClose: () => void }) {
  const now = useUiNow();
  const ui = uiStatus(p.status);
  const age = ageOf(p.at, now);
  return (
    <Sheet open={open} onClose={onClose} title={label} foot={<RewindLink at={p.at} onDone={onClose} />}>
      <dl className="kv">
        <dt>Status</dt>
        <dd><span className="dot" data-status={ui} />{STATUS_WORD[ui]}</dd>
        <dt>As of</dt>
        <dd>{p.at == null ? 'unknown' : fmtUtcLong(p.at)}</dd>
        <dt>Age</dt>
        <dd>{p.at == null ? 'unknown' : age === 'now' ? 'just now' : age}</dd>
        <dt>Source</dt>
        <dd>{plainSource(p)}</dd>
        {p.derivedFrom ? (
          <>
            <dt>Derived</dt>
            <dd>
              {p.derivedFrom}
              {p.inputs?.map((i) => (
                <span key={i.name} className="kv__sub">
                  {scopeRowText({ source: i.name, plain: i.name, at: i.at, status: i.status }, now)}
                </span>
              ))}
            </dd>
          </>
        ) : null}
        {p.note ? (
          <>
            <dt>Note</dt>
            <dd>{p.note}</dd>
          </>
        ) : null}
        {p.extra?.map(([k, v], i) => (
          <React.Fragment key={`${k}-${i}`}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </React.Fragment>
        ))}
      </dl>
      {p.source !== 'derived' ? (
        <details className="how">
          <summary>
            How it is computed
            <Ico name="chev" className="ico ico--inline" />
          </summary>
          <dl className="kv">
            <dt>Technical name</dt>
            <dd><span className="mono">{p.source}</span></dd>
            {p.height ? (
              <>
                <dt>Height</dt>
                <dd><span className="mono">{p.height.toLocaleString('en-US')}</span></dd>
              </>
            ) : null}
          </dl>
        </details>
      ) : null}
    </Sheet>
  );
}

export interface ScopeItem {
  /** What the figure is ("Holders on Namada"). */
  label: string;
  p: Stamp | null | undefined;
}

/** The scope sheet for a SourceLine: each figure in the panel with its own source, time, age and state. */
export function ScopeSheet({ items, title, open, onClose }: { items: ScopeItem[]; title: string; open: boolean; onClose: () => void }) {
  const now = useUiNow();
  const ats = items.map((i) => i.p?.at).filter((a): a is number => a != null);
  const newest = ats.length ? Math.max(...ats) : null;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      lead={<>As of {newest == null ? 'an unknown time' : fmtUtcLong(newest)}. Each figure on this panel, with its own source and age.</>}
      foot={<RewindLink at={newest} onDone={onClose} />}
    >
      <dl className="kv">
        {items.map((it, i) => {
          const ui = uiStatus(it.p?.status ?? 'missing');
          return (
            <React.Fragment key={`${it.label}-${i}`}>
              <dt>{it.label}</dt>
              <dd>
                <span className="dot" data-status={ui} />
                {it.p ? scopeRowText(it.p, now) : 'no source recorded · no data'}
                {it.p?.note && ui !== 'fresh' ? <span className="kv__sub">{it.p.note}</span> : null}
              </dd>
            </React.Fragment>
          );
        })}
      </dl>
    </Sheet>
  );
}
