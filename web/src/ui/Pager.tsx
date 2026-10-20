// Numbered pages (F3, docs/design/nav-search-plan.md 2.3, owner decision 2026-10-20): Etherscan's pattern,
// `First ‹ Page [ 3 ] of 1,288 › Last`, on every screen size; never "Load more".
//
// - Real links: every control's href carries the whole URL with ?page=, so Cmd-click, middle-click and
//   copy-link work; a plain click navigates client-side through the shell's navigator (linkClick), as Tabs do.
// - Disabled ends stay in the layout as aria-disabled links with tabindex -1, so nothing shifts.
// - The page box is a typed field: Enter (or leaving the field) goes to that page; a page past the end goes to
//   the last one and says so in one short sentence.
// - From 1024 px, with `run`, a short numbered run sits between ‹ and ›: the first page, the current one ±2 and
//   the last, with an ellipsis as text (never a button).
// - "of 1,288" is a figure (a Num, covered by the list's scope); the page numbers themselves are not data.
// - Keyboard: `[` and `]` step a page while focus is inside the nav (stepFor lets a list do the same).
import React, { useId, useRef, useState } from 'react';
import { linkClick, useUiConfig } from './now';
import { Num } from './Num';
import { fmtCount } from '../lib/format';

export interface PagerProps {
  /** Accessible name of the nav ("Holder pages"). */
  label: string;
  /** The current page, from 1. */
  page: number;
  /** The number of pages; null while it is not known (shown as "of —", with `unknown` saying why). */
  pages: number | null;
  /** The href of page n with the current filters (the screen builds it from the URL). */
  hrefFor: (page: number) => string;
  /** Called with the target page before a client-side page change (the screen then focuses the first row). */
  onGo?: (page: number) => void;
  /** When `pages` is null: is there a page after this one? */
  hasNext?: boolean;
  /** Show the numbered run from 1024 px. */
  run?: boolean;
  /** One sentence under the pager when the number of pages is not known. */
  unknown?: React.ReactNode;
  className?: string;
}

/** The target page of a `[` or `]` key press, or null (also for any other key). */
export function stepFor(key: string, page: number, pages: number | null, hasNext?: boolean): number | null {
  if (key === '[') return page > 1 ? page - 1 : null;
  if (key === ']') return (pages != null ? page < pages : !!hasNext) ? page + 1 : null;
  return null;
}

/** The numbered run: the first page, the current one ±2, the last; 'gap' where pages are left out. */
function runOf(page: number, pages: number): (number | 'gap')[] {
  const set = new Set<number>([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= pages) set.add(p);
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  sorted.forEach((p, i) => {
    if (i && p - sorted[i - 1] > 1) out.push('gap');
    out.push(p);
  });
  return out;
}

export function Pager({ label, page, pages, hrefFor, onGo, hasNext, run = false, unknown, className = '' }: PagerProps) {
  const cfg = useUiConfig();
  const id = useId();
  const [text, setText] = useState(String(page));
  /** A sentence about the last typed page, shown while that page is the current one. */
  const [msg, setMsg] = useState<{ text: string; at: number } | null>(null);
  /** The field was typed in since the page last changed (only then does leaving it go anywhere). */
  const dirty = useRef(false);
  // the field follows the page (a link, Back, Forward), during render so no stale value is ever submitted
  const [shown, setShown] = useState(page);
  if (shown !== page) {
    setShown(page);
    setText(String(page));
    dirty.current = false;
  }

  const go = (n: number) => {
    if (n === page) return;
    onGo?.(n);
    const href = hrefFor(n);
    if (cfg.navigate) cfg.navigate(href);
    else location.assign(href);
  };
  const hasMore = pages != null ? page < pages : !!hasNext;

  /** Read the field: a whole number, kept inside 1 … pages; a short sentence when it had to be moved. */
  const submit = () => {
    dirty.current = false;
    const raw = text.trim().replace(/[,\s]/g, '');
    if (!/^\d+$/.test(raw)) {
      setMsg({ text: 'Type a page number.', at: page });
      setText(String(page));
      return;
    }
    let n = Number(raw);
    let note: string | null = null;
    if (n < 1) {
      n = 1;
      note = 'Pages start at one; this is the first.';
    } else if (pages != null && n > pages) {
      n = pages;
      note = pages === 1 ? 'There is only one page.' : `There are ${fmtCount(pages)} pages; this is the last.`;
    }
    setMsg(note ? { text: note, at: n } : null);
    setText(String(n));
    go(n);
  };

  const link = (to: number | null, body: React.ReactNode, cls: string, name?: string, current?: boolean) => {
    if (to == null) {
      return (
        <a className={`pager__a ${cls}`} role="link" aria-disabled="true" tabIndex={-1} aria-label={name}>
          {body}
        </a>
      );
    }
    const href = hrefFor(to);
    return (
      <a className={`pager__a ${cls}`} href={href} aria-label={name} aria-current={current ? 'page' : undefined} onClick={to === page ? (e) => e.preventDefault() : linkClick(cfg, href, () => onGo?.(to))}>
        {body}
      </a>
    );
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const to = stepFor(e.key, page, pages, hasNext);
    if (to == null) return;
    e.preventDefault();
    go(to);
  };

  return (
    <nav className={`pager ${className}`} aria-label={label} onKeyDown={onKeyDown}>
      <div className="pager__row">
        {link(page > 1 ? 1 : null, 'First', 'pager__end', 'First page')}
        {link(page > 1 ? page - 1 : null, <span aria-hidden="true">‹</span>, 'pager__step', 'Previous page')}
        {run && pages != null && pages > 1 ? (
          <span className="pager__run">
            {runOf(page, pages).map((p, i) =>
              p === 'gap' ? (
                <span key={`g${i}`} className="pager__gap" aria-hidden="true">…</span>
              ) : (
                <React.Fragment key={p}>{link(p, fmtCount(p), 'pager__n', `Page ${fmtCount(p)}`, p === page)}</React.Fragment>
              ),
            )}
          </span>
        ) : null}
        <span className="pager__pos">
          <label className="pager__pl" htmlFor={id} aria-hidden="true">Page</label>
          <input
            id={id}
            className="pager__in"
            type="text"
            inputMode="numeric"
            enterKeyHint="go"
            autoComplete="off"
            aria-label="Page number"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setMsg(null);
              dirty.current = true;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape') {
                dirty.current = false;
                setText(String(page));
              }
            }}
            onBlur={(e) => {
              // leaving the field for one of the pager's own links: that link decides; otherwise the typed page
              if (!dirty.current) return;
              if (e.relatedTarget instanceof Node && e.currentTarget.closest('nav')?.contains(e.relatedTarget)) {
                dirty.current = false;
                setText(String(page));
              } else submit();
            }}
          />
          <span className="pager__of">
            of {pages != null ? <Num v={pages} fmt={fmtCount} /> : <span aria-label="not known">—</span>}
          </span>
        </span>
        {link(hasMore ? page + 1 : null, <span aria-hidden="true">›</span>, 'pager__step', 'Next page')}
        {link(pages != null && page < pages ? pages : null, 'Last', 'pager__end', 'Last page')}
      </div>
      <p className="pager__msg" role="status">
        {msg && msg.at === page ? msg.text : null}
      </p>
      {pages == null && unknown ? <p className="pager__why">{unknown}</p> : null}
    </nav>
  );
}

export default Pager;
