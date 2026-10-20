// Term: a glossary term in running text (system.md 8 "Glossary term", "Popover").
// A button with a SOLID 1 px underline (distinct from the dotted old, wavy disagree and dashed
// no-data number underlines). Tap opens a small popover: plain row over the expert row, one
// sentence, optionally "More in the glossary". Native popover="auto": light dismiss, Escape,
// focus back to the term. Anchored card from 640 px; a bottom sheet on phones.
//
// Browsers without the Popover API (Safari before 17, Firefox before 125): the same element opens
// as a card with the class .is-open (sheet.css), one at a time, closed by its close button, Escape
// or a tap outside. Without this the card was either always visible (no UA rule hides
// [popover]) or never reachable.
import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { glossaryEntry } from '../lib/glossary';
import { Ico } from './ico';
import { linkClick, useUiConfig } from './now';

export interface GlossPopContent {
  plain: string;
  expert?: string;
  text?: string;
}

export const supportsPopover = () => typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

// ---- the fallback: one open card at a time, closed by Escape, a tap outside or its close button
let openPop: { p: HTMLElement; b: HTMLElement } | null = null;
let fallbackWired = false;

function closeFallback(returnFocus: boolean) {
  const cur = openPop;
  if (!cur) return;
  openPop = null;
  const hadFocus = cur.p.contains(document.activeElement);
  cur.p.classList.remove('is-open');
  cur.b.setAttribute('aria-expanded', 'false');
  if ((returnFocus || hadFocus) && cur.b.isConnected) cur.b.focus({ preventScroll: true });
}

function openFallback(p: HTMLElement, b: HTMLElement) {
  if (openPop?.p === p) return closeFallback(false);
  closeFallback(false);
  if (!fallbackWired) {
    fallbackWired = true;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && openPop) {
        e.preventDefault();
        closeFallback(true);
      }
    }, true);
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node | null;
      if (openPop && t && !openPop.p.contains(t) && !openPop.b.contains(t)) closeFallback(false);
    }, true);
  }
  openPop = { p, b };
  p.classList.add('is-open');
  b.setAttribute('aria-expanded', 'true');
  place(p, b);
}

/** Close a glossary card, with or without the Popover API. */
export function hideGlossPop(p: HTMLElement | null | undefined) {
  if (!p) return;
  if (supportsPopover()) {
    try {
      p.hidePopover();
    } catch {
      /* not open */
    }
  } else if (openPop?.p === p) closeFallback(true);
}

/** Places an open popover next to its invoker (from 640 px; below that it is a bottom sheet). */
function place(pop: HTMLElement, btn: HTMLElement) {
  if (!window.matchMedia('(min-width: 640px)').matches) return;
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth || 320;
  const h = pop.offsetHeight || 160;
  const x = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  let y = r.bottom + 8;
  if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 8);
  pop.style.setProperty('--pop-x', `${Math.round(x)}px`);
  pop.style.setProperty('--pop-y', `${Math.round(y)}px`);
}

/** Wires a button to a popover element: popovertarget, placement, aria. Returns refs. */
export function useGlossPop() {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId().replace(/:/g, '');
  useEffect(() => {
    const b = btnRef.current;
    const p = popRef.current;
    if (!b || !p) return;
    if (!supportsPopover()) {
      const onClick = () => openFallback(p, b);
      b.addEventListener('click', onClick);
      return () => {
        b.removeEventListener('click', onClick);
        if (openPop?.p === p) closeFallback(false);
      };
    }
    b.setAttribute('popovertarget', `gp${id}`);
    const before = () => place(p, b);
    const after = (e: Event) => {
      const open = (e as Event & { newState?: string }).newState === 'open';
      b.setAttribute('aria-expanded', String(open));
      if (open) place(p, b);
    };
    p.addEventListener('beforetoggle', before);
    p.addEventListener('toggle', after);
    return () => {
      p.removeEventListener('beforetoggle', before);
      p.removeEventListener('toggle', after);
    };
  }, [id]);
  return { btnRef, popRef, popId: `gp${id}` };
}

export function GlossPop({ popRef, popId, c }: { popRef: React.RefObject<HTMLDivElement>; popId: string; c: GlossPopContent }) {
  const cfg = useUiConfig();
  const hide = () => hideGlossPop(popRef.current);
  if (typeof document === 'undefined') return null;
  // portalled to <body>: a term sits inside running text (<p>), where a card cannot nest
  return createPortal(
    <div ref={popRef} id={popId} className="pop ground-ink" {...(supportsPopover() ? { popover: 'auto' } : {})} role="dialog" aria-label={c.plain}>
      <p className="pop__plain">{c.plain}</p>
      {c.expert ? <p className="pop__expert">{c.expert}</p> : null}
      {c.text ? <p className="pop__text">{c.text}</p> : null}
      {cfg.glossaryHref ? (
        <a className="link" href={cfg.glossaryHref} onClick={linkClick(cfg, cfg.glossaryHref, hide)}>
          More in the glossary
        </a>
      ) : null}
      <button type="button" className="icon-btn pop__x" aria-label="Close" onClick={hide}>
        <Ico name="close" className="ico" />
      </button>
    </div>,
    document.body,
  );
}

export interface TermProps {
  /** Glossary entry id (lib/glossary.ts). */
  id: string;
  /** Visible text. Default: the entry's plain word. */
  children?: React.ReactNode;
  className?: string;
}

export function Term({ id, children, className = '' }: TermProps) {
  const g = glossaryEntry(id);
  const { btnRef, popRef, popId } = useGlossPop();
  if (!g) return <>{children}</>;
  return (
    <>
      <button ref={btnRef} type="button" className={`term ${className}`} aria-haspopup="dialog" aria-expanded="false">
        {children ?? g.plain}
      </button>
      <GlossPop popRef={popRef} popId={popId} c={{ plain: g.plain, expert: g.expert, text: g.text }} />
    </>
  );
}

export default Term;
