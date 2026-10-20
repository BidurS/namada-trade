// Ready to sell on Osmosis (decision D2): NAM that crossed to Osmosis in the window and has not
// been sold or sent back, one row per receiving address. Rows on phones; a six-column table from
// a 640 px container. The list is one ProvScope with one SourceLine (the flow index), dimmed once
// when the flow index is old. An address with nothing left (all of it sold or sent back) is not a
// row of this list: such addresses are listed briefly under it. "Last bridged in" is the last
// crossing to Osmosis in the window, not the address's last move of any kind.
import type { OnDeckEntry, Overview, Pressure, SupplyCohortBreakdown } from '../../../../shared/types';
import { EmptyState, Num, ProvScope, SourceLine, Tag, Term, derive, useUiNow, type ScopeItem } from '../../ui';
import { fmtAge, fmtAgo, fmtAddr, fmtNamRule, fmtPctRule, fmtUsdRule, fmtUsdWhole } from '../../lib/format';
import { AddrName, YouTag, useShowAll } from '../../ui';
import { isOld, lastWindow, oldRowsSentence } from './parts';

const FIRST = 8;
/** Shows as "0 NAM" (fmtNamRule rounds to two decimals): none of it is left. */
const noneLeft = (e: OnDeckEntry) => e.remaining < 0.005;
/**
 * Sold and sent back as counted against what crossed (a server from 2026-10-18 sends them), so bridged in − sold −
 * sent back = left on every row; an older server sends only the raw totals.
 */
const soldOf = (e: OnDeckEntry) => e.soldCounted ?? e.soldSince;
const backOf = (e: OnDeckEntry) => e.sentBackCounted ?? e.bridgedOutSince;
/** The address also sold NAM it did not bridge in (bought on Osmosis): the counted sale is less than all its sales. */
const soldMore = (e: OnDeckEntry) => e.soldCounted != null && e.soldSince - e.soldCounted > 0.005;

export function ReadyToSell({ data, overview: o, isMine }: { data: Pressure; overview: Overview | null; isMine: (a: string | null | undefined) => boolean }) {
  const now = useUiNow();
  // Osmosis records only (crossings in, sales, sends back): the Osmosis flow index's stamp when the server stamps each chain
  const cov = data.coverageByChain?.osmosis ?? data.coverage;
  const price = o?.price.usd ?? null;
  const left = data.onDeck.filter((e) => !noneLeft(e));
  const gone = data.onDeck.filter(noneLeft);
  const [rows, more] = useShowAll(left, FIRST);
  const valueStamp = price ? derive([cov, price.prov], 'NAM left × NAM price') : null;
  const scope: ScopeItem[] = [
    { label: 'NAM bridged, sold and sent back, per address', p: cov },
    ...(o ? [{ label: 'NAM held on Osmosis (wallets and pools)', p: o.supply.osmosisProv }, { label: 'Money in the Osmosis pools', p: o.dex.prov }] : []),
    ...(valueStamp ? [{ label: 'Dollar value of what is left', p: valueStamp }] : []),
  ];
  const old = isOld(cov);

  return (
    <ProvScope as="section" className="ipg-sec ipg-col--7" aria-labelledby="rts-h" data-decision="D2">
      <div className="ipg-sec__head">
        <h2 id="rts-h" className="h2">Ready to sell on Osmosis</h2>
        <p className="lead ipg-lead">
          <Term id="ready-to-sell">NAM that crossed to Osmosis</Term> in {lastWindow(data.windowDays)} and has not been sold or sent back, by the address that received it.
        </p>
        {o ? (
          <dl className="ipg-kv">
            <div><dt>All NAM held on Osmosis, wallets and pools</dt><dd><Num v={o.supply.osmosis} prov={o.supply.osmosisProv} fmt={fmtNamRule} unit="NAM" showAge={false} /></dd></div>
            <div><dt>Money in the pools there</dt><dd><Num v={o.dex.liquidityUsd} prov={o.dex.prov} fmt={fmtUsdWhole} showAge={false} /></dd></div>
          </dl>
        ) : null}
      </div>

      {data.pipelineSummary && (data.onDeckTotals?.bridgedIn ?? 0) > 0 ? (
        <CohortPipelineChart
          summary={data.pipelineSummary}
          bridgedIn={data.onDeckTotals?.bridgedIn ?? 0}
          sold={data.onDeckTotals?.sold ?? 0}
          sentBack={data.onDeckTotals?.sentBack ?? 0}
          remaining={data.onDeckTotal}
          windowDays={data.windowDays}
        />
      ) : null}

      {data.onDeck.length === 0 ? (
        <EmptyState title={`No NAM crossed to Osmosis in ${lastWindow(data.windowDays)}.`}>
          Every crossing from Namada to Osmosis would be listed here with what was sold or sent back since.
        </EmptyState>
      ) : left.length === 0 ? (
        <EmptyState title="None of it is left.">
          <GoneLine gone={gone} windowDays={data.windowDays} all />
        </EmptyState>
      ) : (
        <div className={`xlist${old ? ' is-old' : ''}`}>
          {old ? (
            <p className="scope__old">
              <i className="dot" data-status="old" aria-hidden="true" />
              <span>{oldRowsSentence(cov, now)}</span>
            </p>
          ) : null}
          <div className="rts" role="table" aria-label={`NAM ready to sell on Osmosis, ${lastWindow(data.windowDays)}`}>
            <div className="rts__head" role="row">
              <span role="columnheader">Received by</span>
              <span role="columnheader" className="r">Bridged in</span>
              <span role="columnheader" className="r">Sold</span>
              <span role="columnheader" className="r">Sent back</span>
              <span role="columnheader" className="r">Left</span>
              <span role="columnheader" className="r">Last bridged in</span>
            </div>
            {rows.map((e) => (
              <RtsRow key={e.address} e={e} now={now} price={price?.value ?? null} mine={isMine(e.address) || isMine(e.linkedNamada)} />
            ))}
          </div>
          {more}
          {data.onDeck.some(soldMore) ? (
            <p className="cap">Sold and sent back count only the NAM that crossed: an address that also sold NAM it bought on Osmosis shows at most what it bridged in.</p>
          ) : null}
          {gone.length ? <GoneLine gone={gone} windowDays={data.windowDays} /> : null}
        </div>
      )}
      <SourceLine items={scope} label="Where the ready-to-sell figures come from" />
    </ProvScope>
  );
}

function CohortPipelineChart({
  summary,
  bridgedIn,
  sold,
  sentBack,
  remaining,
  windowDays,
}: {
  summary: SupplyCohortBreakdown;
  bridgedIn: number;
  sold: number;
  sentBack: number;
  remaining: number;
  windowDays: number;
}) {
  const c = summary.cohorts;
  const totalCohort = Math.max(
    1e-9,
    c.genesisBackersNam + c.maspTurnstileNam + c.burnerHopNam + c.transparentNam,
  );
  const segments = [
    { key: 'genesis', label: 'Genesis backers', nam: c.genesisBackersNam, cls: 'sp-pipe__seg--genesis' },
    { key: 'turnstile', label: 'MASP turnstile (<24h)', nam: c.maspTurnstileNam, cls: 'sp-pipe__seg--turnstile' },
    { key: 'burner', label: '2-hop burner relays', nam: c.burnerHopNam, cls: 'sp-pipe__seg--burner' },
    { key: 'transparent', label: 'Direct transparent', nam: c.transparentNam, cls: 'sp-pipe__seg--transparent' },
  ].filter((s) => s.nam > 0.005);

  const soldPct = bridgedIn > 0 ? Math.min(100, (sold / bridgedIn) * 100) : 0;
  const backPct = bridgedIn > 0 ? Math.min(100 - soldPct, (sentBack / bridgedIn) * 100) : 0;
  const remPct = Math.max(0, 100 - soldPct - backPct);

  return (
    <div className="sp-pipe" role="region" aria-label={`Cross-chain supply-to-dump pipeline, ${lastWindow(windowDays)}`}>
      <div className="sp-pipe__head">
        <p className="eyebrow">Supply-to-dump pipeline · Origin cohort attribution ({lastWindow(windowDays)})</p>
        <p className="cap">
          Where the <span data-num="">{fmtNamRule(bridgedIn)}</span> NAM bridged to Osmosis originated on Namada, and how much of it has already sold vs. remains on deck.
          {summary.highHazardRemainingNam > 0 ? (
            <> High-hazard wallets (historical dump rate ≥50%) hold <strong data-num="">{fmtNamRule(summary.highHazardRemainingNam)} NAM</strong> of the remaining balance.</>
          ) : null}
        </p>
      </div>
      <div className="sp-pipe__bars">
        <div className="sp-pipe__row">
          <span className="sp-pipe__lbl">1. Source cohort</span>
          <div className="sp-pipe__track" role="img" aria-label="Bridged NAM by origin cohort">
            {segments.map((s) => (
              <span
                key={s.key}
                className={`sp-pipe__seg ${s.cls}`}
                style={{ width: `${Math.max(2, (s.nam / totalCohort) * 100).toFixed(1)}%` }}
                title={`${s.label}: ${fmtNamRule(s.nam)} NAM (${fmtPctRule((s.nam / totalCohort) * 100, 1)})`}
              />
            ))}
          </div>
        </div>
        <div className="sp-pipe__row">
          <span className="sp-pipe__lbl">2. Osmosis disposition</span>
          <div className="sp-pipe__track" role="img" aria-label="Disposition of bridged NAM on Osmosis">
            {sold > 0.005 ? (
              <span
                className="sp-pipe__seg sp-pipe__seg--sold"
                style={{ width: `${Math.max(2, soldPct).toFixed(1)}%` }}
                title={`Sold into pools: ${fmtNamRule(sold)} NAM (${fmtPctRule(soldPct, 1)})`}
              />
            ) : null}
            {remaining > 0.005 ? (
              <span
                className="sp-pipe__seg sp-pipe__seg--rem"
                style={{ width: `${Math.max(2, remPct).toFixed(1)}%` }}
                title={`Ready to sell (on deck): ${fmtNamRule(remaining)} NAM (${fmtPctRule(remPct, 1)})`}
              />
            ) : null}
            {sentBack > 0.005 ? (
              <span
                className="sp-pipe__seg sp-pipe__seg--back"
                style={{ width: `${Math.max(2, backPct).toFixed(1)}%` }}
                title={`Sent back to Namada: ${fmtNamRule(sentBack)} NAM (${fmtPctRule(backPct, 1)})`}
              />
            ) : null}
          </div>
        </div>
      </div>
      <div className="sp-pipe__legend">
        {segments.map((s) => (
          <span key={s.key} className="sp-pipe__item">
            <i className={`sp-pipe__sw ${s.cls}`} aria-hidden="true" />
            <span>{s.label}: <strong data-num="">{fmtNamRule(s.nam)}</strong> NAM</span>
          </span>
        ))}
        <span className="sp-pipe__item">
          <i className="sp-pipe__sw sp-pipe__seg--sold" aria-hidden="true" />
          <span>Sold: <strong data-num="">{fmtNamRule(sold)}</strong> NAM</span>
        </span>
        <span className="sp-pipe__item">
          <i className="sp-pipe__sw sp-pipe__seg--rem" aria-hidden="true" />
          <span>On deck: <strong data-num="">{fmtNamRule(remaining)}</strong> NAM</span>
        </span>
      </div>
    </div>
  );
}

function RtsRow({ e, now, price, mine }: { e: OnDeckEntry; now: number; price: number | null; mine: boolean }) {
  const name = e.labelPlain ?? null;
  const linked = e.linkedLabelPlain ?? null;
  const hazardPct = e.dumpHazardScore != null ? Math.round(e.dumpHazardScore * 100) : null;
  const hasTags = e.priorSells30d > 0 || (hazardPct != null && hazardPct > 0) || !!e.passthroughFrom || mine;
  return (
    <div className="rts__row" role="row">
      <span className="rts__id" role="cell">
        <span className="rts__name"><AddrName address={e.address} label={name} source={e.labelSource} author={e.labelAuthor} /></span>
        <span className="rts__sub">
          {name ? <span className="mono">{fmtAddr(e.address)}</span> : null}
          {e.linkedNamada ? (
            <span className="rts__link">
              {/* a shared genesis label prints its short address: the label alone cannot tell a seller from the largest holder */}
              <AddrName address={e.linkedNamada} label={linked} prefix="from" withAddr source={e.linkedLabelSource} author={e.linkedLabelAuthor} className={linked ? 'xaddr--sm' : 'xaddr--sm xaddr--mono'} />
            </span>
          ) : null}
          {e.hopOriginNamada ? (
            <span className="rts__link">
              <AddrName address={e.hopOriginNamada.address} label={e.hopOriginNamada.labelPlain ?? null} prefix="via 2-hop relay from" withAddr className="xaddr--sm xaddr--mono" />
            </span>
          ) : null}
        </span>
        {hasTags ? (
          <span className="rts__tags">
            {hazardPct != null && hazardPct > 0 ? (
              <Tag
                look={hazardPct >= 60 ? 'ref' : 'cat'}
                cat={<>Dump hazard: <span data-num="">{hazardPct}%</span></>}
              />
            ) : null}
            {e.passthroughFrom ? (
              <Tag
                look="ref"
                cat={<>MASP turnstile (&lt;24h · k={e.passthroughFrom.anonymitySetK})</>}
              />
            ) : null}
            {e.priorSells30d > 0 ? <Tag cat={<>Sold before: <span data-num="">{fmtNamRule(e.priorSells30d)}</span> NAM</>} /> : null}
            {mine ? <YouTag /> : null}
          </span>
        ) : null}
      </span>
      <span className="rts__left" role="cell">
        <Num v={e.remaining} fmt={fmtNamRule} unit="NAM" />
        {price != null ? <span className="rts__usd"><Num v={e.remaining * price} fmt={fmtUsdRule} /></span> : null}
      </span>
      <span className="rts__how" role="cell">
        bridged in <Num v={e.bridgedIn} fmt={fmtNamRule} />, sold <Num v={soldOf(e)} fmt={fmtNamRule} />, sent back <Num v={backOf(e)} fmt={fmtNamRule} /> · last bridged in {fmtAgo(e.lastSeen, now)}
      </span>
      <span className="rts__c rts__c--in" role="cell"><Num v={e.bridgedIn} fmt={fmtNamRule} /></span>
      <span className="rts__c rts__c--sold" role="cell"><Num v={soldOf(e)} fmt={fmtNamRule} /></span>
      <span className="rts__c rts__c--out" role="cell"><Num v={backOf(e)} fmt={fmtNamRule} /></span>
      <span className="rts__c rts__c--last" role="cell">{fmtAge(now - e.lastSeen)}</span>
    </div>
  );
}

/**
 * The addresses that received NAM in the window and have none of it left: one sentence ("2 more addresses that
 * received NAM in the last 7 days have none of it left, all sold or sent back:"), then each address on its own
 * line with what became of it. Each name opens the address. Not running text: two names on neighbouring lines of
 * a sentence would share their 44 px tap areas, and a tap on one would open the other.
 */
function GoneLine({ gone, windowDays, all }: { gone: OnDeckEntry[]; windowDays: number; all?: boolean }) {
  const n = gone.length;
  const who = all ? (n === 1 ? 'The one address' : `All ${n} addresses`) : n === 1 ? 'One more address' : `${n} more addresses`;
  return (
    <div className="rts-gone">
      <p className="cap">
        {who} that received NAM in {lastWindow(windowDays)} {n === 1 ? 'has' : 'have'} none of it left, all sold or sent back:
      </p>
      <ul className="rts-gone__list">
        {gone.map((e) => (
          <li key={e.address} className="rts-gone__i">
            <span className="rts-gone__n"><AddrName address={e.address} label={e.labelPlain ?? null} withAddr source={e.labelSource} author={e.labelAuthor} className="xaddr--sm" /></span>
            <span className="rts-gone__how">
              bridged in <Num v={e.bridgedIn} fmt={fmtNamRule} />, sold <Num v={soldOf(e)} fmt={fmtNamRule} />, sent back <Num v={backOf(e)} fmt={fmtNamRule} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
