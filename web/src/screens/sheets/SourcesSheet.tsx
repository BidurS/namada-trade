// Sources sheet, "Where every number comes from" (S7). system.md 9.8; build-plan 8 "Sheets", N8.
//
// The lead says how many cross-checks pass; the checks that need a look come first, then the ones
// that pass, one row per check.key with its plain title (lib/prov CHECK_TITLES), the word (Passes,
// Needs a look) and a plain detail ("1,614 NAM apart"). Then every headline figure with its own
// source and age, the live stream, and what the state words mean. Operator text (the worker's
// check titles, raw details, the data-source health list, the raw JSON link) lives only under
// "How it is computed". Under Rewind the checks were not recorded: the sheet says so.
import React from 'react';
import type { Overview } from '../../../../shared/types';
import { useClock, useOverview, useReplay } from '../../app/index';
import { Notice, Sheet, Skeleton, checkUi, uiStatus, type Stamp } from '../../ui/index';
import { checkDetail, checkTitle, scopeRowText } from '../../lib/prov';
import { Icon } from '../../ui/Icon';
import { fmtAge, fmtAgo, fmtCount, fmtUtcLong } from '../../lib/format';

/** The headline figures and their stamps (plain labels; the sheet prints each stamp in plain words). */
function figureStamps(o: Overview): { label: string; p: Stamp }[] {
  return [
    { label: 'NAM price, quoted', p: o.price.usd.prov },
    { label: 'Last trade price', p: o.price.swap1h.prov },
    { label: 'Staked, shielded and public funding', p: o.supply.prov },
    { label: 'NAM on Osmosis', p: o.supply.osmosisProv },
    { label: 'Pool depth on Osmosis', p: o.dex.prov },
    { label: 'Moves on Osmosis', p: o.dex.coverage },
    { label: 'Moves on Namada', p: o.namada.coverage },
    { label: 'Latest Osmosis block', p: o.heads.osmosis.prov },
    { label: 'Latest Namada block', p: o.heads.namada.prov },
  ];
}

/** A raw detail value for "How it is computed" (operator text). */
function rawValue(v: unknown): string {
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 6 });
  if (Array.isArray(v)) {
    return v
      .map((x) => (x && typeof x === 'object' ? Object.entries(x as Record<string, unknown>).filter(([, y]) => typeof y !== 'object').map(([k, y]) => `${k} ${rawValue(y)}`).join(', ') : String(x)))
      .join('; ');
  }
  if (v && typeof v === 'object') return JSON.stringify(v).slice(0, 160);
  return String(v);
}

export function SourcesSheet({ onClose }: { onClose: () => void }) {
  const { overview, stream, error } = useOverview();
  const { rewound, at } = useReplay();
  const now = useClock();
  const checks = overview?.checks ?? [];
  const look = checks.filter((c) => c.status === 'warn' || c.status === 'fail');
  const quiet = checks.filter((c) => c.status === 'stale');
  const idle = checks.filter((c) => c.status === 'idle');
  const pass = checks.filter((c) => c.status === 'ok');
  const ran = checks.length ? Math.max(...checks.map((c) => c.checkedAt)) : null;

  const lead = !overview ? (
    error ?? 'Reading the cross-checks.'
  ) : rewound ? (
    <>Checks were not recorded then. Every figure below is as of {fmtUtcLong(at)}, with its own source and age.</>
  ) : checks.length ? (
    <>
      <b>{fmtCount(pass.length)} of {fmtCount(checks.length)}</b> cross-checks pass{look.length ? `, ${fmtCount(look.length)} need a look` : ''}{quiet.length ? `, ${fmtCount(quiet.length)} ${quiet.length === 1 ? 'has' : 'have'} no recent result` : ''}{idle.length ? `, ${fmtCount(idle.length)} had nothing to compare` : ''}. They ran {ran != null ? fmtAgo(ran, now) : 'at an unknown time'}.
    </>
  ) : (
    'No cross-checks were reported. Every figure below still shows its own source and age.'
  );

  return (
    <Sheet open onClose={onClose} title="Where every number comes from" size="lg" lead={lead} className="sh-src">
      <div className="sheet__body sh-src__body" data-decision="D6">
        {!overview && !error ? <Skeleton rows={7} heights={[64]} label="cross-checks" /> : null}
        {error && !overview ? <Notice tone="danger" title="The figures did not load">{error}</Notice> : null}

        {checks.length ? (
          <section aria-labelledby="sh-src-chk">
            <h3 id="sh-src-chk" className="sh-h3">Cross-checks</h3>
            <p className="sh-cap">Each one compares two sources for the same thing. It passes, needs a look, has nothing to compare when there was no trade to check against, or has no recent result when one of its sources stopped answering.</p>
            <ul className="sh-chks">
              {[...look, ...quiet, ...idle, ...pass].map((c) => {
                const ui = checkUi(c.status);
                const detail = checkDetail(c);
                return (
                  <li key={c.key} className="sh-chk" data-key={c.key} data-status={ui.status}>
                    <span className="sh-chk__t">
                      <i className="dot" data-status={ui.status} aria-hidden="true" />
                      {checkTitle(c)}
                    </span>
                    <span className="sh-chk__w">
                      {ui.word}
                      <span className="sh-chk__age"> · checked {fmtAgo(c.checkedAt, now)}</span>
                    </span>
                    {detail ? <span className="sh-chk__d">{detail}</span> : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {overview ? (
          <section aria-labelledby="sh-src-fig">
            <h3 id="sh-src-fig" className="sh-h3">Each figure, its source and its age</h3>
            <ul className="sh-figl">
              {figureStamps(overview).map((f) => (
                <li key={f.label} className="sh-figl__i">
                  <span className="sh-figl__l">{f.label}</span>
                  <span className="sh-figl__v">
                    <i className="dot" data-status={uiStatus(f.p.status)} aria-hidden="true" />
                    <span>{scopeRowText(f.p, now)}</span>
                  </span>
                  {f.p.note && uiStatus(f.p.status) !== 'fresh' ? <span className="sh-figl__n">{f.p.note}</span> : null}
                </li>
              ))}
              <li className="sh-figl__i">
                <span className="sh-figl__l">Live updates</span>
                <span className="sh-figl__v">
                  <i className="dot" data-status={rewound ? 'none' : stream.connected ? 'fresh' : 'old'} aria-hidden="true" />
                  <span>
                    {rewound
                      ? 'Paused while rewound.'
                      : stream.connected
                        ? `Connected: trades and blocks arrive as they happen${stream.lastAt ? `, the last one ${fmtAgo(stream.lastAt, now)}` : ''}.`
                        : 'Not connected: the page asks for new figures on a timer instead.'}
                  </span>
                </span>
              </li>
            </ul>
          </section>
        ) : null}

        <section aria-labelledby="sh-src-words">
          <h3 id="sh-src-words" className="sh-h3">What the words mean</h3>
          <dl className="kv sh-kv">
            <dt><span className="dot" data-status="fresh" aria-hidden="true" />Fresh</dt>
            <dd>Read within its usual refresh time.</dd>
            <dt><span className="dot" data-status="old" aria-hidden="true" />Old</dt>
            <dd>Older than that, so it is shown dimmed with its age.</dd>
            <dt><span className="dot" data-status="none" aria-hidden="true" />No data</dt>
            <dd>The source did not answer, and nothing is put in its place.</dd>
            <dt><span className="dot" data-status="disagree" aria-hidden="true" />Sources disagree</dt>
            <dd>Two sources give different values; both are shown.</dd>
          </dl>
        </section>
      </div>

      <details className="how sh-how">
        <summary>
          How it is computed
          <Icon name="chev" className="ico ico--inline" />
        </summary>
        <div className="sh-how__in">
          {checks.length ? (
            <>
              <p className="sh-cap">The checks as the server names them, with their raw fields:</p>
              <dl className="sh-raw">
                {checks.map((c) => (
                  <React.Fragment key={c.key}>
                    <dt className="mono">{c.key} · {c.status} · {fmtUtcLong(c.checkedAt)}</dt>
                    <dd>
                      <span className="sh-raw__t">{c.title}</span>
                      {Object.entries(c.detail ?? {})
                        .filter(([k]) => k !== 'sources')
                        .map(([k, v]) => (
                          <span key={k} className="mono sh-raw__kv">{k}: {rawValue(v)}</span>
                        ))}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            </>
          ) : null}
          {overview?.sources.length ? (
            <>
              <p className="sh-cap">
                {fmtCount(overview.sources.filter((s) => s.ok).length)} of {fmtCount(overview.sources.length)} data sources answered at the last reading. Last answer, oldest first:
              </p>
              <ul className="srcs sh-srcs">
                {[...overview.sources].sort((a, b) => a.at - b.at).map((s) => (
                  <li key={s.name}>
                    <span className="mono">{s.name}</span>
                    <span className="mono">
                      {s.ok ? 'ok' : 'not answering'} · {fmtAge(now - s.at)}
                      {s.latencyMs != null ? ` · ${fmtCount(s.latencyMs)} ms` : ''}
                    </span>
                    {s.note && !s.ok ? <span className="sh-srcs__note">{s.note}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="sh-cap">
            {overview ? <>Figures generated {fmtUtcLong(overview.generatedAt)}{overview.asOf ? `, as of ${fmtUtcLong(overview.asOf)}` : ''}. </> : null}
            The raw cross-checks:{' '}
            <a className="sh-rawlink" href="/api/integrity" target="_blank" rel="noreferrer" data-native="">
              /api/integrity
            </a>
            .
          </p>
        </div>
      </details>
    </Sheet>
  );
}
