// Settings (/settings, noindex), S6. system.md 9.7; build-plan 8 "Settings"; owner decision 5.
//
// Sections in order, each a titled panel: Alert rules (a Switch and a size per rule, with the
// dollar value derived), Where alerts go (Discord: the saved link is never shown, a test message,
// other channels), Watchlist, Quiet hours, Devices (every session, sign out, pair a phone), For
// developers (API keys: make, copy, revoke; operator text is allowed here), Your data (what is
// stored, who can read it, export, delete everything: the one destructive button) and Appearance.
// Phone: one column. From 1024 px a sticky section list beside the panels.
//
// Each control saves what it changed (the server merges partial updates). lib/auth.ts and the
// api.ts settings functions are used unchanged. Signed out, the page says what signing in is for,
// shows what would be stored and who can read it, and keeps Appearance (it needs no account).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AlertRuleId, SessionInfo, UserSettings } from '../../../../shared/types';
import { SITE } from '../../../../shared/copy';
import type { ScreenProps } from '../../app/index';
import { navigate, THEME_LABELS, useHeaderPrice, useLocation, useNow, useOverlays, useReplay, useSession, useTheme, type ThemePref } from '../../app/index';
import { createApiKey, deleteMe, exportMe, fetchSessions, revokeSession, testDiscord } from '../../api';
import { Button, Derived, Field, Notice, Segmented, Skeleton, SourceLine, Switch, Tag, Term, type Stamp } from '../../ui/index';
import { Icon } from '../../ui/Icon';
import { fmtAddr, fmtAgo, fmtNamRule, fmtUsdRule, fmtUtcClock, fmtUtcLong } from '../../lib/format';
import { conditionFor, useAlertRules, type RuleView } from '../alerts/rules';
import { PairDevice } from '../sheets/PairDevice';
import { downloadJson, plainError, useCopy, viaWord } from '../sheets/util';
import { useUserSettings } from './account';

type Save = (patch: unknown) => Promise<UserSettings>;
interface Section { id: string; label: string }

const SIGNED_IN: Section[] = [
  { id: 'rules', label: 'Alert rules' },
  { id: 'delivery', label: 'Where alerts go' },
  { id: 'watchlist', label: 'Watchlist' },
  { id: 'quiet', label: 'Quiet hours' },
  { id: 'devices', label: 'Devices' },
  { id: 'developers', label: 'For developers' },
  { id: 'data', label: 'Your data' },
  { id: 'appearance', label: 'Appearance' },
];
const SIGNED_OUT: Section[] = [
  { id: 'signin', label: 'Sign in' },
  { id: 'data', label: 'Your data' },
  { id: 'appearance', label: 'Appearance' },
];

/** A saved-or-not line for one panel. */
function useStatus() {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await fn();
      setStatus({ ok: true, text: ok });
      return true;
    } catch (e) {
      setStatus({ ok: false, text: plainError(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { status, busy, run, setStatus };
}

function StatusLine({ status }: { status: { ok: boolean; text: string } | null }) {
  if (!status) return <p className="st-status" role="status" />;
  return status.ok ? (
    <p className="st-status" role="status">
      <Icon name="check" className="ico ico--inline" />
      {status.text}
    </p>
  ) : (
    <div role="status">
      <Notice tone="danger" title="Not saved">{status.text}</Notice>
    </div>
  );
}

function Panel({ id, title, lead, children }: { id: string; title: string; lead?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="st-panel" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="h2">{title}</h2>
      {lead ? <p className="st-lead">{lead}</p> : null}
      {children}
    </section>
  );
}

export default function SettingsScreen({ route }: ScreenProps) {
  const { session, signOut } = useSession();
  const { openSignIn } = useOverlays();
  const user = useUserSettings(session);
  const loc = useLocation();
  const sections = session ? SIGNED_IN : SIGNED_OUT;
  const [active, setActive] = useState<string>(sections[0].id);
  const panelsRef = useRef<HTMLDivElement>(null);

  // #delivery, #devices …: scroll there once the panels exist (the shell scrolls to the top on a new path)
  const ready = !session || !!user.settings || !!user.error;
  useEffect(() => {
    let id = '';
    try { id = decodeURIComponent(loc.hash.slice(1)); } catch { return; }
    if (!id || !ready) return;
    const el = document.getElementById(id);
    if (!el) return;
    const raf = requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(raf);
  }, [loc.hash, ready]);

  // the section list follows the reading position (desktop)
  useEffect(() => {
    const root = panelsRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = sections.find((s) => seen.get(s.id));
        if (first) setActive(first.id);
      },
      { rootMargin: '-20% 0px -70% 0px' },
    );
    root.querySelectorAll('.st-panel[id]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sections, ready]);

  const signOutHere = async () => {
    await signOut();
    navigate('/alerts');
  };

  return (
    <div className="st">
      <section className="band ground-accent st-hero" aria-labelledby="st-h1">
        <div className="wrap">
          <p className="eyebrow">Your account</p>
          <h1 id="st-h1" className="h1">{route?.h1}</h1>
          <p className="sub">
            {session ? (
              <>
                Signed in as <span className="st-addr">{fmtAddr(session.address)}</span> with {viaWord(session.via)}. Signing in moved nothing.
              </>
            ) : (
              'Alert rules, where alerts go, your devices and your data belong to a wallet address. Signing in moves nothing.'
            )}
          </p>
        </div>
        <div className="ruler" aria-hidden="true" />
      </section>

      <div className="band ground-ink st-body">
        <div className="wrap st-grid">
          <nav className="st-nav" aria-label="Settings sections">
            <ul>
              {sections.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`} aria-current={active === s.id ? 'true' : undefined}>{s.label}</a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="st-panels" ref={panelsRef}>
            {!session ? (
              <Panel id="signin" title="Sign in" lead="Signing in with a Namada or Keplr wallet lets you choose which alerts reach you, at what size and where. You sign one short message; no transaction, no fee, nothing moves.">
                <p>
                  <Button variant="primary" aria-haspopup="dialog" onClick={() => openSignIn()}>Sign in</Button>
                </p>
              </Panel>
            ) : user.error && !user.settings ? (
              <Panel id="rules" title="Alert rules">
                <Notice tone={user.expired ? 'warning' : 'danger'} title={user.expired ? 'Your sign-in has ended' : 'Your settings could not be read'}>
                  {user.error}
                </Notice>
                <p>
                  {user.expired ? (
                    <Button variant="primary" aria-haspopup="dialog" onClick={() => openSignIn()}>Sign in again</Button>
                  ) : (
                    <Button onClick={user.reload}>Try again</Button>
                  )}
                </p>
              </Panel>
            ) : (
              <SignedIn s={user.settings} save={user.save} onSignOutHere={signOutHere} />
            )}

            <DataPanel s={user.settings} signedIn={!!session} onDeleted={signOutHere} />
            <AppearancePanel />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- signed in: the first six panels
function SignedIn({ s, save, onSignOutHere }: { s: UserSettings | null; save: Save; onSignOutHere: () => void }) {
  const { rules, stamp } = useAlertRules();
  const sessions = useSessions();
  if (!s) {
    return (
      <>
        {SIGNED_IN.slice(0, 6).map((sec) => (
          <Panel key={sec.id} id={sec.id} title={sec.label}>
            <Skeleton rows={sec.id === 'rules' ? 5 : 2} heights={[sec.id === 'rules' ? 160 : 64]} label={sec.label.toLowerCase()} />
          </Panel>
        ))}
      </>
    );
  }
  return (
    <>
      <RulesPanel s={s} save={save} rules={rules} rulesStamp={stamp} />
      <DeliveryPanel s={s} save={save} />
      <WatchlistPanel s={s} save={save} />
      <QuietPanel s={s} save={save} />
      <DevicesPanel sessions={sessions} onSignOutHere={onSignOutHere} />
      <DevelopersPanel sessions={sessions} />
    </>
  );
}

// ---------------------------------------------------------------- alert rules
const digits = (v: string) => v.replace(/[\s,_]/g, '');

function RulesPanel({ s, save, rules, rulesStamp }: { s: UserSettings; save: Save; rules: RuleView[] | null; rulesStamp: Stamp | null }) {
  const { rewound } = useReplay();
  const price = useHeaderPrice();
  const prefs = s.notifications.rules as Record<string, { on: boolean; thresholdNam: number }>;
  const ids = (rules?.map((r) => r.id) ?? Object.keys(prefs)).filter((id) => prefs[id]);
  const byId = useMemo(() => new Map((rules ?? []).map((r) => [r.id, r])), [rules]);
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(prefs).map(([k, v]) => [k, fmtNamRule(v.thresholdNam)])));
  const [fieldErr, setFieldErr] = useState<Record<string, string | null>>({});
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const st = useStatus();
  const priceStamp: Stamp = price.stamp ?? { source: 'Osmosis quote', at: null, status: 'missing', note: 'The price has not arrived yet.' };
  const mineStamp: Stamp = { source: 'Your settings', plain: 'Your settings', at: s.updatedAt, status: 'live' };
  const priceWord = rewound ? 'at the price then' : 'at today’s price';

  const saveRule = async (id: string, next: { on: boolean; thresholdNam: number }, ok: string) => {
    await st.run(() => save({ notifications: { rules: { [id as AlertRuleId]: next } } }), ok);
  };

  const toggle = async (id: string, on: boolean) => {
    setOptimistic((o) => ({ ...o, [id]: on }));
    await saveRule(id, { on, thresholdNam: prefs[id].thresholdNam }, `${byId.get(id)?.title ?? 'Rule'}: ${on ? 'on' : 'off'}. Saved.`);
    setOptimistic((o) => {
      const n = { ...o };
      delete n[id];
      return n;
    });
  };

  const commit = async (id: string) => {
    const raw = digits(text[id] ?? '');
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) {
      setFieldErr((e) => ({ ...e, [id]: 'Enter a whole number of NAM, 1 or more.' }));
      return;
    }
    setFieldErr((e) => ({ ...e, [id]: null }));
    if (n === prefs[id].thresholdNam) {
      setText((t) => ({ ...t, [id]: fmtNamRule(n) }));
      return;
    }
    await saveRule(id, { on: prefs[id].on, thresholdNam: n }, `${byId.get(id)?.title ?? 'Rule'}: alerts from ${fmtNamRule(n)} NAM. Saved.`);
    setText((t) => ({ ...t, [id]: fmtNamRule(n) }));
  };

  return (
    <Panel id="rules" title="Alert rules" lead={<>Each rule watches every new move. Sizes are in NAM; the dollar value uses the NAM price {rewound ? 'at the rewound time' : 'now'}.</>}>
      <div className="st-rules" data-prov-scope="">
        {ids.map((id) => {
          const p = prefs[id];
          const r = byId.get(id);
          const on = optimistic[id] ?? p.on;
          const typed = Number(digits(text[id] ?? ''));
          const size = Number.isSafeInteger(typed) && typed >= 1 ? typed : p.thresholdNam;
          return (
            <div key={id} className="st-rule">
              <Switch label={r?.title ?? id.replace(/_/g, ' ')} description={conditionFor(id, p.thresholdNam) ?? r?.condition} checked={on} onChange={(v) => void toggle(id, v)} />
              <Field
                className="st-size"
                label="Alert size"
                unit="NAM"
                value={text[id] ?? ''}
                disabled={!on}
                onChange={(v) => setText((t) => ({ ...t, [id]: v.replace(/[^\d,\s]/g, '') }))}
                onBlur={() => void commit(id)}
                hint={
                  <>
                    About{' '}
                    <Derived
                      inputs={[{ value: size, prov: mineStamp }, { value: price.value, prov: priceStamp }]}
                      label="alert size x price"
                      name={`${r?.title ?? 'Alert'} size in dollars`}
                      compute={(a, b) => a * b}
                      fmt={fmtUsdRule}
                      showAge={false}
                    />{' '}
                    {priceWord}
                    {r && r.thresholdNam !== p.thresholdNam ? <>. The default is {fmtNamRule(r.thresholdNam)} NAM</> : null}.
                  </>
                }
                error={fieldErr[id] ? <Notice tone="danger" title="Not saved">{fieldErr[id]}</Notice> : undefined}
              />
            </div>
          );
        })}
        <div className="st-rule">
          <Switch
            label="New votes and forum posts"
            description="Governance proposals and forum posts about Namada, when they appear."
            checked={optimistic.forum ?? s.notifications.forumAndGov}
            onChange={(v) => {
              setOptimistic((o) => ({ ...o, forum: v }));
              void st.run(() => save({ notifications: { forumAndGov: v } }), `Votes and forum posts: ${v ? 'on' : 'off'}. Saved.`).then(() =>
                setOptimistic((o) => {
                  const n = { ...o };
                  delete n.forum;
                  return n;
                }),
              );
            }}
          />
        </div>
        <StatusLine status={st.status} />
        <SourceLine
          items={[
            { label: 'Your sizes', p: mineStamp },
            { label: 'The NAM price', p: priceStamp },
            ...(rulesStamp ? [{ label: 'Default sizes', p: rulesStamp }] : []),
          ]}
          label="Where the sizes and dollar values come from"
        />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- where alerts go
/** What the test button says when the server sends no alerts at all: the saved link is not at fault and was not tried. */
const TEST_ALERTS_OFF = 'Alerts are off on this server, so no test message was sent. Your saved link was not tried and is not at fault.';

/** "Where to find it": the glossary's channel-link entry (the expert word lives in lib/glossary.ts). */
function ChannelLinkHelp() {
  return <Term id="channel-link" className="st-help">Where to find it</Term>;
}

function DeliveryPanel({ s, save }: { s: UserSettings; save: Save }) {
  const d = s.channels.discord;
  const [url, setUrl] = useState('');
  const st = useStatus();
  const test = useStatus();
  const tail = d.webhookUrlMasked ? d.webhookUrlMasked.slice(-4) : null;
  const inputId = 'st-discord';

  return (
    <Panel id="delivery" title="Where alerts go" lead="Alerts are posted to a Discord channel you control the moment a move is recorded, whether or not this site is open.">
      <p className="st-state">
        <i className="dot" data-status={d.hasUrl && d.enabled ? 'fresh' : 'none'} aria-hidden="true" />
        <span>
          {d.hasUrl
            ? d.enabled
              ? <>Alerts go to a Discord channel. The saved link ends in <span className="mono">{tail}</span>.</>
              : <>A Discord channel link ending in <span className="mono">{tail}</span> is saved, but sending is off.</>
            : 'No Discord channel is saved yet, so alerts are not sent anywhere.'}
        </span>
      </p>
      <form
        className="st-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!url) return;
          void st.run(() => save({ channels: { discord: { enabled: true, webhookUrl: url } } }), 'Saved. Alerts now go to this channel.').then((ok) => ok && setUrl(''));
        }}
      >
        <div className="st-in">
          <div className="st-in__top">
            <label className="st-in__l" htmlFor={inputId}>{d.hasUrl ? 'Replace the Discord channel link' : 'Discord channel link'}</label>
            <ChannelLinkHelp />
          </div>
          <input
            id={inputId}
            className="st-in__i"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value.trim())}
            placeholder={d.hasUrl ? 'Leave empty to keep the saved link' : 'Paste the link from Discord'}
          />
        </div>
        <div className="st-btns">
          <Button type="submit" variant="primary" busy={st.busy} disabled={!url || st.busy}>Save the link</Button>
          <Button
            disabled={!d.hasUrl || test.busy}
            busy={test.busy}
            onClick={() =>
              void test.run(async () => {
                const r = await testDiscord().catch((e: unknown) => {
                  // The server sends no alerts at all (it answers 503 with this sentence): the saved link was not tried.
                  if (e instanceof Error && /alerts are off on this server/i.test(e.message)) throw new Error(TEST_ALERTS_OFF);
                  throw e;
                });
                if (!r.success) throw new Error('Discord refused the test message. Check that the link still exists in the channel.');
              }, 'A test message was posted to the channel.')
            }
          >
            Send a test message
          </Button>
          {d.hasUrl ? (
            <Button onClick={() => void st.run(() => save({ channels: { discord: { webhookUrl: '' } } }), 'The link was removed. Alerts are not sent anywhere now.')}>
              Remove the link
            </Button>
          ) : null}
        </div>
      </form>
      <Switch
        label="Send alerts to this channel"
        description={d.hasUrl ? 'Switch off to pause sending without removing the link.' : 'Save a link first.'}
        checked={d.enabled}
        disabled={!d.hasUrl || st.busy}
        onChange={(v) => void st.run(() => save({ channels: { discord: { enabled: v } } }), v ? 'Sending is on.' : 'Sending is paused.')}
      />
      <StatusLine status={st.status ?? test.status} />
      <p className="st-cap">Telegram and email are not available yet. When one is, it appears here.</p>
    </Panel>
  );
}

// ---------------------------------------------------------------- watchlist
function WatchlistPanel({ s, save }: { s: UserSettings; save: Save }) {
  const n = s.notifications;
  const [text, setText] = useState(n.watchlist.join('\n'));
  const st = useStatus();
  const saved = n.watchlist.join('\n');
  useEffect(() => setText(saved), [saved]);
  const lines = text.split(/\s+/).filter(Boolean);
  return (
    <Panel id="watchlist" title="Watchlist" lead="Any move that touches one of these addresses sends an alert, whatever its size.">
      <Switch
        label="Watchlist alerts"
        description={n.watchlist.length ? `${n.watchlist.length === 1 ? '1 address' : `${n.watchlist.length} addresses`} saved.` : 'No address saved yet.'}
        checked={n.watchlistOn}
        onChange={(v) => void st.run(() => save({ notifications: { watchlistOn: v } }), v ? 'Watchlist alerts are on.' : 'Watchlist alerts are off.')}
      />
      <div className="st-in">
        <label className="st-in__l" htmlFor="st-watch">Addresses to watch, one per line (up to 100)</label>
        <textarea id="st-watch" className="st-in__i st-in__ta" rows={5} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={'tnam1…\nosmo1…'} />
      </div>
      <div className="st-btns">
        <Button
          busy={st.busy}
          disabled={st.busy}
          onClick={async () => {
            let kept = 0;
            const ok = await st.run(async () => {
              const r = await save({ notifications: { watchlist: lines } });
              kept = r.notifications.watchlist.length;
            }, 'Saved.');
            if (ok) {
              const dropped = new Set(lines).size - kept;
              st.setStatus({ ok: true, text: `Saved ${kept === 1 ? '1 address' : `${kept} addresses`}.${dropped > 0 ? ` ${dropped === 1 ? '1 line was' : `${dropped} lines were`} not a Namada or Osmosis address and ${dropped === 1 ? 'was' : 'were'} left out.` : ''}` });
            }
          }}
        >
          Save the watchlist
        </Button>
      </div>
      <StatusLine status={st.status} />
    </Panel>
  );
}

// ---------------------------------------------------------------- quiet hours
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

function QuietPanel({ s, save }: { s: UserSettings; save: Save }) {
  const q = s.notifications.quietHoursUtc;
  const st = useStatus();
  const now = useNow();
  const set = (next: { start: number; end: number } | null, ok: string) => void st.run(() => save({ notifications: { quietHoursUtc: next } }), ok);
  return (
    <Panel id="quiet" title="Quiet hours" lead={<>Nothing is sent between these hours. Times are in UTC; it is {fmtUtcClock(now)} now.</>}>
      <Switch
        label="Quiet hours"
        description={q ? `From ${hh(q.start)} to ${hh(q.end)} UTC${q.start > q.end ? ', overnight' : ''}.` : 'Off: alerts are sent at any hour.'}
        checked={!!q}
        onChange={(v) => set(v ? { start: 22, end: 7 } : null, v ? 'Quiet hours are on.' : 'Quiet hours are off.')}
      />
      {q ? (
        <div className="st-hours">
          <label className="st-in">
            <span className="st-in__l">From</span>
            <select className="st-in__i st-in__sel" value={q.start} onChange={(e) => set({ start: Number(e.target.value), end: q.end }, 'Saved.')}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hh(h)} UTC</option>)}
            </select>
          </label>
          <label className="st-in">
            <span className="st-in__l">To</span>
            <select className="st-in__i st-in__sel" value={q.end} onChange={(e) => set({ start: q.start, end: Number(e.target.value) }, 'Saved.')}>
              {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{hh(h)} UTC</option>)}
            </select>
          </label>
        </div>
      ) : null}
      <StatusLine status={st.status} />
    </Panel>
  );
}

// ---------------------------------------------------------------- devices and keys (one list from the server)
function useSessions() {
  const [list, setList] = useState<SessionInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () =>
    fetchSessions()
      .then((x) => {
        setList(x);
        setErr(null);
      })
      .catch((e: unknown) => {
        setList([]);
        setErr(plainError(e, 'The list of devices could not be read.'));
      });
  useEffect(() => {
    void load();
  }, []);
  return { list, err, load };
}

function DevicesPanel({ sessions, onSignOutHere }: { sessions: ReturnType<typeof useSessions>; onSignOutHere: () => void }) {
  const { list, err, load } = sessions;
  const st = useStatus();
  const now = useNow();
  const devices = (list ?? []).filter((x) => x.via !== 'api');
  return (
    <Panel id="devices" title="Devices" lead="Every device signed in to this address. Signing a device out ends its session at once.">
      {!list ? (
        <Skeleton rows={2} heights={[72]} label="devices" />
      ) : (
        <ul className="st-devs">
          {devices.map((x) => (
            <li key={x.id} className="st-dev">
              <div className="st-dev__tx">
                <p className="st-dev__t">
                  {viaWord(x.via)}
                  {x.current ? <Tag cat="This device" look="ref" /> : null}
                </p>
                <p className="st-cap">
                  Signed in {fmtAgo(x.createdAt, now)} · last used {x.lastUsedAt ? fmtAgo(x.lastUsedAt, now) : 'never'} · ends {fmtUtcLong(x.expiresAt)}
                </p>
              </div>
              {x.current ? (
                <Button size="sm" onClick={onSignOutHere}>Sign out here</Button>
              ) : (
                <Button size="sm" busy={st.busy} onClick={() => void st.run(async () => { await revokeSession(x.id); await load(); }, `${viaWord(x.via)} was signed out.`)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {err ? <Notice tone="warning" title="Devices">{err}</Notice> : null}
      <StatusLine status={st.status} />
      <PairDevice />
    </Panel>
  );
}

function DevelopersPanel({ sessions }: { sessions: ReturnType<typeof useSessions> }) {
  const { list, load } = sessions;
  const [key, setKey] = useState<{ token: string; expiresAt: number } | null>(null);
  const st = useStatus();
  const [copied, copy] = useCopy();
  const now = useNow();
  const keys = (list ?? []).filter((x) => x.via === 'api');
  const origin = typeof location === 'undefined' ? '' : location.origin;
  return (
    <Panel id="developers" title="For developers" lead="An API key is a bearer token for scripts, bots or a spreadsheet. It has the rights of a signed-in session, except making API keys, pairing a device, ending a signed-in device or deleting your data. It is shown once.">
      <div className="st-btns">
        <Button
          busy={st.busy}
          disabled={st.busy}
          onClick={() =>
            void st.run(async () => {
              setKey(await createApiKey());
              await load();
            }, 'A key was made. Copy it now; it is not shown again.')
          }
        >
          Make an API key
        </Button>
      </div>
      {key ? (
        <div className="st-key">
          <p className="st-in__l">Your key</p>
          <code className="st-key__v">{key.token}</code>
          <div className="st-btns">
            <button type="button" className="sh-act" onClick={() => copy(key.token)}>
              <Icon name={copied ? 'check' : 'copy'} className="ico ico--inline" />
              {copied ? 'Copied' : 'Copy the key'}
            </button>
          </div>
          <p className="st-cap">Ends {fmtUtcLong(key.expiresAt)}.</p>
        </div>
      ) : null}
      <StatusLine status={st.status} />
      {keys.length ? (
        <ul className="st-devs" aria-label="Your API keys">
          {keys.map((x) => (
            <li key={x.id} className="st-dev">
              <div className="st-dev__tx">
                <p className="st-dev__t">API key</p>
                <p className="st-cap">Made {fmtAgo(x.createdAt, now)} · last used {x.lastUsedAt ? fmtAgo(x.lastUsedAt, now) : 'never'} · ends {fmtUtcLong(x.expiresAt)}</p>
              </div>
              <Button size="sm" onClick={() => void st.run(async () => { await revokeSession(x.id); await load(); }, 'The key was revoked.')}>Revoke</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="st-in__l">Examples</p>
      <pre className="st-pre">{`# your alerts since a time (unix ms)
curl -H "Authorization: Bearer $KEY" "${origin}/api/alerts/recent?since=${now - 86_400_000}"

# supply pressure now (public, no key), or as of any time with ?at=
curl "${origin}/api/pressure?days=7"

# your settings
curl -H "Authorization: Bearer $KEY" ${origin}/api/me/settings`}</pre>
      <p className="st-cap">
        Market data needs no key: /api/overview, /api/pressure, /api/blindspot, /api/flows and /api/quote are public. Only /api/me/* and /api/labels need one. Revoke a key here or under Devices on any of your devices.
      </p>
    </Panel>
  );
}

// ---------------------------------------------------------------- your data (signed in or not)
function DataPanel({ s, signedIn, onDeleted }: { s: UserSettings | null; signedIn: boolean; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const st = useStatus();
  const now = useNow();
  return (
    <Panel id="data" title="Your data" lead={signedIn ? 'What is stored about you, who can read it, and how to take it or delete it.' : 'What would be stored about you if you signed in, and who could read it.'}>
      <dl className="st-stored">
        <div><dt>Your address</dt><dd>Public on the chain anyway. It is the key for your settings and sessions.</dd></div>
        <div><dt>Alert choices, watchlist and quiet hours</dt><dd>Encrypted before they are stored, and decrypted only in memory while a new move is matched against them.</dd></div>
        <div><dt>Discord channel link</dt><dd>Encrypted before it is stored. The site never shows it again, only its last characters, and decrypts it only to post an alert.</dd></div>
        <div><dt>Sessions and keys</dt><dd>Random tokens with when they were made and last used. No IP address and no browser details are stored with them.</dd></div>
        <div><dt>Your tags on addresses</dt><dd>Public: every user sees them, signed with your address. The only thing you write that others see.</dd></div>
      </dl>
      <h3 className="h3 st-h3">Who can read it</h3>
      <p className="st-text">
        The database and its backups hold your choices only in encrypted form, so the site&rsquo;s operator cannot read your watchlist or your Discord link by looking at the data. The honest limit: whoever deploys this site could change its code to record them while they are decrypted to send an alert. That is true of every hosted service; this one says so, and you can delete everything at any time.
      </p>
      <p className="st-text">{SITE.privacy}</p>
      {signedIn && s ? (
        <>
          <div className="st-btns">
            <Button
              icon="download"
              busy={st.busy}
              onClick={() =>
                void st.run(async () => {
                  const d = await exportMe();
                  downloadJson(d, `namadatrade-${s.address.slice(0, 10)}.json`);
                }, 'Your data was saved as a file.')
              }
            >
              Export as a file
            </Button>
            {!confirming ? (
              <Button variant="destructive" onClick={() => setConfirming(true)}>Delete everything</Button>
            ) : null}
          </div>
          {confirming ? (
            <div className="st-confirm" role="group" aria-label="Delete everything">
              <p className="st-text">This deletes your settings, your Discord link, every session and every key, on every device. Public market data is not affected.</p>
              <div className="st-btns">
                <Button
                  variant="destructive"
                  busy={st.busy}
                  disabled={st.busy}
                  onClick={() =>
                    void st.run(async () => {
                      await deleteMe();
                      onDeleted();
                    }, 'Everything was deleted.')
                  }
                >
                  Yes, delete everything
                </Button>
                <Button onClick={() => setConfirming(false)}>Keep my data</Button>
              </div>
            </div>
          ) : null}
          <StatusLine status={st.status} />
          <p className="st-cap">Settings made {fmtUtcLong(s.createdAt)} · last changed {fmtAgo(s.updatedAt, now)}.</p>
        </>
      ) : null}
    </Panel>
  );
}

function AppearancePanel() {
  const [pref, , setPref] = useTheme();
  return (
    <Panel id="appearance" title="Appearance" lead="Kept in this browser only. Match my device follows your system setting.">
      <Segmented<ThemePref>
        label="Appearance"
        value={pref}
        onChange={setPref}
        options={(['dark', 'light', 'system'] as ThemePref[]).map((p) => ({ value: p, label: THEME_LABELS[p] }))}
        className="st-seg"
      />
    </Panel>
  );
}
