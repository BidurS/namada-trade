// Alerts (/alerts), S6. system.md 9.6; build-plan 8 "Alerts".
//
// Yellow reading band: the H1, the plain lead (BODY), and the one reading: how many moves crossed an
// alert size in the chosen window ("Since your last visit", 24 hours, 7 days), stamped with the flow
// index the rules ran over. Black body: the hits (or the empty state with the last one and a rewind
// link), the five rules as Switch rows (locked when signed out), and where alerts go in one line with
// one action. Under Rewind the window ends at the rewound time and "since your last visit" is not
// offered; the rule list and your own choices are current (they are not recorded over time).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AlertHit, AlertRuleId, AlertsRecentResponse } from '../../../../shared/types';
import { BODY } from '../../../../shared/copy';
import type { ScreenProps } from '../../app/index';
import { useClock, useHeaderPrice, useOverlays, useOverview, useReplay, useSession } from '../../app/index';
import { fetchAlertsRecentWithLast } from '../../api';
import {
  ArrowLink, Button, Derived, EmptyState, HeroNumber, Notice, Num, ProvChip, ProvScope, Segmented, Skeleton, SkeletonBlock,
  SourceLine, Switch, Tag, derive, uiStatus, type SegOption, type Stamp,
} from '../../ui/index';
import { Icon } from '../../ui/Icon';
import { explorerTx, fmtAge, fmtAgo, fmtCount, fmtDateline, fmtNamRule, fmtUsdRule, fmtUtcLong } from '../../lib/format';
import { useUserSettings } from '../settings/account';
import { plainError } from '../sheets/util';
import { hitKind, hitTx, useAlertRules, type RuleView } from './rules';

type Win = 'away' | '24h' | '7d';
const HOUR = 3_600_000;
const WINDOW_HOURS: Record<Exclude<Win, 'away'>, number> = { '24h': 24, '7d': 24 * 7 };
/** How many hits show before "Show all". */
const FIRST = 12;
/** Refresh the hits while live and visible (the shell's badge polls at the same pace). */
const REFRESH_MS = 60_000;

/** The current path with ?at= set (other parameters kept): a rewind link that stays on this page. */
const hrefAt = (t: number) => {
  const u = new URL(location.href);
  u.searchParams.set('at', String(Math.round(t)));
  return `${u.pathname}${u.search}`;
};

interface HitsState {
  data: AlertsRecentResponse | null;
  /** The newest hit of any age before the window's end (W5 `last`); undefined when the server does not say. */
  last: AlertHit | null | undefined;
  error: string | null;
}

export default function AlertsScreen({ route }: ScreenProps) {
  const { at, rewound } = useReplay();
  const { overview, alerts: badge } = useOverview();
  const { session } = useSession();
  const { openSignIn } = useOverlays();
  const now = useClock();
  const lastSeen = badge.since;

  // ---- the window ---------------------------------------------------------------------------
  const [win, setWin] = useState<Win>(() => (!rewound && lastSeen ? 'away' : '24h'));
  const canAway = !rewound && lastSeen != null;
  const eff: Win = win === 'away' && !canAway ? '24h' : win;

  // ---- the hits -----------------------------------------------------------------------------
  const [hits, setHits] = useState<HitsState | null>(null);
  const [tick, setTick] = useState(0);
  const range = useMemo(() => {
    const end = at ?? Date.now();
    const since = eff === 'away' && lastSeen ? Math.min(lastSeen, end - HOUR) : end - WINDOW_HOURS[eff === 'away' ? '24h' : eff] * HOUR;
    return { since, end };
    // tick: a live refresh moves the window's end to now
  }, [at, eff, lastSeen, tick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setHits(null);
  }, [at, eff]);

  useEffect(() => {
    let alive = true;
    fetchAlertsRecentWithLast(at, range.since)
      .then((r) => {
        if (alive) setHits({ data: { ...r, hits: [...r.hits].sort((a, b) => b.ts - a.ts) }, last: r.last, error: null });
      })
      .catch((e: unknown) => {
        if (alive) setHits((prev) => (prev?.data ? prev : { data: null, last: undefined, error: plainError(e, 'Alerts could not be read right now.') }));
      });
    return () => {
      alive = false;
    };
  }, [at, range]);

  useEffect(() => {
    if (rewound) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((x) => x + 1);
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [rewound]);

  // ---- rules, price and your choices ---------------------------------------------------------
  const { rules, stamp: rulesStamp, error: rulesError } = useAlertRules();
  const price = useHeaderPrice();
  const user = useUserSettings(session);

  const flowStamp: Stamp | null = overview
    ? { ...derive([overview.dex.coverage, overview.namada.coverage], 'the moves recorded on Osmosis and on Namada'), plain: 'Flow index' }
    : null;

  const smallest = rules?.length ? rules.reduce((a, b) => (b.thresholdNam < a.thresholdNam ? b : a)) : null;
  const priceWord = rewound ? 'at the price then' : 'at today’s price';

  const list = hits?.data?.hits ?? [];
  const count = hits?.data ? list.length : null;
  const windowLabel = eff === 'away' ? 'Since you were away' : rewound ? `In the ${eff === '24h' ? '24 hours' : '7 days'} before then` : `In the last ${eff === '24h' ? '24 hours' : '7 days'}`;
  const inWords = eff === 'away' ? 'since you were away' : rewound ? `in the ${eff === '24h' ? '24 hours' : '7 days'} before then` : `in ${eff === '24h' ? '24 hours' : '7 days'}`;

  const winOptions: SegOption<Win>[] = [
    ...(canAway ? [{ value: 'away' as Win, label: 'Last visit' }] : []),
    { value: '24h', label: '24 hours' },
    { value: '7d', label: '7 days' },
  ];

  const dateline = at ?? overview?.generatedAt ?? null;
  const body = BODY.alerts?.paras ?? [];

  return (
    <div className="al" data-decision="D7">
      <section className="band ground-accent al-hero" aria-labelledby="al-h1">
        <div className="wrap al-hero__in">
          <div className="al-hero__head">
            <p className="eyebrow">{dateline ? `Alerts · ${fmtDateline(dateline)}` : 'Alerts'}</p>
            <h1 id="al-h1" className="h1">{route?.h1}</h1>
            {body[0] ? <p className="sub">{body[0]}</p> : null}
          </div>
          <div className="al-read">
            <HeroNumber
              size="48"
              label={windowLabel}
              chip={flowStamp ? <ProvChip p={flowStamp} label="The moves the alert rules ran over" /> : <span className="skel__b skel__chip" aria-hidden="true" />}
              value={
                count != null ? (
                  <>
                    <Num v={count} prov={flowStamp} fmt={fmtCount} showAge={false} />
                    <span className="u">{count === 1 ? 'alert' : 'alerts'}</span>
                  </>
                ) : hits?.error ? (
                  <Num v={null} prov={{ source: 'Alert rules', plain: 'Alert rules', at: null, status: 'missing' }} showReason={false} />
                ) : (
                  <SkeletonBlock height={48} width="4ch" />
                )
              }
              sub={
                hits?.data
                  ? <>From {fmtUtcLong(hits.data.since)} to {rewound ? fmtUtcLong(hits.data.until) : 'now'}.</>
                  : hits?.error ?? <span className="al-wait" aria-hidden="true" />
              }
            />
            <Segmented label="Window" value={eff} options={winOptions} onChange={setWin} className="al-win" />
          </div>
        </div>
        <div className="ruler" aria-hidden="true" />
      </section>

      <div className="band ground-ink al-body">
        <div className="wrap al-grid">
          <section className="al-sec al-hits" aria-labelledby="al-hits-h" data-prov-scope="">
            <h2 id="al-hits-h" className="h2">What crossed an alert size</h2>
            {hits?.error && !hits.data ? (
              <Notice tone="danger" title="Alerts could not be read">{hits.error}</Notice>
            ) : !hits?.data ? (
              <Skeleton rows={4} heights={[76]} label="alerts" />
            ) : list.length ? (
              <HitList hits={list} now={now} />
            ) : (
              <EmptyState
                title={`Nothing crossed an alert size ${inWords}.`}
                last={hits.last ? <LastOne hit={hits.last} now={now} /> : null}
                rewindHref={hits.last ? hrefAt(hits.last.ts + 60_000) : undefined}
              >
                {smallest && rulesStamp ? (
                  <>
                    Alert sizes are small on purpose: {priceWord}{' '}
                    <Num v={smallest.thresholdNam} prov={rulesStamp} fmt={fmtNamRule} showAge={false} /> NAM is{' '}
                    {/* the age is said once, by the dot; the full stop stays on the figure's line */}
                    <span className="al-nowrap">
                      <Derived
                        inputs={[{ value: smallest.thresholdNam, prov: rulesStamp }, { value: price.value, prov: price.stamp ?? { source: 'Osmosis quote', at: null, status: 'missing' } }]}
                        label="alert size x price"
                        name="Alert size in dollars"
                        compute={(n, p) => n * p}
                        fmt={fmtUsdRule}
                        stamp="dot"
                        showAge={false}
                      />
                      .
                    </span>
                  </>
                ) : null}
              </EmptyState>
            )}
            <SourceLine
              items={[
                { label: 'Moves on Osmosis', p: overview?.dex.coverage },
                { label: 'Moves on Namada', p: overview?.namada.coverage },
                ...(rulesStamp ? [{ label: 'Alert sizes', p: rulesStamp }] : []),
              ]}
              label="Where the alerts come from"
            />
          </section>

          <RulesPanel
              rules={rules}
              rulesStamp={rulesStamp}
              rulesError={rulesError}
              price={price}
              priceWord={priceWord}
              signedIn={!!session}
              user={user}
            />
          <section className="al-sec al-deliv" aria-labelledby="al-deliv-h">
              <h2 id="al-deliv-h" className="h2">Where alerts go</h2>
              {!session || user.expired ? (
                <>
                  <p className="al-deliv__line">{user.expired ? 'Your sign-in has ended, so your choices cannot be shown.' : body[1]}</p>
                  <Button variant="primary" onClick={() => openSignIn()} aria-haspopup="dialog">
                    {user.expired ? 'Sign in again' : 'Sign in'}
                  </Button>
                </>
              ) : (
                <>
                  <p className="al-deliv__line">
                    {!user.settings
                      ? user.error ?? <span className="al-wait" aria-hidden="true" />
                      : user.settings.channels.discord.hasUrl && user.settings.channels.discord.enabled
                        ? 'Alerts go to your Discord channel the moment a move is recorded, whether or not this page is open.'
                        : user.settings.channels.discord.hasUrl
                          ? 'A Discord channel is saved, but sending to it is switched off.'
                          : 'Alerts are not sent anywhere yet: no Discord channel is saved.'}
                  </p>
                  <ArrowLink href="/settings#delivery">Open settings</ArrowLink>
                </>
              )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ---- the hits ---------------------------------------------------------------------------------
function HitList({ hits, now }: { hits: AlertHit[]; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? hits : hits.slice(0, FIRST);
  return (
    <>
      <ul className="al-list" aria-label="Alerts, newest first">
        {shown.map((h) => (
          <HitRow key={`${h.flowId}:${h.ruleId}`} h={h} now={now} />
        ))}
      </ul>
      {hits.length > shown.length ? (
        <p className="al-more">
          <Button size="sm" onClick={() => setAll(true)}>
            Show all {fmtCount(hits.length)}
          </Button>
        </p>
      ) : null}
    </>
  );
}

function HitRow({ h, now }: { h: AlertHit; now: number }) {
  const { openAddress } = useOverlays();
  const tx = hitTx(h);
  return (
    <li className="al-hit">
      <p className="al-hit__t">{h.title}</p>
      <time className="al-hit__age" dateTime={new Date(h.ts).toISOString()} title={fmtUtcLong(h.ts)}>
        {fmtAgo(h.ts, now)}
      </time>
      <div className="al-hit__l2">
        <Tag kind={hitKind(h)} />
        {h.address ? (
          <button type="button" className="al-hit__who" aria-haspopup="dialog" onClick={() => openAddress(h.address!)}>
            {h.detail}
          </button>
        ) : (
          <span className="al-hit__who al-hit__who--text">{h.detail}</span>
        )}
        {tx ? (
          <a className="al-hit__tx" href={explorerTx(h.chain, tx)} target="_blank" rel="noreferrer">
            Transaction
            <Icon name="external" className="ico ico--inline" />
            <span className="sr-only"> (opens the explorer)</span>
          </a>
        ) : null}
      </div>
    </li>
  );
}

function LastOne({ hit, now }: { hit: AlertHit; now: number }) {
  return (
    <>
      <span>The last one:</span>
      <Tag kind={hitKind(hit)} />
      <span>
        {hit.title}, {fmtAgo(hit.ts, now)}.
      </span>
    </>
  );
}

// ---- the rules --------------------------------------------------------------------------------
function RulesPanel({
  rules, rulesStamp, rulesError, price, priceWord, signedIn, user,
}: {
  rules: RuleView[] | null;
  rulesStamp: Stamp | null;
  rulesError: string | null;
  price: ReturnType<typeof useHeaderPrice>;
  priceWord: string;
  signedIn: boolean;
  user: ReturnType<typeof useUserSettings>;
}) {
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState<string | null>(null);
  const prefs = user.settings?.notifications.rules as Record<string, { on: boolean; thresholdNam: number }> | undefined;
  const priceStamp: Stamp = price.stamp ?? { source: 'Osmosis quote', at: null, status: 'missing', note: 'The price has not arrived yet.' };
  const dollarStamp = derive([rulesStamp ?? priceStamp, priceStamp], 'alert size x price');
  const priceOld = price.stamp ? uiStatus(price.stamp.status) === 'old' : false;
  const now = useClock();

  const toggle = useCallback(
    async (id: string, on: boolean) => {
      const cur = prefs?.[id];
      if (!cur) return;
      setErr(null);
      setOptimistic((o) => ({ ...o, [id]: on }));
      try {
        await user.save({ notifications: { rules: { [id as AlertRuleId]: { on, thresholdNam: cur.thresholdNam } } } });
      } catch (e) {
        setErr(plainError(e));
      } finally {
        setOptimistic((o) => {
          const next = { ...o };
          delete next[id];
          return next;
        });
      }
    },
    [prefs, user],
  );

  const lock = !signedIn ? 'Sign in to choose' : user.expired ? 'Sign in again to choose' : undefined;
  const { rewound } = useReplay();

  return (
    <section className="al-sec al-rules" aria-labelledby="al-rules-h">
      <h2 id="al-rules-h" className="h2">What triggers an alert</h2>
      <p className="al-lead">
        Sizes are in NAM and small on purpose: NAM trades in thin pools, where these sizes already move the price.
        {rewound ? ' The rules and sizes shown are today\u2019s; they are not recorded over time. The dollar values use the price then.' : ''}
      </p>
      <ProvScope
        className="al-rules__scope"
        old={!!rules && priceOld}
        oldSentence={
          price.stamp?.at != null
            ? // a price can be old because the live reading failed (the server says why), not only by age
              `${price.stamp.note ? `${price.stamp.note.replace(/\.?\s*$/, '.')} ` : ''}Dollar values use ${price.stamp.note ? 'the last stored price' : 'a price'}, from ${fmtAge(now - price.stamp.at)} ago, so they are shown dimmed.`
            : undefined
        }
      >
        {rulesError && !rules ? (
          <Notice tone="danger" title="The rules could not be read">{rulesError}</Notice>
        ) : !rules ? (
          <Skeleton rows={5} heights={[96]} label="alert rules" />
        ) : (
          <div className="al-rules__list">
            {rules.map((r) => {
              const mine = prefs?.[r.id];
              const checked = optimistic[r.id] ?? mine?.on ?? false;
              return (
                <Switch
                  key={r.id}
                  label={r.title}
                  checked={checked}
                  onChange={(v) => void toggle(r.id, v)}
                  disabled={signedIn && !lock && !user.settings}
                  locked={lock}
                  description={
                    <>
                      {r.condition}. About{' '}
                      <Derived
                        inputs={[{ value: r.thresholdNam, prov: rulesStamp ?? priceStamp }, { value: price.value, prov: priceStamp }]}
                        label="alert size x price"
                        name={`${r.title}: the size in dollars`}
                        compute={(n, p) => n * p}
                        fmt={fmtUsdRule}
                        showAge={false}
                      />{' '}
                      {priceWord}.
                      {mine && mine.thresholdNam !== r.thresholdNam ? (
                        <span className="al-mine">
                          {' '}Your size: <Num v={mine.thresholdNam} fmt={fmtNamRule} unit="NAM" />.
                        </span>
                      ) : null}
                    </>
                  }
                />
              );
            })}
          </div>
        )}
        {user.error && signedIn && !user.expired ? <Notice tone="warning" title="Your choices could not be read">{user.error}</Notice> : null}
        {err ? (
          <Notice tone="danger" title="The change was not saved" live>
            {err}
          </Notice>
        ) : null}
        <SourceLine
          items={[
            { label: 'Alert sizes', p: rulesStamp },
            { label: 'Dollar values (size x price)', p: dollarStamp },
            ...(prefs ? [{ label: 'Your sizes', p: { source: 'Your settings', plain: 'Your settings', at: user.settings?.updatedAt ?? null, status: 'live' as const } }] : []),
          ]}
          label="Where the sizes come from"
        />
      </ProvScope>
    </section>
  );
}
