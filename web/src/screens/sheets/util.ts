// Small helpers shared by the sheets (S7) and the Alerts and Settings screens (S6).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '../../lib/auth';

/** Words the page never shows outside the glossary, "How it is computed" and "For developers" (G5). */
const EXPERT = /\b(sqs|ibc|dex|pos|masp|abci|rpc|cron|webhooks?|npm|d[1-7])\b/i;

/**
 * A server or wallet error in plain words. Known server messages are reworded (some name the
 * expert term); anything else passes through unless it carries an expert word or a status line.
 */
export function plainError(e: unknown, fallback = 'Something went wrong. Nothing was changed.'): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const m = raw.trim();
  if (!m) return fallback;
  if (/sign in first|unauthori[sz]ed|HTTP 401/i.test(m)) return 'Your sign-in has ended. Sign in again to change this.';
  if (/not a discord webhook/i.test(m)) return 'That is not a link Discord gives for posting to a channel. Copy it again from the channel\'s settings.';
  if (/no discord webhook saved/i.test(m)) return 'No Discord channel link is saved yet.';
  if (/quiet hours must be/i.test(m)) return 'Quiet hours must start between 00:00 and 23:00 and end by 24:00, in UTC.';
  if (/api key cannot mint/i.test(m)) return 'A key cannot make another key. Sign in with a wallet to make one.';
  if (/SETTINGS_KEY|not configured/i.test(m)) return 'Saving settings is not available on this server right now.';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) return 'The request did not reach the server. Nothing was changed.';
  if (/HTTP 5\d\d/i.test(m)) return 'The server did not answer. Nothing was changed.';
  if (/HTTP \d{3}/i.test(m) || EXPERT.test(m)) return fallback;
  const s = m.charAt(0).toUpperCase() + m.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** How a session was made, in plain words. */
export const viaWord = (v: Session['via'] | 'api' | string): string =>
  v === 'namada' ? 'Namada Keychain' : v === 'keplr' ? 'Keplr' : v === 'pair' ? 'Paired device' : v === 'api' ? 'API key' : 'Wallet';

/** Copy text to the clipboard; `copied` is true for a moment after it worked. */
export function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(t.current), []);
  const copy = useCallback((text: string) => {
    const done = () => {
      setCopied(true);
      clearTimeout(t.current);
      t.current = setTimeout(() => setCopied(false), 2000);
    };
    try {
      const p = navigator.clipboard?.writeText(text);
      if (p) p.then(done, () => undefined);
    } catch {
      /* no clipboard: the text stays selectable on the page */
    }
  }, []);
  return [copied, copy];
}

/** Save a JSON value as a file the browser downloads. */
export function downloadJson(value: unknown, name: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.dataset.native = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
