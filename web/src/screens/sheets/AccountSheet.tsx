// Account sheet (S7): what the header's account button opens when signed in. Who you are (the
// address with copy and the explorer, the linked address, how the session was made and when it
// ends), where to manage things (Settings, Alerts, Discord, Devices, API keys), the appearance, and
// Sign out on this device. No confirm() prompt anywhere. Signed out it offers Sign in.
import { Link, THEME_LABELS, useNow, useOverlays, useSession, useTheme, type ThemePref } from '../../app/index';
import { Button, Segmented, Sheet } from '../../ui/index';
import { Icon } from '../../ui/Icon';
import { explorerAddr, fmtAddr, fmtAge, fmtUtcLong } from '../../lib/format';
import { useCopy, viaWord } from './util';

const PLACES: { to: string; label: string; sub: string }[] = [
  { to: '/settings', label: 'Settings', sub: 'Alert rules, delivery, devices and your data' },
  { to: '/alerts', label: 'Alerts', sub: 'What crossed an alert size since your last visit' },
  { to: '/settings#delivery', label: 'Discord', sub: 'Where your alerts are posted, and a test message' },
  { to: '/settings#devices', label: 'Devices', sub: 'Signed-in devices, and pairing a phone' },
  { to: '/settings#developers', label: 'API keys', sub: 'Keys for scripts and bots' },
];

export function AccountSheet({ onClose }: { onClose: () => void }) {
  const { session, signOut } = useSession();
  const { openSignIn } = useOverlays();
  const [pref, , setPref] = useTheme();
  const [copied, copy] = useCopy();
  useNow(); // re-render as the end of the sign-in nears
  const wall = Date.now();

  const appearance = (
    <section className="sh-acct__sec" aria-labelledby="sh-acct-look">
      <h3 id="sh-acct-look" className="sh-h3">Appearance</h3>
      <Segmented<ThemePref>
        label="Appearance"
        value={pref}
        onChange={setPref}
        options={(['dark', 'light', 'system'] as ThemePref[]).map((p) => ({ value: p, label: THEME_LABELS[p] }))}
        block
      />
    </section>
  );

  if (!session) {
    return (
      <Sheet open onClose={onClose} title="Your account" lead="Not signed in. Signing in moves nothing; it lets you choose your alerts and where they go." className="sh-acct">
        <div className="sheet__body sh-acct__body">
          <Button
            variant="primary"
            block
            aria-haspopup="dialog"
            onClick={() => {
              onClose();
              openSignIn();
            }}
          >
            Sign in
          </Button>
          {appearance}
        </div>
      </Sheet>
    );
  }

  const ends = session.expiresAt - wall;
  return (
    <Sheet
      open
      onClose={onClose}
      title="Your account"
      lead={<>Signed in as <b>{fmtAddr(session.address)}</b> with {viaWord(session.via)}. Signing in moved nothing.</>}
      className="sh-acct"
      foot={
        <Button
          block
          onClick={() => {
            onClose();
            void signOut();
          }}
        >
          Sign out on this device
        </Button>
      }
    >
      <div className="sheet__body sh-acct__body">
        <div className="sh-addr__id">
          <p className="sh-addr__full">{session.address}</p>
          <div className="sh-addr__acts">
            <button type="button" className="sh-act" onClick={() => copy(session.address)}>
              <Icon name={copied ? 'check' : 'copy'} className="ico ico--inline" />
              {copied ? 'Copied' : 'Copy address'}
            </button>
            <a className="sh-act" href={explorerAddr(session.address)} target="_blank" rel="noreferrer">
              <Icon name="external" className="ico ico--inline" />
              Explorer
            </a>
          </div>
          {session.linked ? <p className="sh-cap">Linked address: <span className="mono">{fmtAddr(session.linked)}</span></p> : null}
          <p className="sh-cap" title={fmtUtcLong(session.expiresAt)}>
            {ends > 0 ? `This sign-in ends in ${fmtAge(ends)}, on ${fmtUtcLong(session.expiresAt)}.` : 'This sign-in has ended.'}
          </p>
        </div>

        <nav aria-label="Your account">
          <ul className="sh-places">
            {PLACES.map((p) => (
              <li key={p.to}>
                <Link className="sh-place" to={p.to} onClick={() => onClose()}>
                  <span className="sh-place__tx">
                    <span className="sh-place__t">{p.label}</span>
                    <span className="sh-place__s">{p.sub}</span>
                  </span>
                  <Icon name="arrow" className="ico sh-place__i" />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {appearance}
      </div>
    </Sheet>
  );
}
