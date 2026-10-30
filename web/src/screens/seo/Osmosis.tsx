// /osmosis: "NAM on Osmosis: pools, liquidity and what a trade costs" (seo-requirements "New pages").
// Band: the money in the NAM pools (hero, ProvChip), then pools, NAM on Osmosis, traded in 24 h
// and the price (fact strip, one SourceLine). Evidence: the deepest pools and the size table
// (both live only: not requested under Rewind, said in words), what traded in the last day,
// and NAM on Osmosis against what the bridge holds for it.
import type { ScreenProps } from '../../app/index';
import { REWIND_WORDS, useClock, useReplay } from '../../app/index';
import { BODY } from '../../../../shared/copy';
import type { PoolInfo, QuoteCurveResponse } from '../../../../shared/types';
import { DataList, HeroNumber, LadderRow, Num, PoolRestRow, PoolRow, ProvChip, Skeleton, SourceLine, derive, fmtPriceNode, type Stamp } from '../../ui';
import { Inside } from '../../ui/PairsList';
import { fetchPools, fetchQuoteCurve } from '../../api';
import { fmtAgo, fmtCoin, fmtCount, fmtNamRule, fmtPctRule, fmtPctSigned, fmtUsdRule, fmtUsdWhole } from '../../lib/format';
import { counterName, pairName, restOf, safeSize } from '../trade/model';
import { SafeFig, safeDerivedFrom } from '../trade/Safe';
import { Band, Dateline, Facts, Fig, FigList, GoLink, Hero, QSection, Related, Say, fromOne, missing, noAnswer, ratio, useLoad, useOv } from './parts';

const copy = BODY.osmosis;
const pct2 = (n: number) => fmtPctRule(n, 2);
/** Pools listed one by one; the rest are summed in one closing row. */
const TOP = 5;

export function Osmosis({ route }: ScreenProps) {
  const { rewound } = useReplay();
  const now = useClock();
  const { o, loading } = useOv();
  // Live-only (build-plan 6): neither is requested while rewound.
  const pools = useLoad<{ pools: PoolInfo[]; prov: Stamp }>('pools', () => fetchPools(), { enabled: !rewound, everyMs: 60_000 });
  const curve = useLoad<QuoteCurveResponse>('curve', () => fetchQuoteCurve(), { enabled: !rewound, everyMs: 60_000 });

  const dexP: Stamp | null = o ? o.dex.prov : null;
  const covP: Stamp | null = o ? o.dex.coverage : null;
  const priceP: Stamp | null = o ? o.price.usd.prov : null;
  const supplyP: Stamp | null = o ? o.supply.prov : null;
  // When the bridge cross-check needs a look, both counts carry the disagree state (system.md 2).
  const bridge = o?.checks.find((c) => c.key === 'ibc_conservation');
  const differ = !!bridge && bridge.status !== 'ok';
  const DIFFER = 'NAM held at the bridge on Namada and NAM counted on Osmosis differ; the cross-checks under How we know show both.';
  const osmoP: Stamp | null = o ? (differ ? { ...o.supply.osmosisProv, status: 'conflict', note: DIFFER } : o.supply.osmosisProv) : null;
  const escrowP: Stamp | null = supplyP ? (differ ? { ...supplyP, status: 'conflict', note: DIFFER } : supplyP) : null;
  const gap = o && o.supply.ibcEscrow != null && o.supply.osmosis != null ? Math.abs(o.supply.ibcEscrow - o.supply.osmosis) : null;
  // The gap is the measured difference itself, so it carries the inputs' own states, not the dispute.
  const gapP = o && supplyP ? derive([o.supply.osmosisProv, supplyP], 'NAM held at the bridge minus NAM counted on Osmosis') : null;
  const poolsN = o && o.dex.pools > 0 ? o.dex.pools : null;
  const volUsdP = covP && priceP ? derive([covP, priceP], 'NAM traded in the last day × price') : null;
  const volUsd = o && o.price.usd.value != null ? o.dex.volume24hNam * o.price.usd.value : null;
  const osmoShare = ratio(o?.supply.osmosis, o?.supply.total);
  const osmoShareP = o && supplyP ? derive([o.supply.osmosisProv, supplyP], 'NAM on Osmosis divided by all NAM') : null;

  // The deepest pools, from the stored list: each pool's coins at their own prices; one that cannot be priced has no
  // size, comes after the priced ones and counts in no total.
  const sizeOf = (p: PoolInfo) => (p.liquidityUsd != null && Number.isFinite(p.liquidityUsd) ? p.liquidityUsd : null);
  const list = [...(pools.data?.pools ?? [])].sort((a, b) => (sizeOf(b) ?? -1) - (sizeOf(a) ?? -1) || b.namReserve - a.namReserve);
  const total = list.reduce((a, p) => a + (sizeOf(p) ?? 0), 0);
  const deepest = sizeOf(list[0] ?? ({} as PoolInfo)) ?? 0;
  const rest = list.slice(TOP);
  const restSum = restOf(rest);
  const poolsP: Stamp | null = pools.loading ? null : pools.data ? pools.data.prov : noAnswer('Osmosis pools');
  const poolsOld = poolsP?.status === 'stale';

  // The size table: six order sizes quoted at the same moment.
  const curveP: Stamp | null = curve.loading ? null : curve.data ? { ...curve.data.prov, plain: 'Size table' } : noAnswer('Osmosis quote', 'Size table');
  const pts = curve.data?.curve ?? [];
  const notQuoted: Stamp = missing('Osmosis quote', 'not quoted', 'Size table');
  // The largest order under a one percent move, with how it was made (trade/model.ts safeSize): "about" only
  // between two listed sizes, "under" the smallest size when even it moves the price more, "at least" the largest.
  const safe1 = safeSize(curve.data, 1);
  const safeP: Stamp | null = curveP ? fromOne(curveP, safeDerivedFrom(safe1, 'one percent')) : null;
  const safeNote =
    safe1.how === 'below_smallest' && safe1.smallestImpactPct != null
      ? `buying or selling; the smallest size quoted already moves the price ${fmtPctRule(safe1.smallestImpactPct, 2)}`
      : safe1.how === 'at_least'
        ? 'buying or selling; even the largest size quoted moves the price less'
        : safe1.how === 'interpolated'
          ? 'buying or selling; a straight line between the two listed sizes around it, not a quote'
          : 'buying or selling';

  return (
    <article className="seo seo--osmosis">
      <Hero
        eyebrow={<Dateline label="Osmosis" />}
        h1={route?.h1 ?? ''}
        sub={copy.paras[0]}
        fig={
          <HeroNumber
            size="48"
            label="Money in the NAM pools"
            chip={loading ? <span className="skel__b skel__chip" aria-hidden="true" /> : <ProvChip p={dexP} label="Money in the NAM pools" />}
            value={<Fig loading={loading} h={48} w="5ch" v={o?.dex.liquidityUsd} prov={dexP} fmt={fmtUsdRule} />}
            sub="in dollars, what every order on Osmosis trades against."
          />
        }
      >
        <p className="seo-hero__more">{copy.paras[1]}</p>
        <Facts
          className="seo-facts"
          sourceLabel="NAM on Osmosis"
          items={[
            { n: <Fig loading={loading} v={poolsN} prov={dexP ? { ...dexP, status: poolsN == null ? 'missing' : dexP.status } : null} fmt={fmtCount} showAge={false} />, label: 'NAM pools', scope: dexP ? { label: 'NAM pools', p: dexP } : undefined },
            { n: <Fig loading={loading} v={o?.supply.osmosis} prov={osmoP} fmt={fmtNamRule} showAge={false} />, label: 'NAM held on Osmosis', scope: osmoP ? { label: 'NAM held on Osmosis', p: osmoP } : undefined },
            { n: <Fig loading={loading} v={o?.dex.volume24hNam} prov={covP} fmt={fmtNamRule} showAge={false} />, label: 'NAM traded in the last day', scope: covP ? { label: 'NAM traded in the last day', p: covP } : undefined },
            { n: <Fig loading={loading} v={o?.price.usd.value} prov={priceP} fmt={fmtPriceNode} showAge={false} />, label: 'Price of one NAM', scope: priceP ? { label: 'Price of one NAM', p: priceP } : undefined },
          ]}
        />
      </Hero>

      <Band label="NAM on Osmosis, question by question">
        <QSection id="q-depth" h2={copy.sections![0].h2} paras={copy.sections![0].paras}>
          {rewound ? (
            <Say>{REWIND_WORDS.quotes} The list of pools is read live only, so it is not shown for a past moment.</Say>
          ) : pools.loading ? (
            <>
              <Skeleton rows={TOP + 1} heights={[68]} label="pools" className="seo-skel-pools" />
              <p className="src seo-src-wait" aria-hidden="true" />
            </>
          ) : (
            <DataList
              kind="pools"
              label={`NAM pools on Osmosis, deepest first`}
              old={poolsOld}
              oldSentence={poolsP?.at ? `The pools were last read ${fmtAgo(poolsP.at, now)}, so they are shown dimmed.` : undefined}
              scope={poolsP ? [{ label: 'NAM pools', p: poolsP }] : undefined}
              scopeLabel="NAM pools on Osmosis"
            >
              {list.length ? (
                list.slice(0, TOP).map((p, i) => (
                  // the same row as Trade's "Where NAM trades", so a pool reads the same on both pages
                  <PoolRow
                    key={`${p.id}-${p.address}-${i}`}
                    pair={pairName(p)}
                    sub={<span className="mono">{p.id ? `#${p.id}` : 'no id'} · {p.type}</span>}
                    depth={sizeOf(p) != null ? <Num v={sizeOf(p)} fmt={fmtUsdWhole} showReason={false} /> : <Num v={null} prov={p.sizeProv ? { ...p.sizeProv, status: 'missing' } : null} />}
                    share={<Num v={total && sizeOf(p) != null ? (sizeOf(p)! / total) * 100 : null} fmt={(n) => fmtPctRule(n, 1)} unit="of all depth" showReason={false} />}
                    nam={<Inside nam={p.namReserve} counter={p.counterReserve} coin={counterName(p)} />}
                    fee={<Num v={Number.isFinite(p.spreadFactor) ? p.spreadFactor * 100 : null} fmt={(n) => fmtPctRule(n)} unit="fee" showReason={false} />}
                    bar={deepest && sizeOf(p) != null ? sizeOf(p)! / deepest : null}
                  />
                ))
              ) : (
                <PoolRestRow>
                  <Num v={null} prov={poolsP} />
                </PoolRestRow>
              )}
              {rest.length ? (
                <PoolRestRow end={<><Num v={restSum.usd} fmt={fmtUsdWhole} /> together, none above <Num v={restSum.max} fmt={fmtUsdWhole} />{restSum.notPriced ? <>; <Num v={restSum.notPriced} fmt={fmtCount} /> of them not priced, so not counted</> : null}</>}>
                  <Num as="b" v={rest.length} fmt={fmtCount} /> more {rest.length === 1 ? 'pool' : 'pools'}
                </PoolRestRow>
              ) : null}
            </DataList>
          )}
        </QSection>

        <QSection id="q-move" h2={copy.sections![1].h2} paras={copy.sections![1].paras}>
          {rewound ? (
            <Say>{REWIND_WORDS.quotes} The size table is read live only.</Say>
          ) : (
            <div className="seo-scope" data-prov-scope="">
              <FigList
                label="Largest order under a one percent move"
                loading={curve.loading}
                noSource
                rows={[
                  {
                    label: 'Largest order that moves the price under one percent',
                    note: safeNote,
                    value: curve.loading ? <Fig loading h={26} v={null} /> : safe1.how ? <SafeFig s={safe1} prov={safeP} as="span" className="seo-fig__q" /> : <Num v={null} prov={safeP} fmt={fmtNamRule} unit="NAM" />,
                    p: safeP,
                  },
                ]}
              />
              {curve.loading ? (
                <Skeleton rows={6} heights={[72]} label="the size table" className="seo-skel-ladder" />
              ) : (
                <DataList kind="ladder" label="Size table: what each order size gets and how far it moves the price">
                  {pts.length ? (
                    pts.map((p) => (
                      <LadderRow
                        key={p.amountNam}
                        size={<Num v={p.amountNam} fmt={fmtNamRule} unit="NAM" />}
                        pickLabel={`${fmtNamRule(p.amountNam)} NAM`}
                        value={<Num v={p.usdSize} fmt={fmtUsdRule} />}
                        sellGet={<Num v={p.sellOutUsdc} prov={p.sellOutUsdc == null ? notQuoted : undefined} fmt={fmtCoin} />}
                        sellMove={<Num v={p.sellImpactPct == null ? null : -p.sellImpactPct} prov={p.sellImpactPct == null ? notQuoted : undefined} showReason={false} fmt={(n) => fmtPctSigned(n)} />}
                        buyPay={<Num v={p.buyInUsdc} prov={p.buyInUsdc == null ? notQuoted : undefined} fmt={fmtCoin} />}
                        buyMove={<Num v={p.buyImpactPct} prov={p.buyImpactPct == null ? notQuoted : undefined} showReason={false} fmt={(n) => fmtPctSigned(n)} />}
                      />
                    ))
                  ) : (
                    <PoolRestRow>
                      <Num v={null} prov={curveP} />
                    </PoolRestRow>
                  )}
                </DataList>
              )}
              {curveP ? (
                <SourceLine
                  items={[
                    { label: 'Size table', p: curveP },
                    { label: 'Largest order under a one percent move', p: safeP },
                  ]}
                  label="The size table"
                />
              ) : (
                <p className="src seo-src-wait" aria-hidden="true" />
              )}
            </div>
          )}
          <GoLink to="/trade">Quotes for any amount, on Trade</GoLink>
        </QSection>

        <QSection id="q-volume" h2={copy.sections![2].h2} paras={copy.sections![2].paras}>
          <FigList
            label="What traded in the last day"
            loading={loading}
            rows={[
              {
                label: 'Bought',
                note: o ? <>in <Num v={o.dex.buys24h} fmt={fmtCount} /> trades</> : null,
                value: <Fig loading={loading} h={26} v={o?.dex.buyNam24h} prov={covP} fmt={fmtNamRule} unit="NAM" />,
                p: covP,
              },
              {
                label: 'Sold',
                note: o ? <>in <Num v={o.dex.sells24h} fmt={fmtCount} /> trades</> : null,
                value: <Fig loading={loading} h={26} v={o?.dex.sellNam24h} prov={covP} fmt={fmtNamRule} unit="NAM" />,
                p: covP,
              },
              {
                label: 'Value of all of it',
                note: 'at the price above',
                value: <Fig loading={loading} h={26} v={volUsd} prov={volUsdP} fmt={fmtUsdRule} />,
                p: volUsdP,
              },
            ]}
          />
          <GoLink to="/activity">Every trade, one by one</GoLink>
        </QSection>

        <QSection id="q-held" h2={copy.sections![3].h2} paras={copy.sections![3].paras}>
          <FigList
            label="NAM on Osmosis"
            loading={loading}
            rows={[
              { label: 'Share of all NAM', value: <Fig loading={loading} h={26} v={osmoShare != null ? osmoShare * 100 : null} prov={osmoShareP} fmt={pct2} />, p: osmoShareP },
              { label: 'Counted on Osmosis', value: <Fig loading={loading} h={26} v={o?.supply.osmosis} prov={osmoP} fmt={fmtNamRule} unit="NAM" />, p: osmoP },
              {
                label: 'Held for it at the Namada bridge',
                note: 'every NAM on Osmosis is matched by NAM held here',
                value: <Fig loading={loading} h={26} v={o?.supply.ibcEscrow} prov={escrowP} fmt={fmtNamRule} unit="NAM" />,
                p: escrowP,
              },
              { label: 'Gap between the two counts', value: <Fig loading={loading} h={26} v={gap} prov={gapP} fmt={fmtNamRule} unit="NAM" />, p: gapP },
            ]}
          />
          <GoLink to="/holders">Who holds NAM</GoLink>
        </QSection>

        <Related paths={['/guides/how-to-buy-nam', '/trade', '/activity', '/supply', '/learn/how-nam-trading-works']} />
      </Band>
    </article>
  );
}
