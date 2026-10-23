// Pair a phone (S7): a signed-in device makes a one-time code, and a QR of the /alerts#pair=CODE
// link, that gives a phone the same address and settings. The phone never holds a key. Kept from
// the old PairDevice; the QR library loads with import() only when a code is made (seo Must 6).
// The code rides in the fragment, which a browser never sends: a query (?pair=CODE) reached the
// Worker with the page request and so its request logs, where a reader of the logs could claim the
// code before the phone pressed Pair. The app still opens an old ?pair= link (app/overlays.tsx).
import { useEffect, useState } from 'react';
import { createPairCode } from '../../lib/auth';
import { Button, Notice } from '../../ui/index';
import { fmtUtcClock } from '../../lib/format';
import { plainError, useCopy } from './util';

/** The pairing link: the code in the fragment, so it never leaves the phone's browser in a request. */
const pairLink = (code: string) => `${location.origin}/alerts#pair=${encodeURIComponent(code)}`;

type ToDataURL = (text: string, opts: Record<string, unknown>) => Promise<string>;

async function qrFor(url: string): Promise<string | null> {
  try {
    const mod = (await import('qrcode')) as unknown as { toDataURL?: ToDataURL; default?: { toDataURL?: ToDataURL } };
    const toDataURL = mod.toDataURL ?? mod.default?.toDataURL;
    return toDataURL ? await toDataURL(url, { margin: 1, width: 360, color: { dark: '#000000', light: '#ffffff' } }) : null;
  } catch {
    return null;
  }
}

export function PairDevice() {
  const [pair, setPair] = useState<{ code: string; expiresAt: number } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, copy] = useCopy();

  // a one-second countdown only while a code is live
  useEffect(() => {
    if (!pair) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pair]);

  const make = async () => {
    setBusy(true);
    setErr(null);
    try {
      const p = await createPairCode();
      setPair(p);
      setNow(Date.now());
      setQr(null);
      setQr(await qrFor(pairLink(p.code)));
    } catch (e) {
      setErr(plainError(e, 'A code could not be made right now.'));
    } finally {
      setBusy(false);
    }
  };

  const left = pair ? Math.max(0, Math.round((pair.expiresAt - now) / 1000)) : 0;
  const live = !!pair && left > 0;
  const link = pair ? pairLink(pair.code) : '';

  return (
    <div className="sh-pairdev">
      <div className="sh-pairdev__head">
        <div>
          <p className="sh-pairdev__t">Pair a phone</p>
          <p className="sh-cap">Scan the code with the phone, or type the characters on its sign-in screen. The phone gets the same address and settings and never holds a key.</p>
        </div>
        <Button size="sm" busy={busy} onClick={() => void make()}>{live ? 'New code' : 'Make a code'}</Button>
      </div>
      {live && pair ? (
        <div className="sh-pairdev__code" aria-live="polite">
          <div className="sh-pairdev__qr">{qr ? <img src={qr} alt={`QR code for the pairing link with code ${pair.code}`} width={160} height={160} /> : <span className="skel__b sh-pairdev__qrwait" aria-hidden="true" />}</div>
          <div className="sh-pairdev__txt">
            <p className="sh-pairdev__c">{pair.code.toUpperCase()}</p>
            <p className="sh-cap">
              Works once. Ends in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}, at {fmtUtcClock(pair.expiresAt)}.
            </p>
            <p className="sh-pairdev__link">{link}</p>
            <button type="button" className="sh-act" onClick={() => copy(link)}>{copied ? 'Copied' : 'Copy the link'}</button>
          </div>
        </div>
      ) : null}
      {pair && !live ? <p className="sh-msg">That code has ended. Make a new one.</p> : null}
      {err ? <Notice tone="danger" title="No code was made">{err}</Notice> : null}
    </div>
  );
}
