// Home (S1, route "/"). Reference: docs/design/final/home.html and shots/home-*.png; spec: system.md
// 9.1 (section order), 10 (copy deck), 7.1 (motion), build-plan 8 (Home acceptance).
//
// Order, phone and desktop: the yellow hero (H1, price, actions, fact strip, ruler edge) · What changed
// in the last 24 hours and Latest moves · Where is all the NAM? · Who holds NAM (beside a sticky
// "Right now" rail from 1024 px) · the yellow path of a NAM with the order-size explorer · the
// mini-ticket and Why you can trust these numbers. The footer is the shell's.
//
// Provenance is rationed (system.md 8): two ProvChips on the route (the price and the mini-ticket),
// ProvDots on single secondary figures (path steps, rail, the alert size in dollars, an exception
// row), and one SourceLine per panel. Under Rewind every request carries ?at= (the shell's wrapper),
// the quote and size table are not requested, and holder balances say they are current.
import { useEffect } from 'react';
import type { ScreenProps } from '../../app/index';
import { REWIND_WORDS, useOverlays, useOverview, useOverviewFailed, useReplay } from '../../app/index';
import { ROUTES } from '../../../../shared/routes';
import { unbondingStamp, type Stamp } from '../../lib/prov';
import { holderFiguresStamp } from '../activity/holderStamp';
import { useHomeData, useMinWidth } from './data';
import { Hero } from './Hero';
import { Changed } from './Changed';
import { Where } from './Where';
import { Holders } from './Holders';
import { Rail } from './Rail';
import { Path } from './Path';
import { Closing } from './Closing';

const HOME = ROUTES.find((r) => r.id === 'home')!;

export default function HomeScreen({ route }: ScreenProps) {
  const r = route ?? HOME;
  const { overview: o, liveFlows, streamedIds, error: ovError } = useOverview();
  // the overview never answered: "—" and the reason where a skeleton would wait (the shell's bar says why, with Try again)
  const failed = useOverviewFailed();
  const { at } = useReplay();
  const { openSources } = useOverlays();
  const rewound = at != null;
  const wide = useMinWidth(640);
  const d = useHomeData(at, wide);

  // html.static: when the whole page fits the window, the scroll-driven reveals have nothing to reveal.
  useEffect(() => {
    const de = document.documentElement;
    const check = () => de.classList.toggle('static', de.scrollHeight <= window.innerHeight + 2);
    check();
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('resize', check);
      de.classList.remove('static');
    };
  }, []);

  const checks = o?.checks ?? [];
  const bridgeCheck = checks.find((c) => c.key === 'ibc_conservation') ?? null;

  const supplyP: Stamp | null = o?.supply.prov ?? null;
  const osmoBase: Stamp | null = o?.supply.osmosisProv ?? null;
  // The bridge cross-check compares Namada's escrow with Osmosis's own count: when it needs a look,
  // the Osmosis figure carries the disagree state (wavy underline) and the sheet says why.
  const osmoP: Stamp | null =
    osmoBase && bridgeCheck && bridgeCheck.status !== 'ok' && osmoBase.status !== 'missing'
      ? { ...osmoBase, status: 'conflict', note: 'Namada’s bridge escrow (it holds NAM for every chain, not only Osmosis) and Osmosis’s own count differ; the bridge cross-check needs a look.' }
      : osmoBase;
  const priceP: Stamp | null = o?.price.usd.prov ?? null;
  const ov = o;
  const curveP: Stamp | null = d.curve.data ? { ...d.curve.data.prov, plain: 'Size table' } : d.curve.error ? { source: 'size table', plain: 'Size table', at: null, status: 'missing', note: d.curve.error } : null;
  const waitP = unbondingStamp(d.pressure.data);
  // The Namada holder count (hero fact, "Who holds NAM"): stamped with the age of the balances behind it, by the
  // same rule as /holders (activity/holderStamp.ts), so both pages give the same figure the same age.
  const holderRows = d.holders.data?.holders ?? null;
  const holdersP: Stamp | null = holderFiguresStamp(o, 'namada', holderRows, d.holders.data == null && d.holders.error != null, at, at != null ? REWIND_WORDS.balances(at) : null);

  // The fourth step quotes the smallest alert size when the size table lists it (so the two sections speak of one size).
  const sizes = d.curve.data?.curve.map((p) => p.amountNam) ?? [];
  const alertSizes = (d.rules.data?.rules ?? []).map((x) => x.thresholdNam).filter((n) => Number.isFinite(n) && n > 0);
  const minAlert = alertSizes.length ? Math.min(...alertSizes) : NaN;
  const stepSize = sizes.length ? (sizes.includes(minAlert) ? minAlert : [...sizes].filter((n) => !Number.isFinite(minAlert) || n <= minAlert).pop() ?? sizes[0]) : null;

  return (
    <div className="home">
      <Hero o={ov} h1={r.h1} at={at} spark={d.spark} onSources={openSources} supplyP={supplyP} osmoP={osmoBase} holdersP={holdersP} failed={failed} why={ovError} wide={wide} />

      <div className="band ground-ink narrative">
        <div className="wrap narrative__grid">
          <div className="narrative__main">
            <Changed o={ov} at={at} alerts={d.alerts} rules={d.rules} flows={d.flows} liveFlows={rewound ? [] : liveFlows} streamedIds={streamedIds} priceP={priceP} failed={failed} why={ovError} />
            <Where o={ov} supplyP={supplyP} osmoP={osmoP} osmoShareP={osmoBase} bridgeCheck={bridgeCheck} failed={failed} why={ovError} />
            <Holders o={ov} at={at} holders={d.holders} supplyP={supplyP} countP={holdersP} failed={failed} />
          </div>
          <Rail o={ov} osmoP={osmoP} pressure={d.pressure} waitP={waitP} checks={checks} rewound={rewound} failed={failed} why={ovError} />
        </div>
      </div>

      <Path o={ov} supplyP={supplyP} pressure={d.pressure} waitP={waitP} curve={d.curve} curveP={curveP} stepSize={stepSize} rewound={rewound} failed={failed} why={ovError} />

      <Closing o={ov} curve={d.curve} curveP={curveP} quote={d.quote} checks={checks} rewound={rewound} failed={failed} />
    </div>
  );
}

