// The search palette (system.md 8 "Palette (search)"): a modal dialog, full height on phones
// with the input at the top (16 px text, so iOS does not zoom), 640 px centred from 1024 px.
// Groups: Views, Addresses, Actions, Glossary, and a Rewind row (a UTC date and time, plus the
// dated presets the build exports). Arrow keys and Enter; "/" and Ctrl or Cmd K open it,
// Escape and a tap outside close it (a text selection dragged outside does not), focus returns to
// what opened it, or goes to the new page or the sheet the chosen item opens. Lazy-loaded.
// A search that fails says so; it never reads as "nothing matches".
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { SearchResult } from '../../../shared/types';
import { ROUTES, TABS, type RouteId } from '../../../shared/routes';
import { searchOmni } from '../api';
import { GLOSSARY } from '../lib/glossary';
import { explorerTx, fmtAddr, fmtPctSigned, fmtUtcLong } from '../lib/format';
import { Icon, type GridIconName } from '../ui/Icon';
import { readRecent, useOverlays } from './overlays';
import { useReplay, REWIND_WORDS } from './replay';
import { navigate } from './router';
import { useSession } from './session';
import { TAB_ICON } from './TabBar';
import { THEME_LABELS, useTheme, type ThemePref } from './theme';

interface Item {
  id: string;
  group: 'Views' | 'Addresses' | 'Actions' | 'Glossary';
  label: string;
  sub?: string;
  icon?: GridIconName;
  hint?: string;
  run?: () => void;
}

/** A dated moment worth rewinding to, from the build-time exports (web/src/generated, W4). */
export interface RewindPreset {
  at: number;
  label: string;
  note?: string;
}

/**
 * The Rewind presets (system.md 8): the three biggest price moves in docs/events.json and the
 * replay report's example (the first alert before the largest move out of the staking account, owner
 * decision 3). Every figure is a field of the generated exports; nothing is typed here.
 */
async function loadPresets(): Promise<RewindPreset[]> {
  try {
    const [{ PRICE_MOVES }, { PROOF }] = await Promise.all([import('../generated/events'), import('../generated/proof')]);
    const out: RewindPreset[] = [];
    const w = PROOF.rewindExample;
    if (w) out.push({ at: w.rewindAt, label: `The first alert before ${Math.round(w.amountNam / 1e6)} million NAM ${w.kind === 'withdraw' ? 'were withdrawn from staking' : 'moved out of the staking account in one transfer'}`, note: fmtUtcLong(w.rewindAt) });
    const biggest = [...PRICE_MOVES].sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, 3);
    for (const m of biggest) {
      const hours = Math.round((m.t1 - m.t0) / 3_600_000);
      out.push({ at: m.t0, label: `Just before a ${fmtPctSigned(m.pct, 1)} price move over ${hours} h`, note: fmtUtcLong(m.t0) });
    }
    return out.sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

const ROUTE_ICON: Partial<Record<RouteId, GridIconName>> = { holders: 'activity', settings: 'account', staking: 'supply', osmosis: 'trade', learn: 'info', faq: 'info' };
const looksLikeAddress = (q: string) => /^(tnam1|osmo1)[0-9a-z]{30,}$/i.test(q.trim());
const toUtcInput = (ms: number) => new Date(ms).toISOString().slice(0, 16);

export default function Palette({ focus, onClose }: { focus: 'search' | 'rewind'; onClose: (opts?: { restore?: boolean }) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rewindRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { openSources, openAddress, openSignIn, openSheet } = useOverlays();
  const { at, rewound, setAt, backToNow } = useReplay();
  const { session, signOut } = useSession();
  const [themePref, , setTheme] = useTheme();

  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState('');
  /** The term whose search failed (the server did not answer, or answered with an error). */
  const [failed, setFailed] = useState<string | null>(null);
  /** Where the last press started and ended: the scrim closes only when both were on it. */
  const press = useRef({ down: false, up: false });
  const [active, setActive] = useState(0);
  const [presets, setPresets] = useState<RewindPreset[]>([]);
  const [when, setWhen] = useState(() => toUtcInput(at ?? Date.now() - 86_400_000));
  const [whenError, setWhenError] = useState<string | null>(null);
  const maxWhen = useMemo(() => toUtcInput(Date.now()), []);

  // open as a modal; Escape and close return focus to the opener (native dialog behaviour)
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) {
      d.setAttribute('closedby', 'any'); // native light dismiss where supported (it tracks press and release)
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    }
    (focus === 'rewind' ? rewindRef.current : inputRef.current)?.focus();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener('cancel', onCancel);
    return () => {
      d.removeEventListener('cancel', onCancel);
      if (d.open) d.close();
    };
  }, [focus, onClose]);

  useEffect(() => {
    let alive = true;
    loadPresets().then((p) => alive && setPresets(p));
    return () => {
      alive = false;
    };
  }, []);

  // address, transaction and label search (current data; it does not take a rewound time). Only the
  // answer for the text in the box is used: a slow answer for an earlier text is dropped.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) {
      setResults([]);
      setSearched('');
      setFailed(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      searchOmni(term).then(
        (r) => {
          if (!live) return;
          setResults(r.slice(0, 8));
          setSearched(term);
          setFailed(null);
        },
        () => {
          if (!live) return;
          setResults([]);
          setSearched(term);
          setFailed(term);
        },
      );
    }, 160);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  const close = () => onClose();
  /** Close for an item that opens a sheet: the sheet returns focus to what opened search. */
  const handOff = () => onClose({ restore: false });
  const go = (path: string) => {
    close();
    navigate(path);
  };

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    const match = (...s: (string | undefined)[]) => !term || s.some((x) => x?.toLowerCase().includes(term));
    const out: Item[] = [];

    // Views: the six tabs first, then the other pages
    for (const t of TABS) {
      const r = ROUTES.find((x) => x.id === t.id);
      if (match(t.label, r?.h1)) out.push({ id: `v:${t.id}`, group: 'Views', label: t.label, sub: r?.h1, icon: TAB_ICON[t.id], hint: t.key, run: () => go(t.path) });
    }
    for (const r of ROUTES) {
      if (TABS.some((t) => t.id === r.id)) continue;
      if (r.id === 'settings' && !session) continue;
      if (!term && !['holders'].includes(r.id)) continue; // the rest appear when typed for
      if (match(r.label, r.h1)) out.push({ id: `v:${r.id}`, group: 'Views', label: r.label, sub: r.h1, icon: ROUTE_ICON[r.id] ?? 'arrow', run: () => go(r.path) });
    }

    // Addresses
    if (looksLikeAddress(q)) {
      const a = q.trim();
      out.push({ id: `a:typed`, group: 'Addresses', label: fmtAddr(a), sub: 'Open this address', icon: 'account', run: () => { handOff(); openAddress(a); } });
    }
    for (const r of results) {
      const isTx = r.type === 'tx';
      const isPool = r.type === 'pool';
      out.push({
        id: `s:${r.type}:${r.value}`,
        group: 'Addresses',
        label: r.title || fmtAddr(r.value),
        sub: [isTx ? 'Transaction' : isPool ? 'Pool' : r.chain === 'osmosis' ? 'Osmosis address' : r.chain === 'namada' ? 'Namada address' : undefined, r.subtitle].filter(Boolean).join(' · '),
        icon: isTx ? 'external' : isPool ? 'trade' : 'account',
        run: () => {
          if (isTx) {
            close();
            window.open(explorerTx(r.chain ?? 'namada', r.value), '_blank', 'noopener');
          } else if (isPool) go('/trade');
          else {
            handOff();
            openAddress(r.value);
          }
        },
      });
    }
    if (!term) {
      for (const a of readRecent()) out.push({ id: `r:${a}`, group: 'Addresses', label: fmtAddr(a), sub: 'Opened recently', icon: 'account', run: () => { handOff(); openAddress(a); } });
    }

    // Actions
    const actions: Item[] = [
      { id: 'x:sources', group: 'Actions', label: 'Where every number comes from', sub: 'Sources, ages and cross-checks', icon: 'check', run: () => { handOff(); openSources(); } },
      ...(rewound ? [{ id: 'x:now', group: 'Actions' as const, label: REWIND_WORDS.back, sub: at ? REWIND_WORDS.banner(at) : undefined, icon: 'rewind' as const, run: () => { close(); backToNow(); } }] : []),
      ...(session
        ? [
            { id: 'x:settings', group: 'Actions' as const, label: 'Settings', sub: 'Alert rules, where alerts go, devices, your data', icon: 'account' as const, run: () => go('/settings') },
            { id: 'x:account', group: 'Actions' as const, label: 'Account', sub: `Signed in as ${fmtAddr(session.address)}`, icon: 'account' as const, run: () => { handOff(); openSheet({ kind: 'account' }); } },
            { id: 'x:out', group: 'Actions' as const, label: 'Sign out on this device', icon: 'close' as const, run: () => { close(); void signOut(); } },
          ]
        : [{ id: 'x:signin', group: 'Actions' as const, label: 'Sign in with your Namada wallet', sub: 'To choose alerts and where they go. Nothing moves.', icon: 'account' as const, run: () => { handOff(); openSignIn(); } }]),
      ...(['dark', 'light', 'system'] as ThemePref[])
        .filter((p) => p !== themePref)
        .map((p) => ({ id: `x:theme:${p}`, group: 'Actions' as const, label: p === 'system' ? 'Appearance: match my device' : `Appearance: ${THEME_LABELS[p].toLowerCase()}`, icon: 'info' as const, run: () => { setTheme(p); close(); } })),
    ];
    out.push(...actions.filter((a) => match(a.label, a.sub)));

    // Glossary: only when typed for
    if (term.length >= 2) {
      for (const g of GLOSSARY) {
        if (match(g.plain, g.expert, g.text)) out.push({ id: `g:${g.id}`, group: 'Glossary', label: g.plain, sub: g.text, hint: undefined });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, results, session, rewound, at, themePref]);

  const runnable = items.filter((i) => i.run);
  useEffect(() => setActive(0), [q]);
  const activeItem = runnable[Math.min(active, runnable.length - 1)];

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      // a search field would only clear itself on the first Escape; the palette closes at once
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, runnable.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeItem?.run) {
      e.preventDefault();
      activeItem.run();
    }
  };

  useEffect(() => {
    if (!activeItem) return;
    document.getElementById(`${listId}-${activeItem.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeItem, listId]);

  const submitRewind = (e: FormEvent) => {
    e.preventDefault();
    const t = Date.parse(`${when}:00Z`);
    if (!Number.isFinite(t)) return setWhenError('Pick a date and a time.');
    if (t > Date.now()) return setWhenError('Pick a time in the past.');
    setWhenError(null);
    close();
    setAt(t);
  };

  const groups = ['Views', 'Addresses', 'Actions', 'Glossary'] as const;
  const term = q.trim();

  return (
    <dialog
      ref={ref}
      className="pal"
      aria-label="Search"
      onPointerDown={(e) => {
        press.current = { down: e.target === e.currentTarget, up: false };
      }}
      onPointerUp={(e) => {
        press.current.up = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // a tap on the scrim: pressed and released there. A text selection dragged out of the box ends
        // with a click on the dialog too (the common ancestor), and must not close it.
        const p = press.current;
        press.current = { down: false, up: false };
        if (e.target === e.currentTarget && p.down && p.up) close();
      }}
    >
      <div className="pal__head">
        <Icon name="search" />
        <input
          ref={inputRef}
          className="pal__in"
          type="search"
          enterKeyHint="go"
          autoComplete="off"
          spellCheck={false}
          placeholder="A page, an address or a word"
          aria-label="Search pages, addresses and words"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeItem ? `${listId}-${activeItem.id}` : undefined}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="pal__x" aria-label="Close" onClick={close}>
          <Icon name="close" />
        </button>
      </div>

      <div className="pal__body">
        <div id={listId} role="listbox" aria-label="Results">
          {groups.map((g) => {
            const list = items.filter((i) => i.group === g);
            if (!list.length) return null;
            return (
              <div key={g} role="group" aria-labelledby={`${listId}-g-${g}`} className="pal__g">
                <p id={`${listId}-g-${g}`} className="pal__gh">{g}</p>
                <div className="pal__list">
                  {list.map((i) =>
                    i.run ? (
                      <div
                        key={i.id}
                        id={`${listId}-${i.id}`}
                        role="option"
                        aria-selected={activeItem?.id === i.id}
                        className="pal__opt"
                        onClick={i.run}
                        onMouseMove={() => setActive(runnable.indexOf(i))}
                      >
                        {i.icon ? <Icon name={i.icon} /> : null}
                        <span className="pal__ot">
                          <span className="pal__l">{i.label}</span>
                          {i.sub ? <span className="pal__s">{i.sub}</span> : null}
                        </span>
                        {i.hint ? <kbd className="pal__k kbd-hint" aria-hidden="true">{i.hint}</kbd> : null}
                      </div>
                    ) : (
                      <div key={i.id} role="option" aria-disabled="true" aria-selected={false} className="pal__opt pal__gl">
                        <span className="pal__ot">
                          <span className="pal__l">{i.label}</span>
                          <span className="pal__x2">{GLOSSARY.find((x) => `g:${x.id}` === i.id)?.expert}</span>
                          {i.sub ? <span className="pal__s">{i.sub}</span> : null}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </div>
            );
          })}
          {term.length >= 3 && searched === term && failed === term ? (
            <p className="pal__note" role="status">The search did not answer, so addresses and names cannot be looked up right now. The pages and actions here still work.</p>
          ) : term.length >= 3 && searched === term && !results.length && !looksLikeAddress(term) ? (
            <p className="pal__note">No address, transaction or name matches “{term}”.</p>
          ) : null}
        </div>

        <section className="pal__g" aria-labelledby={`${listId}-rw`}>
          <p id={`${listId}-rw`} className="pal__gh">Rewind</p>
          <form className="pal__rw" onSubmit={submitRewind}>
            <div className="pal__rwrow">
              <label className="pal__rwl">
                See every number as it was at (UTC)
                <input ref={rewindRef} className="pal__dt" type="datetime-local" step={60} max={maxWhen} value={when} onChange={(e) => setWhen(e.target.value)} required />
              </label>
              <button type="submit" className="pal__go">
                Rewind
                <Icon name="rewind" className="ico ico--btn" />
              </button>
            </div>
            {whenError ? <p className="pal__note" role="alert">{whenError}</p> : null}
            {presets.length ? (
              <div className="pal__pre" aria-label="Moments worth a look">
                {presets.map((p) => (
                  <button key={p.at} type="button" onClick={() => { close(); setAt(p.at); }}>
                    {p.label}
                    <small>{p.note ?? fmtUtcLong(p.at)}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </form>
        </section>
      </div>
    </dialog>
  );
}
