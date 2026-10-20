// Sign in (S7). system.md 9.8, owner decision 9 (wallet names only, no logos), N5.
//
// Signing in proves an address by signing one short message: no transaction, no fee, nothing
// moves. Three ways, each saying what will happen before you press it: Namada Keychain (a desktop
// browser extension), Keplr (desktop extension or the Keplr app's own browser) and a pairing code
// from a device that is already signed in. /alerts?pair=CODE opens this sheet on the code step and
// claims the code at once when it is well formed. lib/auth.ts is used unchanged.
import { useEffect, useId, useRef, useState } from 'react';
import { claimPairCode, hasKeplr, hasNamada, loginWithKeplr, loginWithNamada, type Session } from '../../lib/auth';
import { useSession } from '../../app/index';
import { Button, Notice, Sheet } from '../../ui/index';
import { Icon } from '../../ui/Icon';
import { plainError } from './util';

/** Pairing codes are this many hexadecimal characters (worker/src/auth.ts). */
const CODE_LEN = 8;
const CODE_RE = new RegExp(`^[0-9a-fA-F]{${CODE_LEN}}$`);
type Way = 'namada' | 'keplr' | 'pair';

export function SignInSheet({ code, onClose }: { code: string | null; onClose: () => void }) {
  const { setSession } = useSession();
  const [busy, setBusy] = useState<Way | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(!!code);
  const [val, setVal] = useState(() => (code ?? '').replace(/[^0-9a-fA-F]/g, '').slice(0, CODE_LEN));
  const namada = hasNamada();
  const keplr = hasKeplr();
  const inputRef = useRef<HTMLInputElement>(null);
  const pairId = useId();

  const run = async (way: Way, fn: () => Promise<Session>) => {
    setBusy(way);
    setErr(null);
    try {
      const s = await fn();
      setSession(s);
      onClose();
    } catch (e) {
      setErr(plainError(e, 'Signing in did not finish. Nothing moved.'));
      setBusy(null);
    }
  };

  // a well-formed code from the link is claimed straight away (the old LoginModal did the same)
  useEffect(() => {
    if (code && CODE_RE.test(code)) void run('pair', () => claimPairCode(code));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (pairOpen && !code) inputRef.current?.focus();
  }, [pairOpen, code]);

  const claim = () => {
    if (CODE_RE.test(val) && !busy) void run('pair', () => claimPairCode(val));
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title="Sign in with your Namada wallet"
      lead={<b>No transaction, no fee, nothing moves.</b>}
      className="sh-si"
      foot={<p className="sh-cap sh-si__foot">NamadaTrade never gets your wallet&rsquo;s secret. What you sign holds only your address and a random one-time number. Sessions are listed, with a way to end each one, under Settings, Devices.</p>}
    >
      <div className="sheet__body sh-si__body">
        <p className="sh-si__why">
          You sign one short message that proves the address is yours. Signing in is needed only to choose your alerts, your watchlist and where alerts go; everything else on this site is public.
        </p>
        {!namada && !keplr ? (
          <Notice tone="info" title="No wallet extension in this browser">
            Namada Keychain and Keplr are extensions for desktop browsers, and neither is in this one. Without one, pair this device with a code from a computer that is signed in, or, on a phone, open this page inside the Keplr app&rsquo;s own browser.
          </Notice>
        ) : null}

        <ol className="sh-ways">
          <Way
            title="Namada Keychain"
            sub="Addresses that start with tnam1. A browser extension for desktop."
            steps={['Keychain asks to connect to this site', 'It asks you to sign the message', 'You are signed in']}
            missing={namada ? null : 'Not found in this browser. Namada Keychain runs in desktop browsers only.'}
            busy={busy === 'namada'}
            disabled={!!busy}
            onClick={() => void run('namada', loginWithNamada)}
          />
          <Way
            title="Keplr"
            sub="Addresses that start with osmo1: the Osmosis side of your trading."
            steps={['Keplr asks to turn on Osmosis for this site', 'It asks you to sign the message', 'You are signed in']}
            missing={keplr ? null : 'Not found in this browser. On a phone, open this page in the Keplr app’s browser.'}
            busy={busy === 'keplr'}
            disabled={!!busy}
            onClick={() => void run('keplr', loginWithKeplr)}
          />
          <li className="sh-way">
            <button
              type="button"
              className="sh-way__b"
              aria-expanded={pairOpen}
              aria-controls={pairId}
              disabled={busy === 'pair'}
              onClick={() => setPairOpen((o) => !o)}
            >
              <span className="sh-way__tx">
                <span className="sh-way__t">Pair with a code</span>
                <span className="sh-way__s">{namada || keplr ? 'Use this device with an address already signed in elsewhere.' : 'The usual way in on a phone.'}</span>
              </span>
              <Icon name="chev" className={`ico sh-way__i${pairOpen ? ' is-open' : ''}`} />
            </button>
            <ol className="sh-way__steps">
              <li>On a signed-in computer, open Settings, Devices, and make a code</li>
              <li>Scan it, or type its {CODE_LEN} characters here</li>
              <li>This device gets the same address and settings</li>
            </ol>
            <div id={pairId} className="sh-pair" hidden={!pairOpen}>
              <label className="sh-pair__l" htmlFor={`${pairId}in`}>Pairing code</label>
              <div className="sh-pair__row">
                <input
                  ref={inputRef}
                  id={`${pairId}in`}
                  className="sh-pair__in"
                  inputMode="text"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={CODE_LEN}
                  value={val.toUpperCase()}
                  onChange={(e) => setVal(e.target.value.replace(/[^0-9a-fA-F]/g, '').slice(0, CODE_LEN))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') claim();
                  }}
                  aria-describedby={`${pairId}n`}
                />
                <Button variant="primary" busy={busy === 'pair'} disabled={!CODE_RE.test(val) || !!busy} onClick={claim}>
                  Pair
                </Button>
              </div>
              <p id={`${pairId}n`} className="sh-cap">
                {val.length} of {CODE_LEN} characters. A code works once and ends a few minutes after it is made. This device never holds a key, and any of your devices can sign it out.
              </p>
            </div>
          </li>
        </ol>

        {err ? (
          <Notice tone="danger" title="Signing in did not finish" live>
            {err}
          </Notice>
        ) : null}
      </div>
    </Sheet>
  );
}

function Way({ title, sub, steps, missing, busy, disabled, onClick }: { title: string; sub: string; steps: string[]; missing: string | null; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <li className="sh-way" data-missing={missing ? '' : undefined}>
      <button type="button" className="sh-way__b" disabled={disabled || !!missing} aria-busy={busy || undefined} onClick={onClick}>
        <span className="sh-way__tx">
          <span className="sh-way__t">{title}</span>
          <span className="sh-way__s">{sub}</span>
        </span>
        <Icon name="arrow" className="ico sh-way__i" />
      </button>
      {missing ? <p className="sh-way__na">{missing}</p> : null}
      <ol className="sh-way__steps">
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
    </li>
  );
}
