// /status: "Are the figures on this site current?" (docs/design/platform-plan.md, release A). The Sources sheet's
// content on a page with an address of its own, so it can be linked, watched and read without opening a sheet.
// Band: how many cross-checks pass and when the last reading of every source completed (one SourceLine). Evidence:
// every cross-check under its plain title (lib/prov CHECK_TITLES), the ones that need a look first; each headline
// figure with its own source and age; what the four states mean, in the words the served page states (shared/copy.ts
// BODY.status); where the same is served as data. The operator's
// words (the sources as the server names them) are only under "How it is computed", as on the sheet.
// Under Rewind the checks were not recorded: the page says so and counts nothing.
// First of all, whether Namada is making blocks (shared/block-production.ts): measured from the nodes' and the indexer's
// newest blocks at the last reading, so it says when blocks stop and when they start again with nothing set by hand.
import type { ScreenProps } from '../../app/index';
import { REWIND_WORDS, useClock, useOverview, useReplay } from '../../app/index';
import { BODY } from '../../../../shared/copy';
import { Num, checkUi, uiStatus, type Stamp } from '../../ui';
import { Icon } from '../../ui/Icon';
import { checkDetail, checkTitle, scopeRowText } from '../../lib/prov';
import { fetchIntegrity } from '../../api';
import { fmtAge, fmtAgo, fmtCount } from '../../lib/format';
import { blockProduction, blocksSentence, blocksWho } from '../../../../shared/block-production';
import { figureStamps } from '../../lib/figure-stamps';
import { Band, Dateline, Facts, Fig, GoLink, Hero, QSection, Related, Say, missing, noAnswer, useLoad, useOv } from './parts';

const copy = BODY.status;
/** A completed reading is current for this long (worker/src/ops.ts HEALTH_TICK_MAX_AGE_MS, the bound of /api/health). */
const TICK_FRESH_MS = 5 * 60_000;

export function Status({ route }: ScreenProps) {
  const { rewound } = useReplay();
  const { stream, stale } = useOverview();
  const { o, loading } = useOv();
  const now = useClock();
  // When the last reading of every source completed: current only, so not asked for while rewound (the key changes
  // with it, so coming back from a rewound moment starts a new read and never shows the old one's absence). Each
  // answer is kept with the moment this page received it: how old the reading is now is the server's own gap between
  // its clock and the reading, plus the time this page has held the answer, so a reader's clock set wrong changes nothing.
  const integrity = useLoad(rewound ? 'integrity:rewound' : 'integrity', () => fetchIntegrity().then((d) => ({ d, got: Date.now() })), { enabled: !rewound, everyMs: 60_000 });
  const [qBlocks, qStates, qData] = copy.sections!;

  const checks = o?.checks ?? [];
  const look = checks.filter((c) => c.status === 'warn' || c.status === 'fail');
  const quiet = checks.filter((c) => c.status === 'stale');
  const idle = checks.filter((c) => c.status === 'idle');
  const pass = checks.filter((c) => c.status === 'ok');
  // a check that ran with nothing to compare is neither a pass nor a fault: the passes are counted against the rest (owner decision 48)
  const idleCount = checks.filter((c) => c.status === 'idle').length;
  const checkAt = checks.length ? Math.max(...checks.map((c) => c.checkedAt)) : null;
  const checkP: Stamp | null = !o
    ? null
    : rewound
      ? missing('cross-check', `${REWIND_WORDS.checks}.`, 'Cross-checks')
      : checks.length
        // the count comes with the overview: when the page could not refresh it, the count is old and says so
        ? { source: 'cross-check', plain: 'Cross-checks', at: checkAt, status: stale ? 'stale' : 'live', derivedFrom: 'checks that pass, of all checks' }
        : missing('cross-check', 'No cross-check has run yet.', 'Cross-checks');

  // The reading is current while it is younger than the site's own bound for a completed tick (the bound
  // /api/health judges by). Three different absences are said as what they are: no reading on record (null), a record
  // that could not be read (the field left out), and an answer this page could not refresh (the last poll failed).
  const ans = integrity.data;
  const tickAt = ans?.d.lastTickAt ?? null;
  const tickAge = ans && tickAt != null ? Math.max(0, ans.d.at - tickAt) + Math.max(0, now - ans.got) : null;
  const tickP: Stamp | null = rewound
    ? missing('this site', 'The last reading is a current figure; it is not shown while rewound.', 'This site')
    : integrity.loading
      ? null
      : !ans
        ? noAnswer('this site', 'This site')
        : ans.d.lastTickAt === undefined
          ? missing('this site', 'The record of the last reading could not be read.', 'This site')
          : tickAt == null || tickAge == null
            ? missing('this site', 'No completed reading is on record.', 'This site')
            : integrity.error
              ? { source: 'this site', plain: 'This site', at: tickAt, status: 'stale', note: 'This page could not ask again, so this is the reading it last heard of.' }
              : { source: 'this site', plain: 'This site', at: tickAt, status: tickAge <= TICK_FRESH_MS ? 'live' : 'stale', note: tickAge <= TICK_FRESH_MS ? undefined : 'No reading of every source has completed in its usual time.' };

  // Whether Namada is making blocks, at the last reading of its nodes (a current figure: not shown while rewound)
  // judged at the server's clock (its last answer's time, plus how long this page has held it), as the tick figure is,
  // so a reader's clock set wrong does not make a current reading look old
  const srvNow = ans ? ans.d.at + Math.max(0, now - ans.got) : now;
  const blocks = o && !rewound ? blockProduction(o.checks, srvNow) : null;
  // the reading's age is judged only once the server's time is known (until then nothing is said about it)
  const readOld = !!ans && !!blocks?.oldReading;
  const blocksSaid = blocks ? blocksSentence(blocks) : null;
  const blocksP: Stamp | null = rewound
    ? missing('Namada nodes', 'Whether Namada is making blocks is a current figure; it is not shown while rewound.', 'Namada nodes')
    : !blocks
      ? null
      : blocks.readAt == null || blocks.state === 'unknown' || blocks.blockAt == null
        ? missing('Namada nodes', blocks.why ?? 'The Namada nodes have not been asked yet.', 'Namada nodes')
        : {
          source: 'Namada nodes', plain: blocks.indexerHeight != null ? 'Namada nodes and the network indexer' : 'Namada nodes', at: blocks.readAt,
          status: readOld || stale ? 'stale' : 'live',
          note: readOld ? 'The Namada nodes have not been asked in their usual time, so this is the last reading on record.' : undefined,
        };
  // the checks that wait for a new block: they ran and had nothing new to compare (cron.ts notJudged 'no-new-…')
  const waiting = checks.filter((c) => c.status === 'idle' && String((c.detail as { notJudged?: unknown })?.notJudged ?? '').startsWith('no-new-'));

  return (
    <article className="seo seo--status">
      <Hero eyebrow={<Dateline label="Status" />} h1={route?.h1 ?? ''} sub={copy.paras[0]}>
        <Facts
          className="seo-facts"
          sourceLabel="Figures on this page"
          items={[
            {
              // stopped: how long without a block; making: the newest block's height; cannot tell: no figure, with the reason
              n: loading ? <Fig loading v={null} /> : blocks?.state === 'stopped' && blocksP?.status !== 'missing' && blocks.blockAt != null && blocks.readAt != null
                ? <Num v={blocks.readAt - blocks.blockAt} prov={blocksP} fmt={(ms) => fmtAge(ms)} showAge={false} />
                : <Num v={blocks?.state === 'making' && blocksP?.status !== 'missing' ? blocks.height : null} prov={blocksP} fmt={(h) => fmtCount(h)} showAge={false} />,
              label: blocks?.state === 'stopped' ? 'without a new Namada block, at the last reading' : 'Namada\'s newest block, at the last reading',
              scope: blocksP ? { label: 'The last reading of the Namada nodes', p: blocksP } : undefined,
            },
            {
              n: loading ? <Fig loading v={null} /> : checkP && checkP.status !== 'missing' ? <><Num v={pass.length} prov={checkP} showAge={false} /> <span className="u">of</span> <Num v={checks.length - idleCount} prov={checkP} showAge={false} /></> : <Num v={null} prov={checkP} showAge={false} />,
              label: idleCount ? `cross-checks that could be compared pass; ${idleCount} more had nothing to compare` : 'cross-checks that could be compared pass',
              scope: checkP ? { label: 'Cross-checks that pass', p: checkP } : undefined,
            },
            {
              n: integrity.loading && !rewound ? <Fig loading v={null} /> : <Num v={tickP && tickP.status !== 'missing' ? tickAge : null} prov={tickP} fmt={(ms) => fmtAge(ms)} showAge={false} />,
              label: 'since the last reading of every source completed',
              scope: tickP ? { label: 'The last completed reading', p: tickP } : undefined,
            },
          ]}
        />
      </Hero>

      <Band label="Cross-checks and sources">
        <section className="seo-sec st-blocks" aria-labelledby="st-blocks" data-state={blocks?.state ?? 'none'}>
          <h2 id="st-blocks" className="h2 seo-sec__h">{qBlocks.h2}</h2>
          <div className="seo-sec__b">
            {rewound ? <Say>Whether Namada is making blocks is a current figure; it is not shown while rewound.</Say> : null}
            {!rewound && !o ? <Fig loading v={null} /> : null}
            {blocks && blocksSaid ? <Say status={blocks.state === 'making' && blocksP?.status === 'live' ? 'fresh' : 'old'}>{blocksSaid}</Say> : null}
            {blocks && blocks.readAt == null ? <Say>The Namada nodes have not been asked yet.</Say> : null}
            {blocks && blocks.readAt != null ? (
              <p className="seo-p">
                {blocksWho(blocks) ? `${blocksWho(blocks)} ` : ''}Asked {fmtAgo(blocks.readAt, srvNow)}{readOld ? ', longer ago than usual' : ''}.
              </p>
            ) : null}
            {blocks?.state === 'stopped' && waiting.length ? (
              <p className="seo-p">
                {fmtCount(waiting.length)} of the cross-checks below {waiting.length === 1 ? 'has' : 'have'} nothing new to judge until Namada makes a block again.
              </p>
            ) : null}
            {qBlocks.paras.map((p, i) => <p key={i} className="seo-p">{p}</p>)}
          </div>
        </section>

        <section className="seo-sec" aria-labelledby="st-checks">
          <h2 id="st-checks" className="h2 seo-sec__h">Cross-checks</h2>
          <div className="seo-sec__b">
            <p className="seo-answer">{copy.paras[1]}</p>
            {rewound ? <Say>{REWIND_WORDS.checks}.</Say> : null}
            {!rewound && o && !checks.length ? <Say>No cross-check has run yet.</Say> : null}
            {checks.length ? (
              <ul className="seo-states st-checks" aria-label="Every cross-check, the ones that need a look first">
                {[...look, ...quiet, ...idle, ...pass].map((c) => {
                  const ui = checkUi(c.status);
                  const detail = checkDetail(c);
                  return (
                    <li key={c.key} className="seo-state" data-key={c.key} data-status={ui.status}>
                      <i className="dot" data-status={ui.status} aria-hidden="true" />
                      <span className="seo-state__w">{checkTitle(c)}</span>
                      <span className="seo-state__t">{ui.word} · checked {fmtAgo(c.checkedAt, now)}{detail ? `. ${detail}` : ''}</span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </section>

        <section className="seo-sec" aria-labelledby="st-figs">
          <h2 id="st-figs" className="h2 seo-sec__h">Each figure, its source and its age</h2>
          <div className="seo-sec__b">
            {o ? (
              <ul className="seo-states st-figs" aria-label="Each headline figure with its source and age">
                {figureStamps(o).map((f) => (
                  <li key={f.label} className="seo-state">
                    <i className="dot" data-status={uiStatus(f.p.status)} aria-hidden="true" />
                    <span className="seo-state__w">{f.label}</span>
                    <span className="seo-state__t">{scopeRowText(f.p, now)}{f.p.note && uiStatus(f.p.status) !== 'fresh' ? `. ${f.p.note}` : ''}</span>
                  </li>
                ))}
                <li className="seo-state">
                  <i className="dot" data-status={rewound ? 'none' : stream.connected ? 'fresh' : 'old'} aria-hidden="true" />
                  <span className="seo-state__w">Live updates</span>
                  <span className="seo-state__t">
                    {rewound
                      ? 'Paused while rewound.'
                      : stream.connected
                        ? `Connected: trades and blocks arrive as they happen${stream.lastAt ? `, the last one ${fmtAgo(stream.lastAt, now)}` : ''}.`
                        : 'Not connected: the page asks for new figures on a timer instead.'}
                  </span>
                </li>
              </ul>
            ) : (
              <Fig loading v={null} />
            )}
          </div>
        </section>

        <QSection id="st-states" h2={qStates.h2} paras={qStates.paras} />

        <QSection id="st-data" h2={qData.h2} paras={qData.paras}>
          <GoLink to="/developers">Every public route, with its fields</GoLink>
        </QSection>

        {o?.sources.length ? (
          <details className="how st-how">
            <summary>
              How it is computed
              <Icon name="chev" className="ico ico--inline" />
            </summary>
            <div className="st-how__in">
              <p className="seo-p">
                {fmtCount(o.sources.filter((s) => s.ok).length)} of {fmtCount(o.sources.length)} data sources answered at the last reading. Last answer, oldest first, as the server names them:
              </p>
              <ul className="srcs st-srcs">
                {[...o.sources].sort((a, b) => a.at - b.at).map((s) => (
                  <li key={s.name}>
                    <span className="mono">{s.name}</span>
                    <span className="mono">
                      {s.ok ? 'ok' : 'not answering'} · {fmtAge(now - s.at)}
                    </span>
                    {s.note && !s.ok ? <span className="st-srcs__note">{s.note}</span> : null}
                  </li>
                ))}
              </ul>
              <p className="seo-p">
                The raw cross-checks:{' '}
                <a href="/api/integrity" target="_blank" rel="noreferrer" data-native="">/api/integrity</a>. Whether the last reading completed:{' '}
                <a href="/api/health" target="_blank" rel="noreferrer" data-native="">/api/health</a>.
              </p>
            </div>
          </details>
        ) : null}

        <Related paths={['/methodology', '/developers', '/faq', '/activity', '/trade']} />
      </Band>
    </article>
  );
}
