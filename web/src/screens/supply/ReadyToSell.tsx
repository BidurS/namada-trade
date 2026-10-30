// Ready to sell on Osmosis (decision D2): NAM that crossed to Osmosis in the window and has not
// been sold or sent back, one row per receiving address. Rows on phones; a six-column table from
// a 640 px container. The list is one ProvScope with one SourceLine (the flow index), dimmed once
// when the flow index is old. An address with nothing left (all of it sold or sent back) is not a
// row of this list: such addresses are listed briefly under it. "Last crossed in" is the last
// crossing to Osmosis in the window, not the address's last move of any kind.
//
// Above the rows, "Where this NAM came from, and what happened to it" (WhereFrom, when the server sends
// Pressure.pipelineSummary): two bars over the same NAM, where it was before it crossed and what has
// happened to it since, each with every figure written out under it (no hover). It has its own ProvScope
// and SourceLine: the origins are read from address tags and links, two of them only likely links.
// A row's selling estimate (OnDeckEntry.dumpHazardScore) shows only at or above the cut the server
// uses (shared/supply-thresholds.ts), as a plain figure, never highlighted.
import type { OnDeckEntry, Overview, Pressure, SupplyCohortBreakdown } from '../../../../shared/types';
import { SELLS_MOST_CUT, SELLS_MOST_PCT } from '../../../../shared/supply-thresholds';
import { EmptyState, Num, ProvScope, SourceLine, Tag, Term, derive, useUiNow, type ScopeItem, type Stamp } from '../../ui';
import { fmtAge, fmtAgo, fmtAddr, fmtCount, fmtNamRule, fmtPctRule, fmtUsdRule, fmtUsdWhole } from '../../lib/format';
import { AddrName, YouTag, useShowAll } from '../../ui';
import { isOld, lastWindow, oldRowsSentence } from './parts';

const FIRST = 8;
/** Shows as "0 NAM" (fmtNamRule rounds to two decimals): none of it is left. */
const noneLeft = (e: OnDeckEntry) => e.remaining < 0.005;
/**
 * Sold and sent back as counted against what crossed (a server from 2026-10-18 sends them), so crossed in − sold −
 * sent back = left on every row; an older server sends only the raw totals.
 */
const soldOf = (e: OnDeckEntry) => e.soldCounted ?? e.soldSince;
const backOf = (e: OnDeckEntry) => e.sentBackCounted ?? e.bridgedOutSince;
/** The address also sold NAM it did not bring over (bought on Osmosis): the counted sale is less than all its sales. */
const soldMore = (e: OnDeckEntry) => e.soldCounted != null && e.soldSince - e.soldCounted > 0.005;
/** The row's selling estimate shows only at or above the cut (the server's own). */
const sellsMost = (e: OnDeckEntry) => e.dumpHazardScore != null && e.dumpHazardScore >= SELLS_MOST_CUT;
const pct0 = (x: number) => fmtPctRule(x, 0);
/** An origin the server's split left out: "—" with the reason. */
const NOT_SENT: Stamp = { source: 'D1 flow index', plain: 'Flow index', at: null, status: 'missing', note: 'The server did not send this part.' };
const pct1 = (x: number) => fmtPctRule(x, 1);

export function ReadyToSell({ data, overview: o, isMine }: { data: Pressure; overview: Overview | null; isMine: (a: string | null | undefined) => boolean }) {
  const now = useUiNow();
  // Osmosis records only (crossings in, sales, sends back): the Osmosis flow index's stamp for what each receiver has
  // left (its sells read from 30 days before the window), else the chain's own, else both indexes together
  const cov = data.onDeckProv ?? data.coverageByChain?.osmosis ?? data.coverage;
  const price = o?.price.usd ?? null;
  const left = data.onDeck.filter((e) => !noneLeft(e));
  const gone = data.onDeck.filter(noneLeft);
  const [rows, more] = useShowAll(left, FIRST);
  const valueStamp = price ? derive([cov, price.prov], 'NAM left × NAM price') : null;
  const anyEstimate = left.some(sellsMost);
  const estimateStamp = derive([cov], `selling estimate of each address from its own sales, shown at ${pct0(SELLS_MOST_PCT)} or more`);
  const scope: ScopeItem[] = [
    { label: 'NAM crossed in, sold and sent back, per address', p: cov },
    ...(anyEstimate ? [{ label: 'Selling estimate on a row', p: estimateStamp }] : []),
    ...(o ? [{ label: 'NAM held on Osmosis (wallets and pools)', p: o.supply.osmosisProv }, { label: 'Money in the Osmosis pools', p: o.dex.prov }] : []),
    ...(valueStamp ? [{ label: 'Dollar value of what is left', p: valueStamp }] : []),
  ];
  const old = isOld(cov);
  const totals = data.onDeckTotals ?? null;

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

      {totals && totals.bridgedIn > 0 ? (
        data.pipelineSummary?.cohorts ? (
          <WhereFrom summary={data.pipelineSummary} totals={totals} receivers={data.onDeck.length} windowDays={data.windowDays} cov={cov} />
        ) : (
          <p className="cap sp-pipe__none">Where this NAM was before it crossed is not sent by this server, so it is not shown.</p>
        )
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
              <span role="columnheader" className="r">Crossed in</span>
              <span role="columnheader" className="r">Sold</span>
              <span role="columnheader" className="r">Sent back</span>
              <span role="columnheader" className="r">Left</span>
              <span role="columnheader" className="r">Last crossed in</span>
            </div>
            {rows.map((e) => (
              <RtsRow key={e.address} e={e} now={now} price={price?.value ?? null} mine={isMine(e.address) || isMine(e.linkedNamada)} />
            ))}
          </div>
          {more}
          {anyEstimate ? (
            <p className="cap">
              A row shows its <Term id="selling-estimate">selling estimate</Term> only when it is <Num v={SELLS_MOST_PCT} fmt={pct0} /> or more: an estimate made from the address&rsquo;s own sales, not a forecast.
            </p>
          ) : null}
          {data.onDeck.some(soldMore) ? (
            <p className="cap">Sold and sent back count only the NAM that crossed: an address that also sold NAM it bought on Osmosis shows at most what it brought over.</p>
          ) : null}
          {gone.length ? <GoneLine gone={gone} windowDays={data.windowDays} /> : null}
        </div>
      )}
      <SourceLine items={scope} label="Where the ready-to-sell figures come from" />
    </ProvScope>
  );
}

/**
 * Where the NAM that crossed was before it crossed (the server's split: genesis-tagged addresses first, then the
 * shielded set, then a likely middle address, then any other address) and what has happened to it since. Each
 * bar is drawn to scale (a part too small to see is still written out under it); every figure is in the list
 * under its bar, readable without hover.
 */
function WhereFrom({ summary, totals, receivers, windowDays, cov }: { summary: SupplyCohortBreakdown; totals: NonNullable<Pressure['onDeckTotals']>; receivers: number; windowDays: number; cov: Stamp }) {
  const c = summary.cohorts;
  const before = [
    { key: 'genesis', label: <Term id="early-backers">Early backers, team and genesis addresses</Term>, nam: c.genesisBackersNam, cls: 'sp-pipe__f--genesis' },
    { key: 'shielded', label: <>Out of the <Term id="shielded-set">shielded set</Term></>, nam: c.maspTurnstileNam, cls: 'sp-pipe__f--shielded' },
    { key: 'middle', label: <Term id="through-a-middle-address">Likely through a middle address</Term>, nam: c.burnerHopNam, cls: 'sp-pipe__f--middle' },
    { key: 'other', label: <Term id="other-public-addresses">Other public addresses</Term>, nam: c.transparentNam, cls: 'sp-pipe__f--other' },
  ];
  // every origin must be a figure for the shares to mean anything: with one missing, the parts sent are written
  // out and the missing one says so, but no bar and no percentages are drawn over a part of the whole
  const beforeAll = before.every((s) => typeof s.nam === 'number' && Number.isFinite(s.nam));
  const beforeSum = beforeAll ? before.reduce((a, s) => a + s.nam, 0) : 0;
  const after = [
    { key: 'sold', label: 'Sold', nam: totals.sold, cls: 'sp-pipe__f--sold' },
    { key: 'left', label: 'Still there', nam: totals.remaining, cls: 'sp-pipe__f--left' },
    { key: 'back', label: 'Sent back to Namada', nam: totals.sentBack, cls: 'sp-pipe__f--back' },
  ];
  const afterSum = after.reduce((a, s) => a + s.nam, 0);
  const originStamp = derive([cov], 'the tag and the Namada link of each receiving address; the shielded-set and middle-address links are likely, not proven');
  const estimateStamp = derive([cov], `selling estimate of each address from its own sales, cut at ${pct0(SELLS_MOST_PCT)}`);
  const scope: ScopeItem[] = [
    { label: 'NAM crossed in, sold and sent back', p: cov },
    { label: 'Where it was before it crossed', p: originStamp },
    ...((summary.highHazardRemainingNam ?? 0) > 0 ? [{ label: `NAM still there with addresses whose selling estimate is ${pct0(SELLS_MOST_PCT)} or more`, p: estimateStamp }] : []),
  ];
  const share = (n: number, of: number) => (of > 0 ? (n / of) * 100 : null);
  const aria = (parts: { nam: number | null }[], names: string[], of: number) =>
    parts.map((p, i) => (p.nam == null || !Number.isFinite(p.nam) ? `${names[i]} not sent` : `${names[i]} ${fmtNamRule(p.nam)} NAM${of > 0 ? ` (${pct1(share(p.nam, of) ?? 0)})` : ''}`)).join(', ');

  return (
    <ProvScope className="sp-pipe" role="region" aria-labelledby="sp-pipe-h">
      <div className="sp-pipe__head">
        <h3 id="sp-pipe-h" className="h3">Where this NAM came from, and what happened to it</h3>
        <p className="cap">
          Of the <Num v={totals.bridgedIn} fmt={fmtNamRule} unit="NAM" /> that crossed to Osmosis in {lastWindow(windowDays)} to the{' '}
          {receivers === 1 ? 'one address' : <><Num v={receivers} fmt={fmtCount} /> addresses</>} below: where it was before it crossed, and how much has been sold, sent back or is still there.
        </p>
      </div>
      <Bar
        title="Before it crossed"
        parts={before}
        of={beforeSum}
        missingNote={beforeAll ? null : 'The server did not send every origin, so the shares and the bar are not drawn; the origins it sent are listed.'}
        aria={`Before it crossed: ${aria(before, ['Early backers, team and genesis addresses', 'Out of the shielded set', 'Likely through a middle address', 'Other public addresses'], beforeSum)}`}
      />
      <Bar title="After it crossed" parts={after} of={afterSum} aria={`After it crossed: ${aria(after, ['Sold', 'Still there', 'Sent back to Namada'], afterSum)}`} />
      {(summary.highHazardRemainingNam ?? 0) > 0 ? (
        <p className="cap">
          Of what is still there, <Num v={summary.highHazardRemainingNam} fmt={fmtNamRule} unit="NAM" /> sits with addresses whose <Term id="selling-estimate">selling estimate</Term> is <Num v={SELLS_MOST_PCT} fmt={pct0} /> or more.
        </p>
      ) : null}
      <SourceLine items={scope} label="Where the origin figures come from" />
    </ProvScope>
  );
}

function Bar({ title, parts, of, aria, missingNote = null }: { title: string; parts: { key: string; label: React.ReactNode; nam: number | null; cls: string }[]; of: number; aria: string; missingNote?: string | null }) {
  return (
    <div className="sp-pipe__row">
      <p className="sp-pipe__lbl">{title}</p>
      {missingNote ? (
        <p className="cap">{missingNote}</p>
      ) : (
        <div className="sp-pipe__track" role="img" aria-label={aria}>
          {of > 0
            ? parts.map((s) => (s.nam != null && s.nam > 0 ? <span key={s.key} className={`sp-pipe__seg ${s.cls}`} style={{ width: `${((s.nam / of) * 100).toFixed(2)}%` }} /> : null))
            : null}
        </div>
      )}
      <ul className="sp-pipe__legend">
        {parts.map((s) => (
          <li key={s.key} className="sp-pipe__item">
            <i className={`sp-pipe__sw ${s.cls}`} aria-hidden="true" />
            <span className="sp-pipe__name">{s.label}</span>
            <span className="sp-pipe__v">
              <Num v={s.nam} fmt={fmtNamRule} unit="NAM" prov={s.nam == null || !Number.isFinite(s.nam) ? NOT_SENT : undefined} />
              {of > 0 && s.nam != null && Number.isFinite(s.nam) ? <span className="sp-pipe__pct"><Num v={(s.nam / of) * 100} fmt={pct1} /></span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RtsRow({ e, now, price, mine }: { e: OnDeckEntry; now: number; price: number | null; mine: boolean }) {
  const name = e.labelPlain ?? null;
  const linked = e.linkedLabelPlain ?? null;
  const est = sellsMost(e);
  const pt = e.passthroughFrom ?? null;
  const hasTags = e.priorSells30d > 0 || est || mine;
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
              <AddrName address={e.hopOriginNamada.address} label={e.hopOriginNamada.labelPlain ?? null} prefix="likely through a middle address, from" withAddr className="xaddr--sm xaddr--mono" />
            </span>
          ) : null}
          {pt ? (
            <span className="rts__via">
              {pt.confidence === 'low' ? 'Possibly' : 'Likely'} out of the shielded set less than a day after going in (one of <Num v={pt.anonymitySetK} fmt={fmtCount} /> {pt.anonymitySetK === 1 ? 'move' : 'moves'} of that size it could match)
            </span>
          ) : null}
        </span>
        {hasTags ? (
          <span className="rts__tags">
            {est ? <Tag cat={<>Selling estimate <span data-num="">{pct0((e.dumpHazardScore as number) * 100)}</span></>} /> : null}
            {e.priorSells30d > 0 ? <Tag cat={<>Sold <span data-num="">{fmtNamRule(e.priorSells30d)}</span> NAM in the 30 days before the window</>} /> : null}
            {mine ? <YouTag /> : null}
          </span>
        ) : null}
      </span>
      <span className="rts__left" role="cell">
        <Num v={e.remaining} fmt={fmtNamRule} unit="NAM" />
        {price != null ? <span className="rts__usd"><Num v={e.remaining * price} fmt={fmtUsdRule} /></span> : null}
      </span>
      <span className="rts__how" role="cell">
        crossed in <Num v={e.bridgedIn} fmt={fmtNamRule} />, sold <Num v={soldOf(e)} fmt={fmtNamRule} />, sent back <Num v={backOf(e)} fmt={fmtNamRule} /> · last crossed in {fmtAgo(e.lastSeen, now)}
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
              crossed in <Num v={e.bridgedIn} fmt={fmtNamRule} />, sold <Num v={soldOf(e)} fmt={fmtNamRule} />, sent back <Num v={backOf(e)} fmt={fmtNamRule} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
