// Activity (S5): /activity (Transactions) and /holders (Holders), one component for both
// (system.md 9.5; reference docs/design/final/holders.html and shots/holders-*.png).
//
// A yellow band with the route's H1, the route's plain paragraph (shared/copy.ts, the same text the
// server renders) and a four-figure strip with one SourceLine; then a black band with the page tabs,
// the filters (a sheet with a count badge below 1024 px, inline from 1024 px) and the list.
// Switching tabs keeps this component mounted, so each tab's filters survive the switch.
import { useEffect, useState } from 'react';
import { BODY } from '../../../../shared/copy';
import type { Holder, Overview } from '../../../../shared/types';
import type { ScreenProps } from '../../app/index';
import { REWIND_WORDS, useClock, useNow, useOverview, useOverviewFailed, useReplay, useVisible } from '../../app/index';
import { fetchHolders } from '../../api';
import { Fact, Num, SkeletonBlock, derive, sourcesText, type FactItem, type Stamp } from '../../ui';
import { NBSP, fmtAge, fmtCount, fmtNamRule, fmtNamSigned, fmtPctRule } from '../../lib/format';
import Holders, { H_DEFAULT, type HolderFilters } from './Holders';
import Transactions, { TX_DEFAULT, type TxFilters } from './Transactions';
import { holderFiguresStamp, serverHolderProv, type HolderChain } from './holderStamp';
import { useWide } from './parts';

export default function ActivityScreen({ view, route }: ScreenProps) {
  const tab: 'activity' | 'holders' = view === 'holders' ? 'holders' : 'activity';
  const { overview } = useOverview();
  const { at, rewound } = useReplay();
  const wide = useWide();
  const [txf, setTxf] = useState<TxFilters>(TX_DEFAULT);
  const [hf, setHf] = useState<HolderFilters>(H_DEFAULT);
  const body = BODY[tab];

  return (
    <>
      {/* the page's edges follow the header's (.wrap, 1200); only the transaction table runs wider (.act-txwide) */}
      <section className="band ground-accent act-hero" aria-labelledby="act-h1">
        <div className="wrap">
          <p className="eyebrow">Activity · {tab === 'holders' ? 'Holders' : 'Transactions'}</p>
          <h1 id="act-h1" className="h1">{route?.h1}</h1>
          {body?.paras[0] ? <p className="sub act-hero__sub">{body.paras[0]}</p> : null}
          {tab === 'holders' ? <HolderFacts overview={overview} rewoundAt={rewound ? at : null} /> : <MoveFacts overview={overview} />}
        </div>
        <div className="ruler act-hero__ruler" aria-hidden="true" />
      </section>

      <section className="band ground-ink act-band" aria-label={tab === 'holders' ? 'Holders' : 'Transactions'}>
        <div className="wrap">
          {tab === 'holders' ? <Holders filters={hf} setFilters={setHf} wide={wide} overview={overview} /> : <Transactions filters={txf} setFilters={setTxf} wide={wide} />}
          {body?.paras[1] ? <p className="act-about">{body.paras[1]}</p> : null}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- the four-figure strips
// The kit's Fact (.facts--4: 2 x 2 on phones, 4 columns from 640 px) with one SourceLine; under Rewind the
// holder strip's line says "current, not as of the rewound time".

const sk = <SkeletonBlock height={28} width="5ch" className="act-fact-sk" />;

/** While the overview is on its way: the strip at its final size (the kit holds the SourceLine's slot). */
const waiting = (labels: string[]): FactItem[] => labels.map((label) => ({ n: sk, label }));

const H24 = `24${NBSP}h`;
const MOVE_LABELS = [`NAM bought on Osmosis, ${H24}`, `NAM sold on Osmosis, ${H24}`, `Net NAM into Osmosis, ${H24}`, `Moves on Namada, ${H24}`];
/** A figure whose request failed: the shell's bar under the header says why and offers Try again, once. */
const NONE = <span data-num="" data-status="none">—</span>;

/** Transactions: what moved in the last 24 hours (bots left out of the Osmosis figures by the server). */
function MoveFacts({ overview: o }: { overview: Overview | null }) {
  const now = useClock();
  const failed = useOverviewFailed();
  if (!o) return <Fact items={failed ? MOVE_LABELS.map((label) => ({ n: NONE, label })) : waiting(MOVE_LABELS)} className="act-facts" />;
  const osm: Stamp = { ...o.dex.coverage, plain: 'Flow index' };
  const nam: Stamp = { ...o.namada.coverage, plain: 'Flow index' };
  const items: FactItem[] = [
    { n: <Num v={o.dex.buyNam24h} prov={osm} fmt={fmtNamRule} showAge={false} />, label: <>{MOVE_LABELS[0]}{o.dex.buys24h ? <> ({fmtCount(o.dex.buys24h)} trades)</> : null}</>, scope: { label: 'NAM bought on Osmosis in 24 hours', p: osm } },
    { n: <Num v={o.dex.sellNam24h} prov={osm} fmt={fmtNamRule} showAge={false} />, label: <>{MOVE_LABELS[1]}{o.dex.sells24h ? <> ({fmtCount(o.dex.sells24h)} trades)</> : null}</>, scope: { label: 'NAM sold on Osmosis in 24 hours', p: osm } },
    { n: <Num v={o.dex.netIbc24h} prov={osm} fmt={fmtNamSigned} showAge={false} />, label: MOVE_LABELS[2], scope: { label: `NAM bridged into Osmosis minus NAM bridged out, ${H24}`, p: osm } },
    { n: <Num v={o.namada.flows24h} prov={nam} fmt={fmtCount} showAge={false} />, label: MOVE_LABELS[3], scope: { label: 'Moves on Namada in 24 hours', p: nam } },
  ];
  // every figure in the strip is old: dim once and say why, once
  const old = [osm, nam].every((p) => p.status === 'stale');
  const oldest = Math.min(osm.at ?? Infinity, nam.at ?? Infinity);
  return (
    <Fact
      items={items}
      className="act-facts"
      sourceLabel="Where the 24-hour figures come from"
      old={old && Number.isFinite(oldest)}
      oldSentence={<>The flow index last checked the chain {fmtAge(now - oldest)} ago, so these totals may miss later moves and are shown dimmed.</>}
    >
      <p className="cap act-facts__note">A negative net figure means more NAM was bridged from Osmosis to Namada than the other way.</p>
    </Fact>
  );
}

// On Osmosis, pool accounts are not holders (the count and the top 10 leave them out), but the top-10 share is of
// all NAM on Osmosis, pools included.
const HOLDER_LABELS = ['holders on Namada', 'owned by the top 10', 'holders on Osmosis', 'of NAM on Osmosis owned by the top 10 wallets'];
const MIN = 60_000;

/**
 * The ten biggest holders on one chain, for the age of the holder figures when the server does not stamp
 * them (holderStamp.ts). Refreshed every 5 min while the tab is visible, and when it becomes visible again;
 * a failed refresh keeps the last rows (their reading times stay true).
 */
function useTopHolders(chain: HolderChain, enabled: boolean): { rows: Holder[] | null; failed: boolean } {
  const visible = useVisible();
  const [s, setS] = useState<{ rows: Holder[] | null; failed: boolean }>({ rows: null, failed: false });
  useEffect(() => {
    if (!enabled || !visible) return;
    let live = true;
    const run = () =>
      fetchHolders(chain, 1, 10, '', 'total').then(
        (r) => live && setS({ rows: r.holders, failed: false }),
        () => live && setS((x) => ({ rows: x.rows, failed: !x.rows })),
      );
    run();
    const t = setInterval(run, 5 * MIN);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [chain, enabled, visible]);
  return enabled ? s : { rows: null, failed: false };
}

/**
 * Holders: counts and the top-10 shares, each chain stamped with the age of the balances behind it
 * (holderStamp.ts, the same rule as Home), never with the time the overview was fetched. The list is
 * current: under Rewind the figures are not as of the rewound time, and say so.
 */
function HolderFacts({ overview: o, rewoundAt }: { overview: Overview | null; rewoundAt: number | null }) {
  const wall = useNow(); // balances are current: ages from the wall clock, also under Rewind
  // only once the overview says the server does not stamp the figures itself
  const nam = useTopHolders('namada', !!o && !serverHolderProv(o, 'namada'));
  const osm = useTopHolders('osmosis', !!o && !serverHolderProv(o, 'osmosis'));
  const failed = useOverviewFailed();
  if (!o) return <Fact items={failed ? HOLDER_LABELS.map((label) => ({ n: NONE, label })) : waiting(HOLDER_LABELS)} className="act-facts" />;
  const rwNote = rewoundAt ? REWIND_WORDS.balances(rewoundAt) : null;
  const namP = holderFiguresStamp(o, 'namada', nam.rows, nam.failed, rewoundAt, rwNote);
  const osmP = holderFiguresStamp(o, 'osmosis', osm.rows, osm.failed, rewoundAt, rwNote);
  // a share is derived from the chain's holder figures and a supply figure; the stamp names both
  const share = (base: Stamp, supply: Stamp, v: number | null, what: string): Stamp => {
    const d: Stamp = { ...derive([base, supply], what), plain: 'Holder index' };
    if (v != null) return d;
    return { ...d, status: 'missing', note: supply.at == null ? 'No supply figure was recorded then.' : 'The share could not be computed.' };
  };
  const top10 = namP ? share(namP, o.supply.prov, o.concentration.namadaTop10Pct, 'ten biggest balances ÷ all NAM') : null;
  const top10o = osmP ? share(osmP, o.supply.osmosisProv, o.concentration.osmosisTop10Pct, 'ten biggest Osmosis wallets (pools left out) ÷ all NAM on Osmosis, pools included') : null;
  const pct = (n: number) => fmtPctRule(n, 1);
  const items: FactItem[] = [
    { n: namP ? <Num v={o.namada.holders} prov={namP} fmt={fmtCount} showAge={false} /> : sk, label: HOLDER_LABELS[0], scope: namP ? { label: 'Holders on Namada', p: namP } : undefined },
    { n: top10 ? <Num v={o.concentration.namadaTop10Pct} prov={top10} fmt={pct} showAge={false} /> : sk, label: HOLDER_LABELS[1], scope: top10 ? { label: 'Share held by the top 10 on Namada', p: top10 } : undefined },
    { n: osmP ? <Num v={o.dex.holders} prov={osmP} fmt={fmtCount} showAge={false} /> : sk, label: HOLDER_LABELS[2], scope: osmP ? { label: 'Holders on Osmosis (pool accounts left out)', p: osmP } : undefined },
    { n: top10o ? <Num v={o.concentration.osmosisTop10Pct} prov={top10o} fmt={pct} showAge={false} /> : sk, label: HOLDER_LABELS[3], scope: top10o ? { label: 'Share of all NAM on Osmosis, pools included, held by the top 10 wallets', p: top10o } : undefined },
  ];
  const scope = items.map((i) => i.scope).filter((x): x is NonNullable<FactItem['scope']> => !!x);
  // Every address with any NAM counts, fee dust included; the server says how many hold under 1 NAM in all.
  const dust = o.namada.holdersUnder1Nam ?? null;
  // live: one chain's figures can be old while the other's are fresh; the old ones are dimmed and said once
  const oldChains = rewoundAt ? [] : ([['Namada', namP], ['Osmosis', osmP]] as const).filter(([, p]) => p?.status === 'stale');
  const oldLine = oldChains.length ? (
    <p className="scope__old facts__old">
      <i className="dot" data-status="old" aria-hidden="true" />
      <span>
        {oldChains.map(([word, p], i) => (
          <span key={word}>
            {i ? ' ' : ''}
            The {word} figures are counted from balances {p!.at != null ? <>last checked {fmtAge(wall - p!.at)} ago</> : 'whose last check is not known'}, so they are shown dimmed.
          </span>
        ))}
      </span>
    </p>
  ) : null;
  return (
    <Fact
      items={items}
      className="act-facts"
      sourceLabel="Where the four figures come from"
      old={!!rewoundAt}
      oldSentence={rwNote}
      sourceText={rewoundAt ? ` · ${sourcesText(scope)} · current, not as of the rewound time` : undefined}
    >
      {oldLine}
      {namP && o.namada.holders != null ? (
        <p className="cap act-facts__note">
          Every address with any NAM counts as a holder, however small the amount
          {dust != null ? <>: <Num v={dust} prov={namP} fmt={fmtCount} showAge={false} /> of the holders on Namada hold under one NAM in all</> : null}.
        </p>
      ) : null}
    </Fact>
  );
}
