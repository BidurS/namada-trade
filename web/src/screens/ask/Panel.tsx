// The Ask chat. Below 1280 px a full-height modal sheet (a <dialog>: focus contained, Escape closes, swipe the head down
// to close, the input held above the keyboard by the visual viewport); from 1280 px a panel docked on the right that
// moves the page aside (html.ask-docked), so it never lies over the halt bar or a chart's controls.
//
// The thread lives in this component's memory and is gone on reload. Answers arrive whole, after they were checked:
// nothing is streamed and nothing types itself out; a finished answer fades in. Everything from the server is rendered
// as plain text.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { Link } from '../../app/index';
import { authFetch } from '../../lib/auth';
import { Ico } from '../../ui/ico';
import { useMinWidth } from '../../ui/useMinWidth';
import { useUiNow } from '../../ui/now';
import { ageOf, fmtUtcLong } from '../../lib/format';
import {
  ASK_COUNT_FROM, ASK_HISTORY_MAX, ASK_QUESTION_MAX, ASK_STARTERS, ASK_WORDS,
  type AskAnswer, type AskPageLink, type AskStamp, type AskTurn,
} from '../../../../shared/ask-words';
import { closeAsk, setAskResting, setAskThread, useAskStore } from './store';

const DOCK_FROM = 1280;
/** Longer than the server's own budget: it always answers first unless the network has gone. */
const CLIENT_TIMEOUT_MS = 20_000;
/** The tallest the input grows, in pixels (about six lines). */
const INPUT_MAX_PX = 156;
/** How far from the bottom still counts as reading the newest message. */
const STICK_PX = 48;
/** How far the head is dragged down before the sheet closes. */
const SWIPE_CLOSE_PX = 96;
const COPIED_MS = 1500;

type TurnState = 'pending' | 'answered' | 'refused' | 'not_covered' | 'failed' | 'invalid' | 'resting' | 'limit' | 'unavailable' | 'rate' | 'offline';
interface Turn {
  id: number;
  q: string;
  state: TurnState;
  text: string;
  pages: AskPageLink[];
  stamps: AskStamp[];
  followUps: string[];
  model?: string;
  at?: number;
}

const RETRIES: TurnState[] = ['failed', 'rate', 'offline'];

function history(turns: Turn[]): AskTurn[] {
  return turns.filter((t) => t.state === 'answered').slice(-ASK_HISTORY_MAX).map((t) => ({ q: t.q }));
}

function Stamps({ stamps }: { stamps: AskStamp[] }) {
  const now = useUiNow();
  if (!stamps.length) return null;
  return (
    <ul className="ask__stamps" aria-label={ASK_WORDS.stampsLabel}>
      {stamps.map((s) => (
        <li key={s.label} title={fmtUtcLong(s.at)}>
          <span className="dot" data-status={s.old ? 'old' : 'fresh'} />
          <span>{s.label} · {s.source} · {s.old ? `${ASK_WORDS.old} ` : ''}{ageOf(s.at, now)}</span>
        </li>
      ))}
    </ul>
  );
}

function AiMark({ model, at }: { model: string; at: number }) {
  const now = useUiNow();
  return <span className="ask__ai" title={fmtUtcLong(at)}>{ASK_WORDS.aiLabel(model)} · {ageOf(at, now)}</span>;
}

function CopyAnswer({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), COPIED_MS);
    }).catch(() => {});
  };
  return (
    <button type="button" className="ask__copy" onClick={copy}>
      <Ico name={done ? 'check' : 'copy'} className="ico" />
      <span aria-live="polite">{done ? ASK_WORDS.copied : ASK_WORDS.copy}</span>
    </button>
  );
}

function Answer({ turn, last, busy, onPick, onLink }: { turn: Turn; last: boolean; busy: boolean; onPick: (q: string) => void; onLink: () => void }) {
  return (
    <div className="ask__a">
      {turn.text.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}
      <Stamps stamps={turn.stamps} />
      {turn.pages.length ? (
        <ul className="ask__chips" aria-label={ASK_WORDS.pagesLabel}>
          {turn.pages.map((p) => (
            <li key={p.id}><Link to={p.path} className="ask__page" onClick={onLink}>{p.label}</Link></li>
          ))}
        </ul>
      ) : null}
      <div className="ask__meta">
        {turn.model && turn.at != null ? <AiMark model={turn.model} at={turn.at} /> : null}
        <CopyAnswer text={turn.text} />
      </div>
      {last && turn.followUps.length ? (
        <ul className="ask__chips" aria-label={ASK_WORDS.followUps}>
          {turn.followUps.map((q) => (
            <li key={q}><button type="button" className="ask__chip" disabled={busy} onClick={() => onPick(q)}>{q}</button></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function useKeyboardAwareSheet(root: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const el = root.current;
    if (!active || !vv || !el) return;
    const apply = () => {
      el.style.setProperty('--ask-h', `${vv.height}px`);
      el.style.setProperty('--ask-top', `${vv.offsetTop}px`);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, [root, active]);
}

/** The docked panel starts under the header and any banner, and moves up as they scroll away. */
function useDockTop(root: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    document.documentElement.classList.add('ask-docked');
    const apply = () => {
      const header = document.querySelector('.hdr')?.getBoundingClientRect().bottom ?? 0;
      const main = document.querySelector('.app__main')?.getBoundingClientRect().top ?? 0;
      root.current?.style.setProperty('--ask-top', `${Math.max(header, main)}px`);
    };
    apply();
    window.addEventListener('scroll', apply, { passive: true });
    window.addEventListener('resize', apply);
    return () => {
      document.documentElement.classList.remove('ask-docked');
      window.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
    };
  }, [root, active]);
}

export default function AskPanel({ open }: { open: boolean }) {
  const docked = useMinWidth(DOCK_FROM);
  const { state } = useAskStore();
  const tid = useId();
  const root = useRef<HTMLElement | null>(null);
  const setRoot = useCallback((el: HTMLElement | null) => { root.current = el; }, []);
  const input = useRef<HTMLTextAreaElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const turnsRef = useRef<Turn[]>(turns);
  turnsRef.current = turns;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const stick = useRef(true);
  const [unseen, setUnseen] = useState(false);
  const nextId = useRef(1);
  const coarse = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const resting = state?.state === 'resting' ? state.text : null;

  useDockTop(root, open && docked);
  useKeyboardAwareSheet(root, open && !docked);
  useEffect(() => setAskThread(turns.length > 0), [turns.length]);

  // The modal: open and close follow the store; the browser's own close (Escape) reports back.
  useLayoutEffect(() => {
    const d = root.current;
    if (docked || !(d instanceof HTMLDialogElement)) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open, docked]);

  // Where focus goes on opening: the input, except on a touch screen, where it would throw the keyboard over the starters.
  useEffect(() => {
    if (!open) return;
    if (coarse) root.current?.focus({ preventScroll: true });
    else input.current?.focus({ preventScroll: true });
  }, [open, docked, coarse]);

  // Grow with the text, up to its limit.
  useLayoutEffect(() => {
    const t = input.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, INPUT_MAX_PX)}px`;
  }, [draft, open]);

  // A new message scrolls into view, unless the reader has scrolled up to read something else.
  useLayoutEffect(() => {
    const t = thread.current;
    if (!t) return;
    if (stick.current) { t.scrollTop = t.scrollHeight; setUnseen(false); }
    else if (turns.length) setUnseen(true);
  }, [turns]);

  const onThreadScroll = () => {
    const t = thread.current;
    if (!t) return;
    stick.current = t.scrollHeight - t.scrollTop - t.clientHeight < STICK_PX;
    if (stick.current) setUnseen(false);
  };
  const toLatest = () => {
    stick.current = true;
    const t = thread.current;
    if (t) t.scrollTop = t.scrollHeight;
    setUnseen(false);
    input.current?.focus({ preventScroll: true });
  };

  const settle = useCallback((id: number, patch: Partial<Turn>) => {
    setTurns((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, []);

  const send = useCallback(async (text: string, replaces?: number) => {
    const q = text.trim();
    if (!q || q.length > ASK_QUESTION_MAX || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const id = nextId.current++;
    const earlier = history(turnsRef.current.filter((t) => t.id !== replaces));
    setTurns((xs) => [...xs.filter((x) => x.id !== replaces), { id, q, state: 'pending', text: '', pages: [], stamps: [], followUps: [] }]);
    setDraft('');
    stick.current = true;
    input.current?.focus({ preventScroll: true });

    // Whatever goes wrong, the question goes back in the box for the reader to send again or change.
    const fail = (state: TurnState, words: string) => {
      settle(id, { state, text: words });
      setDraft((d) => d || q);
    };
    try {
      // authFetch sends the sign-in when there is one: the larger daily limit is the wallet's
      const res = await authFetch('/api/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, history: earlier }),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
      if (res.status === 429) fail('rate', ASK_WORDS.rate);
      else {
        const a = (await res.json()) as AskAnswer;
        if (a.status === 'answered') settle(id, { state: 'answered', text: a.text, pages: a.pages, stamps: a.stamps, followUps: a.followUps, model: a.model, at: a.at });
        else {
          fail(a.status, a.text);
          if (a.status === 'resting') setAskResting(a.text);
        }
      }
    } catch (e) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) fail('offline', ASK_WORDS.offline);
      else if (e instanceof TypeError) fail('offline', ASK_WORDS.offline);
      else fail('failed', ASK_WORDS.failed);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [settle]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(draft);
    }
  };
  const onRootKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape' && docked) closeAsk();
    e.stopPropagation();
  };

  // The head of the sheet follows a finger down; far enough and it closes, otherwise it springs back.
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const onHeadDown = (e: PointerEvent<HTMLElement>) => {
    if (docked || (e.target as HTMLElement).closest('button')) return;
    drag.current = { y: e.clientY, dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onHeadMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !root.current) return;
    d.dy = Math.max(0, e.clientY - d.y);
    root.current.style.transform = `translateY(${d.dy}px)`;
  };
  const onHeadUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !root.current) return;
    root.current.style.transform = '';
    if (d.dy > SWIPE_CLOSE_PX) closeAsk();
  };

  const onLink = () => { if (!docked) closeAsk(); };
  const left = ASK_QUESTION_MAX - draft.length;
  const blocked = busy || !!resting || !draft.trim() || left < 0;
  const lastAnswered = turns.reduce((n, t) => (t.state === 'answered' ? t.id : n), 0);

  const body: ReactNode = (
    <>
      <header className="ask__head" onPointerDown={onHeadDown} onPointerMove={onHeadMove} onPointerUp={onHeadUp} onPointerCancel={onHeadUp}>
        <span className="ask__grip" aria-hidden="true" />
        <h2 id={tid} className="ask__t">{ASK_WORDS.title}</h2>
        <button type="button" className="icon-btn" aria-label={ASK_WORDS.close} onClick={closeAsk}><Ico name="close" className="ico" /></button>
      </header>

      <div className="ask__thread" ref={thread} onScroll={onThreadScroll} role="log" aria-live="polite" aria-relevant="additions" tabIndex={0} aria-labelledby={tid}>
        {!turns.length ? (
          <div className="ask__empty">
            <p className="ask__emptyh">{ASK_WORDS.emptyHead}</p>
            <p className="ask__lead">{ASK_WORDS.emptyLead}</p>
            <ul className="ask__chips ask__chips--stack" aria-label={ASK_WORDS.starters}>
              {ASK_STARTERS.map((q) => (
                <li key={q}><button type="button" className="ask__chip" disabled={busy || !!resting} onClick={() => send(q)}>{q}</button></li>
              ))}
            </ul>
          </div>
        ) : null}
        {turns.map((t) => (
          <article className="ask__turn" key={t.id}>
            <p className="ask__q">{t.q}</p>
            {t.state === 'pending' ? (
              <p className="ask__wait"><span className="ask__pulse" aria-hidden="true" />{ASK_WORDS.waiting}</p>
            ) : t.state === 'answered' ? (
              <Answer turn={t} last={t.id === lastAnswered} busy={busy} onPick={send} onLink={onLink} />
            ) : (
              <div className="ask__a ask__note">
                <p>{t.text}</p>
                {RETRIES.includes(t.state) ? <button type="button" className="ask__chip" disabled={busy} onClick={() => send(t.q, t.id)}>{ASK_WORDS.retry}</button> : null}
              </div>
            )}
          </article>
        ))}
      </div>

      {unseen ? <button type="button" className="ask__latest" onClick={toLatest}>{ASK_WORDS.newAnswer}</button> : null}

      <form className="ask__form" onSubmit={(e) => { e.preventDefault(); send(draft); }}>
        {resting && turns[turns.length - 1]?.state !== 'resting' ? <p className="ask__resting">{resting}</p> : null}
        <div className="ask__box">
          <label className="sr-only" htmlFor={`${tid}-in`}>{ASK_WORDS.label}</label>
          <textarea
            ref={input}
            id={`${tid}-in`}
            className="ask__in"
            rows={1}
            value={draft}
            placeholder={ASK_WORDS.placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
          />
          <button type="submit" className="ask__send" aria-label={ASK_WORDS.send} disabled={blocked}>
            <Ico name="arrow" className="ico" />
          </button>
        </div>
        {draft.length >= ASK_COUNT_FROM ? <p className="ask__count" data-over={left < 0 || undefined}>{ASK_WORDS.count(left)}</p> : null}
      </form>
    </>
  );

  return docked
    ? <aside ref={setRoot} className="ask ask--docked ground-ink" hidden={!open} aria-labelledby={tid} onKeyDown={onRootKey}>{body}</aside>
    : <dialog ref={setRoot} className="ask ask--modal ground-ink" aria-labelledby={tid} tabIndex={-1} onClose={closeAsk} onKeyDown={onRootKey}>{body}</dialog>;
}
