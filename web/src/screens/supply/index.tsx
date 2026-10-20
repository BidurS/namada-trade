// Supply (/supply), S3: "Is a big sale coming?" in plain words (system.md 9.3; decisions D2, D3, D4).
//
// Yellow band: the dateline, the H1, the page's first plain paragraph (shared/copy.ts), the
// hero figure "Ready to sell" (NAM that crossed to Osmosis in the window and has not been sold
// or sent back) with its ProvChip and its dollar value derived from the price, the window
// (1, 7 or 30 days), and a fact strip with one SourceLine. Black body: Ready to sell on Osmosis,
// Who is moving the price, Unstaking and restaking with the staked-NAM chart, Votes in progress
// (only when there are any), then the page's second plain paragraph.
//
// Data: fetchPressure(at, days) and the shell's overview. Under Rewind the shell's fetch
// wrapper adds `at` to both; nothing on this screen is live-only, and the address sheet says
// itself that balances are current. Live, the figures are refreshed every 2 minutes while the
// tab is visible and when it becomes visible again (parts.ts useLiveLoad); a refresh that fails
// keeps them, marked old with the reason.
import { useMemo, useState } from 'react';
import type { Pressure } from '../../../../shared/types';
import { BODY } from '../../../../shared/copy';
import type { ScreenProps } from '../../app/index';
import { useOverview, useReplay, useSession } from '../../app/index';
import { fetchPressure } from '../../api';
import { ageOutStamps, unbondingStamp, type Stamp } from '../../lib/prov';
import { Derived, Fact, HeroNumber, Notice, Num, ProvChip, ProvDot, Segmented, Skeleton, SkeletonBlock, Term, derive, useUiNow, type FactItem } from '../../ui';
import { NBSP, fmtCount, fmtDateline, fmtNamRule, fmtNamSigned, fmtPctRule, fmtUsdRule } from '../../lib/format';
import { isMineIn } from '../../ui';
import { lastWindow, refreshFailedNote, refreshFailedSentence, useLiveLoad, type WindowDays } from './parts';
import { ReadyToSell } from './ReadyToSell';
import { Movers } from './Movers';
import { UNLOCKS_ID, Unlocks, windowWords, type UnlockFilter } from './Unlocks';
import { Votes } from './Votes';
import { epochMs, unbondStates, unbondSums, unbondingAllOf, waitingAll } from './unbonds';

/** The stamp of a figure whose request failed: no data, and why. */
const FAILED: Stamp = { source: 'Flow index', plain: 'Flow index', at: null, status: 'missing', note: 'did not load' };

const WINDOWS: { value: `${WindowDays}`; label: string }[] = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
];

export default function SupplyScreen({ route }: ScreenProps) {
  const { overview: o } = useOverview();
  const { at, rewound } = useReplay();
  const { session } = useSession();
  const now = useUiNow();
  const [days, setDays] = useState<WindowDays>(7);
  const [ulFilter, setUlFilter] = useState<UnlockFilter>('all');
  const load = useLiveLoad<Pressure>(at, String(days), () => fetchPressure(at, days));
  // after a failed refresh the figures stay, every stamp marked old with the reason
  const data = useMemo(
    () => (load.data && load.refreshFailedAt ? ageOutStamps(load.data, refreshFailedNote(load.fetchedAt)) : load.data),
    [load.data, load.refreshFailedAt, load.fetchedAt],
  );
  const err = load.failed ? 'The supply figures did not load: the server did not answer.' : null;
  const busy = load.busy;

  const mine = session ? [session.address, ...(session.linked ? [session.linked] : [])] : [];
  const isMine = isMineIn(mine);
  const asOf = at ?? data?.asOf ?? o?.generatedAt ?? null;
  const w = data?.windowDays ?? days;
  const wWords = lastWindow(w);
  const lead = BODY.supply.paras;

  // ---------------- the hero: Ready to sell ----------------
  // Everything in the hero and the first two facts is counted from Osmosis records: the Osmosis flow index
  // stamps it when the server stamps each chain (Pressure.coverageByChain), else both indexes together.
  const cov = data ? (data.coverageByChain?.osmosis ?? data.coverage) : null;
  const totals = data?.onDeckTotals ?? null;
  const price = o?.price.usd ?? null;
  const usdStamp = data && cov && price ? derive([cov, price.prov], 'ready to sell × NAM price') : null;
  const hero = data ? (
    <HeroNumber
      size="48"
      className="sp-hero__n"
      label={<Term id="ready-to-sell">Ready to sell</Term>}
      chip={<ProvChip p={cov} label="Ready to sell" />}
      value={<Num v={data.onDeckTotal} prov={cov} fmt={fmtNamRule} unit="NAM" showAge={false} />}
      sub={
        <>
          <span className="sp-hero__usd">
            {price && usdStamp ? (
              <>
                <span>Worth <Num v={price.value != null ? data.onDeckTotal * price.value : null} prov={usdStamp} fmt={fmtUsdRule} showAge={false} /> {rewound ? 'at the price then' : 'at the last quoted price'}</span>
                <ProvDot p={usdStamp} label="Ready to sell, in dollars" />
              </>
            ) : (
              <>The dollar value appears with the price.</>
            )}
          </span>
          <span className="sp-hero__def">
            NAM that crossed to Osmosis in {wWords}, minus what has been sold or sent back
            {totals ? (
              <>
                : <Num v={totals.bridgedIn} prov={cov} fmt={fmtNamRule} showAge={false} /> NAM bridged in by the {data.onDeck.length === 1 ? 'one receiver' : `${data.onDeck.length} receivers`} listed below,{' '}
                <Num v={totals.sold} prov={cov} fmt={fmtNamRule} showAge={false} /> sold and <Num v={totals.sentBack} prov={cov} fmt={fmtNamRule} showAge={false} /> sent back.
              </>
            ) : (
              '.'
            )}
          </span>
        </>
      }
    />
  ) : (
    <div className="sp-hero__n sp-hero__skel" aria-busy="true">
      <div className="hero-n__top"><p className="hero-n__label">Ready to sell</p><span className="skel__b skel__chip" /></div>
      <SkeletonBlock height={48} width="60%" />
      <SkeletonBlock height={22} width="70%" />
      <SkeletonBlock height={20} width="40%" />
      <SkeletonBlock height={44} width="90%" />
    </div>
  );

  // ---------------- unstaked NAM (decision D3): what the unstaking list below holds, in two figures ----------------
  const states = useMemo(() => (data ? unbondStates(data.unlocks, data.asOf, epochMs(data)) : null), [data]);
  const sums = states ? unbondSums(states) : null;
  const waitStamp = data ? unbondingStamp(data) : null;
  const ulWords = data ? `${data.unlocksMinNam ? `unstaking requests of at least ${fmtNamRule(data.unlocksMinNam)} NAM` : 'the large unstaking requests'} recorded in ${windowWords(data)}` : '';
  // Namada-side figures: the Namada flow index when the server stamps each chain (Pressure.coverageByChain), else both
  const namCov: Stamp | null = data ? (data.coverageByChain?.namada ?? data.coverage) : null;
  const ulStamp = (what: string): Stamp | null => {
    if (!data || !namCov) return null;
    const d = derive(waitStamp ? [namCov, waitStamp] : [namCov], what);
    const note = [`Counts only ${ulWords}, as listed under Unstaking and restaking.`, d.note].filter(Boolean).join(' ');
    // a request whose wait is not known could be in either figure: neither is known then
    return sums && sums.unknown > 0 ? { ...d, status: 'missing', note: 'The unstaking wait was not read, so which requests can be withdrawn is not known.' } : { ...d, note };
  };
  const readyStamp = ulStamp('unstaking requests whose wait is over − those withdrawn since');
  const waitingStamp = ulStamp('unstaking requests still in their wait');
  // The list, and so both figures, holds only the large requests: the band says which, under each figure (a
  // server before 2026-10-17 does not send the minimum; it listed requests of the same size, but no figure is
  // typed in here). A server from 2026-10-18 on also counts every request still in its wait, of any size: then
  // the second figure is that count, so smaller requests never hide behind a 0.
  const minWords = data?.unlocksMinNam ? `only requests of ${fmtNamRule(data.unlocksMinNam)} NAM or more` : 'only the largest requests';
  const all = data ? unbondingAllOf(data) : null;
  const allW = all && states ? waitingAll(all, states) : null;
  const allStamp: Stamp | null = (() => {
    if (!data || !namCov || !allW) return null;
    const d = derive(waitStamp ? [namCov, waitStamp] : [namCov], 'unstaking requests of any size made within the unstaking wait');
    const span = data.unbondingDays != null ? `the last ${data.unbondingDays.toFixed(2)} days` : 'the unstaking wait';
    const note = [
      `Counts every unstaking request still in its wait, of any size: ${fmtCount(allW.n)} ${allW.n === 1 ? 'request' : 'requests'} made in ${span}.`,
      'The wait is counted from the request time, so a request near the start of that span can already be withdrawable, up to one epoch early; a request listed under Unstaking and restaking counts by its own end of wait.',
      d.note,
    ].filter(Boolean).join(' ');
    return { ...d, note };
  })();
  const ulFact = (v: number | undefined, p: Stamp | null) =>
    data && p ? <Num v={v ?? null} prov={p} fmt={fmtNamRule} unit="NAM" showAge={false} showReason={false} /> : err ? <Num v={null} prov={FAILED} /> : <SkeletonBlock height={28} width={110} />;
  // the size of the requests a staking figure counts, on its own line under the label
  const sizeLine = (words: string) => (data ? <span className="sp-fact__size">{words}</span> : null);

  // ---------------- the fact strip: Osmosis in the first row, staking in the second (3 columns; 2 on phones) ----------------
  // A server that sends onDeckTotals counts ibcIn7d / ibcOut7d over everyone (market-wide); an older one summed
  // the listed receivers only, so the words say which.
  const lastW = w === 1 ? 'last day' : `last ${w}${NBSP}days`;
  const refunded = data?.ibcRefunded7d ?? 0;
  const outStamp: Stamp | null = cov && refunded > 0 ? { ...cov, note: [`${fmtNamRule(refunded)} NAM in sends to Namada that timed out and were refunded is not counted.`, cov.note].filter(Boolean).join(' ') } : cov;
  const facts: FactItem[] = [
    {
      n: data ? <Num v={data.ibcIn7d} prov={cov} fmt={fmtNamRule} unit="NAM" showAge={false} /> : err ? <Num v={null} prov={FAILED} /> : <SkeletonBlock height={28} width={110} />,
      label: totals ? <>bridged to Osmosis by anyone, {lastW}</> : <>bridged to Osmosis, {lastW}</>,
      scope: data ? { label: totals ? `Bridged to Osmosis by anyone, ${wWords}` : `Bridged to Osmosis, ${wWords}`, p: cov } : undefined,
    },
    {
      n: data ? <Num v={data.ibcOut7d} prov={outStamp} fmt={fmtNamRule} unit="NAM" showAge={false} /> : err ? <Num v={null} prov={FAILED} /> : <SkeletonBlock height={28} width={110} />,
      label: totals ? <>bridged back out by anyone, {lastW}</> : <>bridged back out, {lastW}</>,
      scope: data ? { label: totals ? `Bridged back out of Osmosis by anyone, ${wWords}` : `Bridged back out of Osmosis, ${wWords}`, p: outStamp } : undefined,
    },
    {
      n: o ? <Num v={o.dex.buyNam24h - o.dex.sellNam24h} prov={o.dex.coverage} fmt={fmtNamSigned} unit="NAM" showAge={false} /> : <SkeletonBlock height={28} width={110} />,
      label: `net bought on Osmosis, 24${NBSP}h`,
      scope: o ? { label: 'Net bought on Osmosis, 24 hours (bots left out)', p: o.dex.coverage } : undefined,
    },
    {
      n: ulFact(sums?.ready.nam, readyStamp),
      label: (
        <>
          {/* the list below, with the Unstaking filter on and these requests first */}
          <a className="sp-factlink" href={`#${UNLOCKS_ID}`} onClick={() => setUlFilter('out')}>
            unstaked, wait over, not withdrawn
          </a>
          {sizeLine(minWords)}
        </>
      ),
      scope: readyStamp ? { label: `Unstaked NAM whose wait is over and that was not withdrawn, ${minWords}`, p: readyStamp } : undefined,
    },
    {
      n: allW ? ulFact(allW.nam, allStamp) : ulFact(sums?.waiting.nam, waitingStamp),
      label: (
        <>
          {data?.unbondingDays != null ? <>still unstaking, spendable within {data.unbondingDays.toFixed(2)}{NBSP}days</> : 'still unstaking'}
          {sizeLine(allW ? 'requests of any size' : minWords)}
        </>
      ),
      scope: allW
        ? allStamp ? { label: 'Unstaked NAM still in its wait, requests of any size', p: allStamp } : undefined
        : waitingStamp ? { label: `Unstaked NAM still in its wait, ${minWords}`, p: waitingStamp } : undefined,
    },
    {
      n: o ? (
        <Derived inputs={[{ value: o.supply.bonded, prov: o.supply.prov }, { value: o.supply.total, prov: o.supply.prov }]} label="staked ÷ all NAM" name="Staked share" compute={(b, t) => (b / t) * 100} fmt={(n) => fmtPctRule(n, 1)} showAge={false} />
      ) : (
        <SkeletonBlock height={28} width={80} />
      ),
      label: 'of all NAM is staked',
      scope: o ? { label: 'Share of all NAM that is staked', p: derive([o.supply.prov], 'staked ÷ all NAM') } : undefined,
    },
  ];
  const factsReady = !!data && !!o;

  return (
    <>
      <section className="band ground-accent ipg-band" aria-labelledby="supply-h1" data-decision="D2">
        <div className="wrap">
          <div className="ipg-band__grid">
            <div className="ipg-band__lead">
              <p className="eyebrow">Supply{asOf != null ? <> · {fmtDateline(asOf)}</> : null}</p>
              <h1 id="supply-h1" className="h1">{route?.h1}</h1>
              <p className="sub">{lead[0]}</p>
            </div>
            <div className="ipg-band__hero sp-hero">
              {err && !data ? (
                <Notice tone="warning" title="No figures right now." live>{err}</Notice>
              ) : (
                hero
              )}
              <Segmented label="Window" className="sp-hero__win" value={String(days) as `${WindowDays}`} options={WINDOWS} onChange={(v) => setDays(Number(v) as WindowDays)} />
            </div>
          </div>
          <div className={`ipg-facts sp-facts${factsReady ? '' : ' ipg-facts--wait'}`}>
            <Fact items={facts} sourceLabel="Where the band figures come from">
              {load.refreshFailedAt && data ? (
                <p className="scope__old facts__old">
                  <i className="dot" data-status="old" aria-hidden="true" />
                  <span>{refreshFailedSentence(load.fetchedAt, now)}</span>
                </p>
              ) : null}
            </Fact>
          </div>
        </div>
        <div className="ruler" aria-hidden="true" />
      </section>

      <div className="band ground-ink ipg-body" aria-busy={busy || undefined}>
        <div className={`wrap ipg-grid${busy && data ? ' is-busy' : ''}`}>
          {data ? (
            <>
              <ReadyToSell data={data} overview={o} isMine={isMine} />
              <Movers data={data} isMine={isMine} />
              <Unlocks data={data} overview={o} isMine={isMine} filter={ulFilter} setFilter={setUlFilter} states={states!} />
              <Votes data={data} />
            </>
          ) : err ? (
            <section className="ipg-sec ipg-col--full" aria-label="Supply figures">
              <Notice tone="warning" title="The supply lists did not load.">Every list on this page comes from the same request as the figure above, so none of them can be shown.</Notice>
            </section>
          ) : (
            <>
              <section className="ipg-sec ipg-col--7" aria-label="Ready to sell on Osmosis">
                <h2 className="h2">Ready to sell on Osmosis</h2>
                <SkeletonBlock height={52} />
                <Skeleton rows={4} heights={[88]} label="NAM ready to sell" />
              </section>
              <section className="ipg-sec ipg-col--5" aria-label="Who is moving the price">
                <h2 className="h2">Who is moving the price</h2>
                <SkeletonBlock height={52} />
                <Skeleton rows={6} heights={[72]} label="the addresses moving the price" />
              </section>
              <section className="ipg-sec ipg-col--full" aria-label="Unstaking and restaking">
                <h2 className="h2">Unstaking and restaking</h2>
                <SkeletonBlock height={52} />
                <Skeleton rows={6} heights={[104]} label="staking moves" />
              </section>
            </>
          )}
          <section className="ipg-sec ipg-col--full ipg-about" aria-labelledby="sp-about-h">
            <h2 id="sp-about-h" className="h2">What this page shows</h2>
            <p className="ipg-prose">{lead[1]}</p>
          </section>
        </div>
      </div>
    </>
  );
}
