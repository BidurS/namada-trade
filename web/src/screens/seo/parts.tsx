// Shared pieces of the four content pages and the not-found view (S8).
//
// Visual language (system.md 1, 9; seo-requirements "New pages"): one compact yellow band that
// states the question as the caps H1 and carries the page's reading (a hero figure with its
// ProvChip, a fact strip with one SourceLine, the ruler on its bottom edge), then black evidence
// bands where every H2 is a question answered in its first sentence, and the figures sit in
// lists whose one SourceLine names each of them (N1 as clarified).
//
// Nothing here types a number (N2): every figure is an API field, a derive() of fields, or a
// count of API rows. Missing values show "—" with the reason in view, never a stand-in.
import React, { useEffect, useRef, useState } from 'react';
import type { ChainParams, Overview, Pressure, Provenance } from '../../../../shared/types';
import type { RouteDef } from '../../../../shared/routes';
import { routeByPath } from '../../../../shared/routes';
import { Link, useClock, useOverview, useReplay, useVisible } from '../../app/index';
import { Fact, Icon, Num, SkeletonBlock, SourceLine, type FactProps, type NumProps, type ScopeItem, type Stamp } from '../../ui';
import { fetchPressure } from '../../api';
import { fmtDateline } from '../../lib/format';
import { ageRange, unbondingStamp } from '../../lib/prov';

// ---------------------------------------------------------------- data

export interface Load<T> {
  data: T | null;
  error: string | null;
  /** True until the first answer (or error) for the current key. */
  loading: boolean;
}

/**
 * Fetch once per `key` (refetch when it changes, e.g. the rewound time), optionally every
 * `everyMs` while the tab is visible. `enabled: false` makes no request at all (live-only
 * endpoints under Rewind) and reports neither data nor loading.
 */
export function useLoad<T>(key: string, fn: () => Promise<T>, opts: { enabled?: boolean; everyMs?: number } = {}): Load<T> {
  const { enabled = true, everyMs } = opts;
  const [state, setState] = useState<Load<T> & { key: string }>({ data: null, error: null, loading: enabled, key });
  const visible = useVisible();
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false, key });
      return;
    }
    let live = true;
    setState((s) => (s.key === key ? s : { data: null, error: null, loading: true, key }));
    const run = () =>
      fnRef.current().then(
        (data) => live && setState({ data, error: null, loading: false, key }),
        (e) => live && setState((s) => ({ data: s.key === key ? s.data : null, error: String(e?.message ?? e), loading: false, key })),
      );
    run();
    const t = everyMs && visible ? setInterval(run, everyMs) : undefined;
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [key, enabled, everyMs, visible]);

  return state.key === key ? state : { data: null, error: null, loading: enabled };
}

/** /api/pressure (7-day window) for the current Rewind time; refreshed every 2 min while live. */
export function usePressure(): Load<Pressure> {
  const { at } = useReplay();
  return useLoad<Pressure>(`pressure:${at ?? 'live'}`, () => fetchPressure(at, 7), { everyMs: at ? undefined : 120_000 });
}

/** The overview with its loading state ("loading" only until the first answer). */
export function useOv(): { o: Overview | null; loading: boolean; error: string | null } {
  const { overview, error } = useOverview();
  return { o: overview, loading: !overview && !error, error: overview ? null : error ?? null };
}

// ---------------------------------------------------------------- stamps

/** A stamp for a figure the server did not answer for. */
export const noAnswer = (source: string, plain?: string): Stamp => ({ source, plain, at: null, status: 'missing', note: 'The server did not answer.' });

/** A stamp that says why a figure is not shown (never a stand-in value). */
export const missing = (source: string, note: string, plain?: string): Stamp => ({ source, plain, at: null, status: 'missing', note });

/** A value computed from one stamped source: the same stamp, naming the computation in the sheet. */
export const fromOne = (p: Provenance | Stamp, derivedFrom: string): Stamp => ({ ...p, derivedFrom });

/** Divide, or null when either side is missing or the divisor is zero. */
export const ratio = (a: number | null | undefined, b: number | null | undefined): number | null =>
  a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b === 0 ? null : a / b;

/** The unstaking wait with its stamp (Pressure.unbondingDays and unbondingProv) and the chain parameters behind it. */
export function unbondingOf(p: Load<Pressure>, rewound: boolean): { v: number | null; prov: Stamp | null; params: ChainParams | null } {
  if (p.loading) return { v: null, prov: null, params: null };
  if (!p.data) return { v: null, prov: noAnswer('Namada chain parameters'), params: null };
  const cp = p.data.chainParams ?? null;
  const base = unbondingStamp(p.data);
  // a server before 2026-10-17 sends no reading time and, under Rewind, does not say the setting is current
  const prov: Stamp | null = base && rewound && !p.data.unbondingProv ? { ...base, note: 'This is the current setting; settings were not recorded over time.' } : base;
  return { v: p.data.unbondingDays, prov, params: cp };
}

/** The staking rate: only from served chain parameters, never a stand-in. */
export function aprOf(p: Load<Pressure>, rewound: boolean): { v: number | null; prov: Stamp | null } {
  if (p.loading) return { v: null, prov: null };
  const cp = p.data?.chainParams ?? null;
  if (rewound) return { v: null, prov: missing('indexer.namada.net', 'The rate was not recorded over time.') };
  if (!p.data) return { v: null, prov: noAnswer('indexer.namada.net') };
  // null: the server tried and could not read them; absent: a server from before the rate was sent (W13)
  if (!cp) return { v: null, prov: missing('indexer.namada.net', p.data.chainParams === null ? 'The chain parameters could not be read.' : 'The staking rate is not available yet.') };
  if (cp.apr == null) return { v: null, prov: { source: 'indexer.namada.net', at: cp.fetchedAt, status: 'missing', note: 'The indexer did not report a rate.' } };
  return { v: cp.apr * 100, prov: { source: 'indexer.namada.net', at: cp.fetchedAt, status: 'live', note: 'A yearly rate before the validator’s commission. It changes with the share staked and is not a promise.' } };
}

// ---------------------------------------------------------------- figures

/** A figure, or a skeleton at its final size while its data is on the way. */
export function Fig({ loading, h = 28, w = '5ch', ...rest }: NumProps & { loading?: boolean; h?: number; w?: string | number }) {
  if (loading) return <SkeletonBlock height={h} width={w} className="seo-skel" />;
  return <Num {...rest} />;
}

/** The kit's fact strip, with the height of its SourceLine held while no figure has arrived yet. */
export function Facts(props: FactProps) {
  const any = props.items.some((i) => i.scope);
  return (
    <>
      <Fact {...props} />
      {any ? null : <p className="src seo-src-wait" aria-hidden="true" />}
    </>
  );
}

/** The eyebrow dateline: the rewound time, or when the overview was computed. */
export function Dateline({ label }: { label: string }) {
  const { at } = useReplay();
  const { overview } = useOverview();
  const t = at ?? overview?.generatedAt ?? null;
  return (
    <p className="eyebrow seo-eyebrow">
      {label}
      {t ? <> · {fmtDateline(t)}</> : null}
    </p>
  );
}

// ---------------------------------------------------------------- layout

/**
 * The yellow band: eyebrow, the question as the caps H1, the answer-first sub, an optional hero
 * figure (right column from 1024 px), then whatever follows (fact strip, steps), and the ruler
 * on its bottom edge (the screen's one decorative scale).
 */
export function Hero({ eyebrow, h1, sub, fig, children, className = '' }: { eyebrow: React.ReactNode; h1: string; sub: React.ReactNode; fig?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <section className={`ground-accent seo-hero ${className}`} aria-labelledby="seo-h1">
      <div className="wrap seo-hero__in">
        <div className={`seo-hero__grid${fig ? ' seo-hero__grid--fig' : ''}`}>
          <div className="seo-hero__lead">
            {eyebrow}
            <h1 id="seo-h1" className="h1 seo-h1">{h1}</h1>
            <p className="seo-sub">{sub}</p>
          </div>
          {fig ? <div className="seo-hero__fig">{fig}</div> : null}
        </div>
        {children}
      </div>
      <div className="ruler" aria-hidden="true" />
    </section>
  );
}

/** A black evidence band. */
export function Band({ children, className = '', label }: { children: React.ReactNode; className?: string; label?: string }) {
  return (
    <section className={`ground-ink band seo-band ${className}`} aria-label={label}>
      <div className="wrap">{children}</div>
    </section>
  );
}

/**
 * One question section: the H2 (the question) on the left from 1024 px, the answer on the right.
 * The first paragraph is set as the answer (it answers the H2 in its first sentence).
 */
export function QSection({ id, h2, paras, children }: { id: string; h2: string; paras: string[]; children?: React.ReactNode }) {
  return (
    <section className="seo-sec" aria-labelledby={id}>
      <h2 id={id} className="h2 seo-sec__h">{h2}</h2>
      <div className="seo-sec__b">
        {paras.map((p, i) => (
          <p key={i} className={i === 0 ? 'seo-answer' : 'seo-p'}>{p}</p>
        ))}
        {children}
      </div>
    </section>
  );
}

export interface FigRow {
  /** What the figure is (also its scope label). */
  label: string;
  /** The visible label when it holds more than text (a glossary term). Default: `label`. */
  labelNode?: React.ReactNode;
  /** The value: a <Fig>/<Num> without a stamp of its own (the list's SourceLine covers it). */
  value: React.ReactNode;
  /** Its stamp for the scope sheet. */
  p?: Stamp | null;
  /** One line under the label (plain words). */
  note?: React.ReactNode;
}

/**
 * A short list of figures (label left, figure right; they wrap under each other when narrow),
 * with ONE SourceLine for all of them (a ProvScope, N1 as clarified). The line is held back
 * (its height reserved) until every stamp has arrived.
 */
export function FigList({ rows, label, loading, noSource, children, className = '' }: { rows: FigRow[]; label: string; loading?: boolean; /** The caller's own SourceLine covers these rows (one per panel). */ noSource?: boolean; /** Shown under the rows, above the SourceLine (a sparkline). */ children?: React.ReactNode; className?: string }) {
  const now = useClock();
  const scope: ScopeItem[] = rows.filter((r) => r.p !== undefined).map((r) => ({ label: r.label, p: r.p }));
  // A list whose figures are all old is dimmed once and says so in one sentence (system.md 8).
  const stamps = rows.map((r) => r.p).filter((p): p is Stamp => !!p);
  const allOld = !loading && stamps.length === rows.length && stamps.every((p) => p.status === 'stale' && p.at != null);
  const span = allOld ? ageRange(stamps, now) : '';
  return (
    <div className={`seo-figs${allOld ? ' is-old' : ''} ${className}`} data-prov-scope={noSource ? undefined : ''}>
      {allOld ? (
        <p className="scope__old seo-figs__old">
          <i className="dot" data-status="old" aria-hidden="true" />
          <span>{`These figures are ${span} old, so they are shown dimmed.`}</span>
        </p>
      ) : null}
      <dl className="seo-figs__l">
        {rows.map((r) => (
          <div key={r.label} className="seo-fig">
            <dt>
              <span>{r.labelNode ?? r.label}</span>
              {r.note ? <span className="seo-fig__note">{r.note}</span> : null}
            </dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      {children}
      {noSource ? null : loading || !scope.length ? <p className="src seo-src-wait" aria-hidden="true" /> : <SourceLine items={scope} label={label} />}
    </div>
  );
}

/** A plain sentence in the evidence band with a status dot (Rewind and live-only wording). */
export function Say({ children, status = 'none' }: { children: React.ReactNode; status?: 'none' | 'old' }) {
  return (
    <p className="seo-say">
      <i className="dot" data-status={status} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** "Related pages": real links to the app screens, each with the question it answers. */
export function Related({ paths, title = 'Related pages' }: { paths: string[]; title?: string }) {
  const routes = paths.map((p) => routeByPath(p)).filter((r): r is RouteDef => !!r);
  return (
    <nav className="seo-rel" aria-labelledby="seo-rel-h">
      <h2 id="seo-rel-h" className="h3 seo-rel__h">{title}</h2>
      <ul className="seo-links">
        {routes.map((r) => (
          <li key={r.path}>
            <PageLink route={r} />
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** One page link: the page's name and its question (RouteDef.h1), a 64 px row, arrow on the right. */
export function PageLink({ route, icon }: { route: RouteDef; icon?: string }) {
  // The accessible name is what the row says: the page's name, then its question (WCAG 2.5.3, label in name).
  return (
    <Link to={route.path} className="seo-link" aria-label={`${route.label}: ${route.h1}`}>
      {icon ? <Icon name={icon as never} className="ico seo-link__i" /> : null}
      <span className="seo-link__t">
        <span className="seo-link__l">{route.label}</span>{' '}
        <span className="seo-link__s">{route.h1}</span>
      </span>
      <Icon name="arrow" className="ico seo-link__a" />
    </Link>
  );
}

/** An inline "go there" link (ArrowLink look) that is a real <a> through the shell's Link. */
export function GoLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="link seo-go">
      <span>{children}</span>
      <Icon name="arrow" className="ico ico--inline" />
    </Link>
  );
}
