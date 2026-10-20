// The closing band (system.md 9.1 items 6 and 7): "What would you get right now?", the mini-ticket
// (Sell 5,000 NAM: the live Osmosis quote, or the size table when the quote service is not answering,
// said in words), and "Why you can trust these numbers": three points, the dated static proof block
// parsed from the replay report at build time, the checks that need a look, the ones that pass behind
// a disclosure, and one SourceLine.
import { useEffect, useState } from 'react';
import type { Check, Overview, PriceQuote, QuoteCurveResponse } from '../../../../shared/types';
import { SITE } from '../../../../shared/copy';
import { PROOF } from '../../generated/proof';
import { Link, REWIND_WORDS } from '../../app/index';
import { CHECK_TITLES, Icon, Notice, Num, ProvChip, SkeletonBlock, SourceLine, Tag, Term, checkUi } from '../../ui/index';
import type { Stamp } from '../../lib/prov';
import { NBSP, fmtAge, fmtCoin, fmtNamRule, fmtPctSigned, fmtUsdRule, fmtUtcLong } from '../../lib/format';
import { TICKET_NAM, type Res } from './data';
import { checkDetail, checksStamp } from '../../lib/prov';
import { MoreLink } from './bits';

export interface ClosingProps {
  o: Overview | null;
  curve: Res<QuoteCurveResponse>;
  curveP: Stamp | null;
  quote: Res<{ quote: PriceQuote | null; error?: string }>;
  checks: Check[];
  rewound: boolean;
  /** The overview never answered, so the cross-checks it carries did not load either. */
  failed?: boolean;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-17" → "17 Oct 2026" (the report's own date, UTC). */
const reportDay = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MON[Number(m[2]) - 1]} ${m[1]}` : iso;
};

export function Closing(props: ClosingProps) {
  return (
    <div className="band ground-ink closing">
      <div className="wrap closing__grid">
        <Ticket {...props} />
        <Trust checks={props.checks} rewound={props.rewound} failed={!!props.failed} />
      </div>
    </div>
  );
}

/** How long the mini-ticket waits for the live quote before it says it is not answering and shows the size table. */
const QUOTE_WAIT_MS = 8000;

function Ticket({ o, curve, curveP, quote, rewound }: ClosingProps) {
  const q = quote.data?.quote ?? null;
  const pt = curve.data?.curve.find((p) => p.amountNam === TICKET_NAM) ?? null;
  const pending = !rewound && quote.data == null && quote.error == null;
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!pending) return;
    setGaveUp(false);
    const t = setTimeout(() => setGaveUp(true), QUOTE_WAIT_MS);
    return () => clearTimeout(t);
  }, [pending]);
  // live quote answering: its own figures; otherwise the size table's row for the same size, said so
  const answered = q != null;
  const waiting = pending && !gaveUp;
  const get = answered ? q.outAmount : pt?.sellOutUsdc ?? null;
  const move = answered ? -Math.abs(q.priceImpactPct) : pt?.sellImpactPct != null ? -Math.abs(pt.sellImpactPct) : null;
  const getP: Stamp | null = answered
    ? { ...q.prov, plain: 'Osmosis quote' }
    : curveP
      ? pt?.sellOutUsdc == null
        ? { ...curveP, status: 'missing', note: `The size table has no selling quote for ${fmtNamRule(TICKET_NAM)} NAM right now.` }
        : curveP
      : null;
  const price = o?.price.usd ?? null;

  return (
    <section className="sec sec--ticket" aria-labelledby="home-ticket" data-prov-scope="">
      <h2 id="home-ticket" className="h2">What would you get right now?</h2>
      <p className="cap ticket__not">{SITE.quoteNotOrder}</p>
      {rewound ? (
        <Notice tone="info" title={REWIND_WORDS.quotes}>
          <p>The quote and the size table are read live, so they are not shown for a past moment.</p>
        </Notice>
      ) : (
        <>
          <div className="mini" data-prov-group="">
            <div className="mini__row">
              <span className="mini__k">
                Sell
                {!answered && !waiting ? (
                  <>
                    {' · '}
                    <span className="field__state"><i className="dot" data-status="old" aria-hidden="true" />live quote not answering</span>
                  </>
                ) : null}
              </span>
              <span className="mini__amt">{fmtNamRule(TICKET_NAM)}<span className="u">{NBSP}NAM</span></span>
            </div>
            <div className="mini__get">
              <span className="mini__k">You get about</span>
              <span className="mini__v">
                {waiting || (!answered && !curve.data && !curve.error) ? (
                  <SkeletonBlock height={28} width="5ch" />
                ) : (
                  <Num v={get} prov={getP} fmt={(n) => fmtCoin(n)} unit="USDC" showAge={false} showReason={false} />
                )}
              </span>
              <span className="mini__chip">
                {waiting ? <span className="skel__b skel__chip" aria-hidden="true" /> : getP ? <ProvChip p={getP} label={answered ? 'You get, live quote' : 'From the size table'} /> : null}
              </span>
            </div>
            <div className="mini__row">
              <span className="mini__k">Price move</span>
              <span className="mini__mv">
                {waiting ? <SkeletonBlock height={22} width="4ch" /> : <Num v={move} prov={getP} fmt={(n) => fmtPctSigned(n, 2)} showAge={false} showReason={false} />}
              </span>
            </div>
          </div>
          {!answered && !waiting ? (
            <Notice tone="warning" title="The Osmosis quote service is not answering.">
              <p>
                Last quoted price: {price ? <Num v={price.value} prov={price.prov} fmt={fmtUsdRule} showAge={false} stamp="dot" label="Last quoted price" /> : '—'}
                . These figures come from the size table, measured at the same moment, not from a live quote for your amount.
              </p>
            </Notice>
          ) : null}
        </>
      )}
      <p className="more">
        <MoreLink to="/trade">Full quote</MoreLink>
      </p>
    </section>
  );
}

function Trust({ checks, rewound, failed }: { checks: Check[]; rewound: boolean; failed: boolean }) {
  const look = checks.filter((c) => c.status !== 'ok' && c.status !== 'idle');
  const idle = checks.filter((c) => c.status === 'idle');
  const pass = checks.filter((c) => c.status === 'ok');
  const cs = checksStamp(checks);
  const ex = PROOF.largestWithdrawal;
  const day = reportDay(PROOF.reportDate);
  const each = PROOF.priceMovesFlagged === PROOF.priceMovesTested;

  return (
    <section className="sec sec--trust" aria-labelledby="home-trust" data-prov-scope="">
      <h2 id="home-trust" className="h2">Why you can trust these numbers</h2>
      <ol className="why">
        <li>
          <p><b>Every number shows its source and age.</b> Tap a dot and age, or the source line under a list, to see them.</p>
        </li>
        <li>
          {checks.length ? (
            <p>
              <b data-num="" data-status="fresh">{pass.length} of {checks.length}</b> <Term id="cross-check">cross-checks</Term> pass {rewound ? 'at that moment' : 'right now'}
              {look.length ? <>, <b data-num="" data-status="fresh">{look.length}</b> need a look</> : null}
              {idle.length ? <>, <b data-num="" data-status="fresh">{idle.length}</b> had nothing to compare</> : null}.
            </p>
          ) : (
            <p>{failed ? 'The cross-checks did not load.' : rewound ? `${REWIND_WORDS.checks}, so no cross-check result is shown for this moment.` : 'The cross-checks have not answered yet.'}</p>
          )}
        </li>
        {ex ? (
          <li>
            <p>
              <b>Rewind:</b> see the site as it was. Try{' '}
              <Link to={`/supply?at=${ex.rewindAt}`} className="why__a">{fmtUtcLong(ex.firstAlertAt)}</Link>, the first alert before {fmtNamRule(Math.floor(ex.amountNam / 1e6))} million NAM were withdrawn from staking.
            </p>
          </li>
        ) : null}
      </ol>

      <div className="proof">
        <Tag cat={`Static, dated ${day}`} />
        <p>
          Tested on {PROOF.marketEventsTested} past events (report of {day}): {each ? `each of the ${PROOF.priceMovesTested}` : `${PROOF.priceMovesFlagged} of the ${PROOF.priceMovesTested}`} biggest price moves had an
          alert-size flow in the prior {PROOF.windowHours} hours{PROOF.medianLeadHours != null ? `, median ${PROOF.medianLeadHours.toFixed(1)} hours ahead` : ''}.
          {PROOF.baseRatePct != null ? ` Such flows precede ${Math.round(PROOF.baseRatePct)}% of all hours, so this shows the alerts are not blind, not that they predict direction.` : ''}
        </p>
      </div>

      {checks.length ? (
        <>
          {look.length ? (
            <ul className="chks">
              {look.map((c) => <CheckRow key={c.key} c={c} />)}
            </ul>
          ) : null}
          {pass.length ? (
            <details className="passes">
              <summary>
                <span>The {pass.length} that pass</span>
                <Icon name="chev" className="ico" />
              </summary>
              <ul className="chks">
                {pass.map((c) => <CheckRow key={c.key} c={c} />)}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
      <SourceLine
        lead="Cross-checks"
        items={[{ label: 'The cross-checks', p: cs }]}
        text={(n) => (cs.at != null ? ` ran ${fmtAge(n - cs.at) === 'now' ? 'just now' : `${fmtAge(n - cs.at)} ago`} · fresh` : rewound ? ' · not recorded then' : ' · no data')}
        label="When the checks ran"
      />
    </section>
  );
}

function CheckRow({ c }: { c: Check }) {
  const ui = checkUi(c.status);
  const d = checkDetail(c);
  return (
    <li className="chk" data-key={c.key} data-status={ui.status}>
      <span className="chk__t"><i className="dot" data-status={ui.status} aria-hidden="true" />{CHECK_TITLES[c.key] ?? 'A cross-check'}</span>
      <span className="chk__w">{ui.word}</span>
      {d ? <span className="chk__d">{d}</span> : null}
    </li>
  );
}
