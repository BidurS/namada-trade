// /__ui: the UI kit on one page, every component in every state (dev only; the shell routes it).
// Every figure is a real API field read through the dev proxy, or a derive() of fields; the
// states (old, no data, disagree) are the same stamps with their status changed, so nothing
// numeric is typed here (N2). Light theme: the toggle below, or the shell's theme setting.
import React, { useEffect, useMemo, useState } from 'react';
import type { Flow, Holder, Overview, PoolInfo, Provenance, QuoteCurveResponse, Sourced } from '../../../shared/types';
import { fetchFlows, fetchHolders, fetchMetricHistory, fetchOverview, fetchPools, fetchQuoteCurve } from '../api';
import { fmtAddr, fmtAgo, fmtCoin, fmtCount, fmtNamRule, fmtNamSigned, fmtPctRule, fmtPctSigned, fmtUsdRule, fmtUsdWhole, fmtAge } from '../lib/format';
import { CHECK_TITLES, checkUi, type Stamp } from '../lib/prov';
import { derive } from '../lib/derive';
import { KINDS, type TagKind, tagKindOf } from '../lib/kinds';
import { Num, SNum, Derived, fmtPriceNode } from './Num';
import { ProvChip } from './ProvChip';
import { ProvDot } from './ProvDot';
import { SourceLine, ProvScope } from './SourceLine';
import { Sheet } from './Sheet';
import { Tag } from './Tag';
import { Term } from './Term';
import { Button, ArrowLink, IconButton } from './Button';
import { Segmented } from './Segmented';
import { Tabs } from './Tabs';
import { SelectChip } from './SelectChip';
import { Field } from './Field';
import { Switch } from './Switch';
import { Notice } from './Notice';
import { EmptyState } from './EmptyState';
import { Skeleton, SkeletonBlock } from './Skeleton';
import { DataList, HolderRow, LadderRow, PoolRow, PoolRestRow, MoveRow } from './DataList';
import { SupplyBar } from './SupplyBar';
import { HeroNumber } from './HeroNumber';
import { Fact } from './Fact';
import { PriceChart, type ChartRange, type ChartEvent } from './PriceChart';
import { OrderSizeCurve } from './OrderSizeCurve';
import { Sparkline } from './Sparkline';
import { UiProvider, useUiNow } from './now';

type Load<T> = { data: T | null; err: string | null };
function useLoad<T>(f: () => Promise<T>): Load<T> {
  const [s, set] = useState<Load<T>>({ data: null, err: null });
  useEffect(() => {
    let live = true;
    f().then((data) => live && set({ data, err: null }), (e) => live && set({ data: null, err: String(e?.message ?? e) }));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return s;
}

/** The same stamp in another state (the demo's only "fixture": a status, never a number). */
const as = (p: Provenance, status: Provenance['status'], note?: string): Stamp => ({ ...p, status, note: note ?? p.note });
const withValue = (s: Sourced<number>, status: Provenance['status'], note?: string): Sourced<number> => ({ value: status === 'missing' ? null : s.value, prov: as(s.prov, status, note) });

const STATES: { status: Provenance['status']; word: string; note?: string }[] = [
  { status: 'live', word: 'Fresh' },
  { status: 'stale', word: 'Old' },
  { status: 'missing', word: 'No data', note: 'The quote service did not answer.' },
  { status: 'conflict', word: 'Sources disagree', note: 'Two sources give different values for this figure.' },
];

function Sec({ id, title, children, ground = 'ground-ink', note }: { id: string; title: string; children: React.ReactNode; ground?: string; note?: string }) {
  return (
    <section className={`demo-sec ${ground}`} aria-labelledby={id}>
      <div className="demo-wrap">
        <h2 id={id} className="demo-h2">{title}</h2>
        {note ? <p className="demo-note">{note}</p> : null}
        {children}
      </div>
    </section>
  );
}

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="demo-row">
    <p className="demo-k">{label}</p>
    <div className="demo-v">{children}</div>
  </div>
);

/** The three biggest hour-to-hour moves of the executed series (a derive of API rows, like the build export). */
function biggestMoves(pts: { t: number; v: number }[]): ChartEvent[] {
  const moves = pts.slice(1).map((p, i) => ({ t: p.t, pct: ((p.v - pts[i].v) / pts[i].v) * 100 }));
  return moves
    .filter((m) => Number.isFinite(m.pct))
    .sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    .slice(0, 3)
    .map((m) => ({ t: m.t, label: fmtPctSigned(m.pct, 1) }));
}

export default function Demo() {
  const now = useUiNow();
  const ov = useLoad<Overview>(() => fetchOverview(null));
  const curve = useLoad<QuoteCurveResponse>(() => fetchQuoteCurve());
  const holders = useLoad(() => fetchHolders('namada', 1, 10, '', 'total'));
  const pools = useLoad(() => fetchPools());
  const flows = useLoad(() => fetchFlows({ limit: 12 }));
  const exec = useLoad(() => fetchMetricHistory('price.swap_1h', 24 * 30));
  const quoted = useLoad(() => fetchMetricHistory('price.usd', 24 * 30));

  const [theme, setTheme] = useState<'dark' | 'light'>(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const [side, setSide] = useState<'sell' | 'buy'>('sell');
  const [range, setRange] = useState<ChartRange>('30d');
  const [size, setSize] = useState<number>(5000);
  const [cats, setCats] = useState<string>('all');
  const [multi, setMulti] = useState<string[]>(['namada']);
  const [amount, setAmount] = useState('5000');
  const [sw, setSw] = useState(true);
  const [tab, setTab] = useState('transactions');
  const [sheet, setSheet] = useState<null | 'md' | 'lg' | 'side'>(null);

  const o = ov.data;
  const price = o?.price.usd ?? null;
  const execPts = useMemo(() => (exec.data ?? []).map((r) => ({ t: r.ts, v: r.value })), [exec.data]);
  const quotePts = useMemo(() => (quoted.data ?? []).map((r) => ({ t: r.ts, v: r.value })), [quoted.data]);
  const events = useMemo(() => biggestMoves(execPts), [execPts]);
  const curvePts = curve.data?.curve ?? [];
  const curveProv = curve.data ? { ...curve.data.prov, plain: 'Size table' } : null;
  const sizes = curvePts.map((p) => p.amountNam);
  const outOfRange = sizes.length ? sizes[sizes.length - 1] * 2 : null;

  return (
    <div className="demo">
      <style>{DEMO_CSS}</style>
      <div className="demo-sec ground-accent">
        <div className="demo-wrap">
          <p className="eyebrow demo-eyebrow">Development only</p>
          <h1 className="demo-h1">UI kit</h1>
          <p className="demo-note">Every primitive in every state, bound to live API fields through the dev proxy. States are the same stamps with their status changed.</p>
          <Segmented className="demo-theme" label="Theme" value={theme} onChange={setTheme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        </div>
      </div>

      {/* ------------------------------------------------------------ provenance */}
      <Sec id="d-prov" title="Provenance: Num, ProvChip, ProvDot, SourceLine" note="Four states per figure: fresh, old (dim, dotted, age), no data (a dash and the reason in view), sources disagree (wavy).">
        {price ? (
          <>
            {STATES.map((s) => {
              // the old row uses the executed-swap price (old as served); the others change the quote's status
              const base = s.status === 'stale' && o ? o.price.swap1h : price;
              const v = withValue(base, s.status, s.note);
              return (
                <Row key={s.status} label={s.word}>
                  <span className="demo-big"><SNum s={v} fmt={fmtPriceNode} /></span>
                  <ProvChip p={v.prov} label="NAM price" />
                  <ProvDot p={v.prov} label="NAM price" />
                </Row>
              );
            })}
            <Row label="Age shown when fresh">
              <SNum s={price} fmt={fmtUsdRule} showAge />
            </Row>
            <Row label="With a unit">
              {o ? <Num v={o.supply.osmosis} prov={o.supply.osmosisProv} fmt={fmtNamRule} unit="NAM" /> : null}
            </Row>
            <Row label="Derived (price x alert size)">
              {o?.dex ? (
                <Derived
                  inputs={[{ value: price.value, prov: price.prov }, { value: o.namada.holders, prov: o.namada.coverage }]}
                  label="price x holders"
                  name="Demo derived figure"
                  compute={(p, n) => p * n}
                  fmt={fmtUsdRule}
                  stamp="dot"
                />
              ) : null}
            </Row>
            <Row label="Derived with a missing input">
              <Derived inputs={[{ value: price.value, prov: price.prov }, { value: null, prov: as(price.prov, 'missing', 'The second input did not answer.') }]} label="price x size" compute={(a, b) => a * b} fmt={fmtUsdRule} stamp="dot" />
            </Row>
            <Row label="Rewound (ages from the rewound time)">
              {o ? (
                <UiProvider value={{ now: price.prov.at }}>
                  <Num v={o.dex.buyNam24h} prov={o.dex.coverage} fmt={fmtNamRule} unit="NAM" stamp="dot" label="Bought on Osmosis, 24 hours" />
                </UiProvider>
              ) : null}
            </Row>
            <Row label="SourceLine (fresh)">
              {o ? <SourceLine items={[{ label: 'Holders on Namada', p: o.namada.coverage.status === 'live' ? o.namada.coverage : as(o.namada.coverage, 'live') }, { label: 'Share of NAM that is shielded', p: o.supply.prov }, { label: 'Share of NAM on Osmosis', p: o.supply.osmosisProv }]} label="Where the three figures come from" /> : null}
            </Row>
            <Row label="SourceLine (as served)">
              {o ? <SourceLine items={[{ label: 'Moves on Osmosis', p: o.dex.coverage }, { label: 'Moves on Namada', p: o.namada.coverage }]} label="Where the moves come from" /> : null}
            </Row>
            <Row label="SourceLine (disagree)">
              {o ? <SourceLine items={[{ label: 'Staked, public funding, shielded, all NAM', p: o.supply.prov }, { label: 'NAM on Osmosis', p: as(o.supply.osmosisProv, 'conflict', 'Namada escrow and the Osmosis count differ.') }]} label="Where the supply split comes from" /> : null}
            </Row>
            <Row label="SourceLine (custom text)">
              {o?.checks.length ? <SourceLine lead="Cross-checks" items={[{ label: 'The cross-checks', p: { source: 'cross-check', at: Math.max(...o.checks.map((c) => c.checkedAt)), status: 'live' } }]} text={(n) => ` ran ${fmtAge(n - Math.max(...o.checks.map((c) => c.checkedAt)))} ago · fresh`} label="When the checks ran" /> : null}
            </Row>
            <Row label="An old list (dimmed once)">
              {o ? (
                <ProvScope old oldSentence={<>The flow index was last updated {fmtAgo(o.dex.coverage.at, now)}, so these figures are shown dimmed.</>}>
                  <p>
                    <Num v={o.dex.buyNam24h} fmt={fmtNamRule} unit="NAM" prov={o.dex.coverage} /> bought and <Num v={o.dex.sellNam24h} fmt={fmtNamRule} unit="NAM" prov={o.dex.coverage} /> sold in 24 hours.
                  </p>
                  <SourceLine items={[{ label: 'Bought and sold, 24 hours', p: o.dex.coverage }]} />
                </ProvScope>
              ) : null}
            </Row>
            <Row label="Checks (plain titles)">
              <ul className="demo-checks">
                {(o?.checks ?? []).map((c) => (
                  <li key={c.key} className="demo-chk">
                    <i className="dot" data-status={checkUi(c.status).status} />
                    <span>{CHECK_TITLES[c.key] ?? c.key}</span>
                    <span className="mono">{checkUi(c.status).word}</span>
                  </li>
                ))}
              </ul>
            </Row>
          </>
        ) : (
          <Skeleton rows={4} heights={[44]} label="the price" chip />
        )}
      </Sec>

      <Sec id="d-yellow" title="On the yellow ground" ground="ground-accent">
        {price ? (
          <>
            <HeroNumber
              label="One NAM costs"
              chip={<ProvChip p={price.prov} label="NAM price" />}
              value={<SNum s={price} fmt={fmtPriceNode} />}
              delta={{ v: o?.price.change24h }}
            />
            <div className="demo-flex">
              {STATES.map((s) => (
                <ProvChip key={s.status} p={as(price.prov, s.status, s.note)} label="NAM price" />
              ))}
            </div>
            <div className="demo-flex">
              <SNum s={withValue(price, 'conflict')} fmt={fmtUsdRule} />
              <SNum s={withValue(price, 'missing', 'The quote service did not answer.')} fmt={fmtUsdRule} />
              <SNum s={withValue(price, 'stale')} fmt={fmtUsdRule} />
            </div>
            <div className="demo-flex">
              <Button variant="primary" href="/trade" arrow>See what a trade costs</Button>
              <Button variant="secondary">How we know</Button>
            </div>
            <Notice tone="warning" title="The Osmosis quote service is not answering.">
              Last quoted price: <SNum s={price} fmt={fmtUsdRule} />, {fmtAgo(price.prov.at, now)}. These figures come from the size table, measured at the same moment.
            </Notice>
            {o ? <Fact items={[
              { n: <Num v={o.namada.holders} fmt={fmtCount} />, label: 'holders on Namada', scope: { label: 'Holders on Namada', p: o.namada.coverage } },
              { n: <Derived inputs={[{ value: o.supply.shielded, prov: o.supply.prov }, { value: o.supply.total, prov: o.supply.prov }]} label="shielded / total" compute={(a, b) => (a / b) * 100} fmt={(n) => fmtPctRule(n, 1)} />, label: 'shielded', scope: { label: 'Share of NAM that is shielded', p: o.supply.prov } },
              { n: <Derived inputs={[{ value: o.supply.osmosis, prov: o.supply.osmosisProv }, { value: o.supply.total, prov: o.supply.prov }]} label="on Osmosis / total" compute={(a, b) => (a / b) * 100} fmt={(n) => fmtPctRule(n, 1)} />, label: 'on Osmosis', scope: { label: 'Share of NAM on Osmosis', p: o.supply.osmosisProv } },
            ]} sourceLabel="Where the three figures come from" /> : null}
          </>
        ) : (
          <SkeletonBlock height={160} />
        )}
      </Sec>

      {/* ------------------------------------------------------------ tags */}
      <Sec id="d-tags" title="Tags and glossary terms" note="Flow tags carry their expert term on tap. Category tags show only when they add information.">
        <div className="demo-flex">
          {(Object.keys(KINDS) as TagKind[]).map((k) => (
            <Tag key={k} kind={k} />
          ))}
        </div>
        <div className="demo-flex">
          <Tag cat="Genesis" />
          <Tag cat="Foundation" ring />
          <Tag cat="Estimate" term="estimate" />
          <Tag cat="Sets the price" look="ref" />
          <Tag cat="You" look="you" />
          <Tag kind="buy" plain />
        </div>
        <p className="demo-p">
          The <Term id="size-table" /> holds six quotes; between two of them the page draws an <Term id="estimate">estimate</Term>. A <Term id="thin-market" /> moves with your own order, and <Term id="rewind" /> shows every number as it was.
        </p>
      </Sec>

      {/* ------------------------------------------------------------ controls */}
      <Sec id="d-controls" title="Controls">
        <Row label="Buttons">
          <div className="demo-flex">
            <Button variant="primary" arrow>Primary</Button>
            <Button variant="secondary" icon="filter">Secondary</Button>
            <Button variant="destructive">Delete everything</Button>
            <Button variant="secondary" disabled>Disabled</Button>
            <Button variant="secondary" busy>Sending a test</Button>
            <Button variant="secondary" href="/trade">A link</Button>
            <IconButton icon="close" label="Close" />
          </div>
        </Row>
        <Row label="Link">
          <ArrowLink href="/activity">All activity</ArrowLink>
        </Row>
        <Row label="Segmented">
          <Segmented label="Side" block value={side} onChange={setSide} options={[{ value: 'sell', label: 'Sell NAM for USDC' }, { value: 'buy', label: 'Buy NAM with USDC' }]} />
        </Row>
        <Row label="Segmented, range">
          <Segmented label="Chart range" variant="range" value={range} onChange={setRange} options={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }]} />
        </Row>
        <Row label="Page tabs">
          <Tabs label="Activity views" items={[{ label: 'Transactions', href: '#transactions', current: tab === 'transactions' }, { label: 'Holders', href: '#holders', current: tab === 'holders' }]}>
            <Button variant="secondary" size="sm" icon="filter" onClick={() => setTab(tab === 'holders' ? 'transactions' : 'holders')}>
              Filter<span className="badge">{multi.length}</span>
            </Button>
          </Tabs>
        </Row>
        <Row label="Selectable chips">
          <SelectChip label="What" value={cats} onChange={setCats} options={[{ value: 'all', label: 'All', count: holders.data?.holders.length ?? null }, { value: 'foundation', label: 'Foundation', count: holders.data?.holders.filter((h) => h.category === 'foundation').length ?? null }, { value: 'genesis', label: 'Genesis', count: holders.data?.holders.filter((h) => h.category === 'genesis').length ?? null }, { value: 'none', label: 'No label', count: holders.data?.holders.filter((h) => !h.label).length ?? null }]} />
          <SelectChip label="Chain" multiple value={multi} onChange={setMulti} options={[{ value: 'namada', label: 'Namada' }, { value: 'osmosis', label: 'Osmosis' }, { value: 'none', label: 'Disabled', disabled: true }]} />
        </Row>
        <Row label="Presets">
          <SelectChip layout="presets" label="Amount presets" value={String(size)} onChange={(v) => setSize(Number(v))} options={sizes.map((n) => ({ value: String(n), label: fmtNamRule(n) }))} />
        </Row>
        <Row label="Field">
          <div className="demo-grid2">
            <Field label="Amount" unit="NAM" value={amount} onChange={setAmount} hint={price?.value != null && Number.isFinite(Number(amount)) ? <>Worth about <Derived inputs={[{ value: Number(amount), prov: price.prov }, { value: price.value, prov: price.prov }]} label="amount x price" compute={(a, p) => a * p} fmt={fmtUsdRule} /></> : null} />
            <Field
              label="Amount"
              unit="NAM"
              state={<><i className="dot" data-status="old" />live quote not answering</>}
              value={String(size)}
              readOnly
              note="Listed sizes only: other sizes cannot be quoted until the quote service answers."
            />
            <Field label="Amount" unit="NAM" value="abc" error={<Notice tone="danger" title="That is not an amount.">Amounts are numbers of NAM, such as the listed sizes.</Notice>} />
            <Field label="Discord address" numeric={false} value="" placeholder="Paste the address" disabled />
          </div>
        </Row>
        <Row label="Switch">
          <div>
            <Switch checked={sw} onChange={setSw} label="NAM left the shielded set" description="A large amount moved out of the shielded set to a personal address." />
            <Switch checked={!sw} onChange={(v) => setSw(!v)} label="Large trade" description="A single trade on Osmosis above the alert size." />
            <Switch checked={false} onChange={() => undefined} label="NAM bridged to Osmosis" description="NAM crossed to Osmosis above the alert size." locked="Sign in to choose" />
          </div>
        </Row>
        <Row label="Sheets">
          <div className="demo-flex">
            <Button variant="secondary" onClick={() => setSheet('md')} aria-haspopup="dialog">Open a sheet</Button>
            <Button variant="secondary" onClick={() => setSheet('lg')} aria-haspopup="dialog">Open a large sheet</Button>
            <Button variant="secondary" onClick={() => setSheet('side')} aria-haspopup="dialog">Open the side panel</Button>
          </div>
          <Sheet open={sheet != null} onClose={() => setSheet(null)} size={sheet ?? 'md'} title={sheet === 'side' ? 'An address' : 'Filter holders'} lead="A sheet: Escape, the close button or a tap on the scrim closes it, and focus returns to the button." foot={<Button variant="primary" onClick={() => setSheet(null)}>Show holders</Button>}>
            <div className="sheet__body">
              <SelectChip label="What" value={cats} onChange={setCats} options={[{ value: 'all', label: 'All' }, { value: 'foundation', label: 'Foundation' }, { value: 'genesis', label: 'Genesis' }]} />
              {Array.from({ length: sheet === 'side' ? 14 : 3 }, (_, i) => (
                <p key={i} className="demo-p">Row {i + 1} of the sheet body. Long content scrolls inside the sheet, never the page.</p>
              ))}
            </div>
          </Sheet>
        </Row>
      </Sec>

      {/* ------------------------------------------------------------ feedback */}
      <Sec id="d-feedback" title="Notices, empty state, skeleton">
        <div className="demo-stack">
          <Notice tone="info" title="Balances are current, not as of the rewound time.">Holder balances were not recorded over time.</Notice>
          <Notice tone="success" title="The test message was sent.">Discord answered just now.</Notice>
          {o ? (
            <Notice tone="warning" title={<>Two sources, <Derived inputs={[{ value: o.supply.ibcEscrow, prov: o.supply.prov }, { value: o.supply.osmosis, prov: o.supply.osmosisProv }]} label="escrow minus Osmosis count" compute={(a, b) => Math.abs(a - b)} fmt={fmtNamRule} /> NAM apart.</>}>
              Namada holds <Num v={o.supply.ibcEscrow} fmt={fmtNamRule} prov={o.supply.prov} /> NAM in escrow for Osmosis. Osmosis counts <Num v={o.supply.osmosis} fmt={fmtNamRule} prov={o.supply.osmosisProv} />.
            </Notice>
          ) : null}
          <Notice tone="danger" title="The address could not be read.">The node did not answer.</Notice>
          {price && o ? (
            <EmptyState
              title="Nothing crossed an alert size in 24 hours."
              last={<>The last one: <Tag kind="staked" /> <span><Num v={o.namada.bonded24h} fmt={fmtNamRule} /> NAM, {fmtAgo(o.namada.coverage.at, now)}.</span></>}
              rewindHref={o.namada.coverage.at ? `/supply?at=${o.namada.coverage.at}` : undefined}
            >
              Alert sizes are small on purpose: at today’s price <Num v={sizes[2] ?? null} fmt={fmtNamRule} /> NAM is <Derived inputs={[{ value: sizes[2] ?? null, prov: price.prov }, { value: price.value, prov: price.prov }]} label="price x alert size" compute={(a, p) => a * p} fmt={fmtUsdRule} stamp="dot" name="Alert size in dollars" />
            </EmptyState>
          ) : null}
          <Skeleton rows={6} heights={[64]} label="holders" />
        </div>
      </Sec>

      {/* ------------------------------------------------------------ data */}
      <Sec id="d-data" title="Data: supply bar, fact strip, lists">
        {o ? (
          <SupplyBar
            segments={[
              { key: 'staked', name: 'Staked', short: 'Staked', nam: o.supply.bonded, namNode: <Num v={o.supply.bonded} fmt={fmtNamRule} unit="NAM" />, note: 'locked with validators, cannot be sold' },
              { key: 'unstaking', name: 'Leaving staking', short: 'Leaving', nam: o.supply.unstaking ?? 0, namNode: <Num v={o.supply.unstaking ?? null} fmt={fmtNamRule} unit="NAM" />, note: 'unstaking, ready to withdraw or unclaimed rewards' },
              { key: 'pgf', name: 'Public funding', nam: o.supply.pgf, namNode: <Num v={o.supply.pgf} fmt={fmtNamRule} unit="NAM" />, note: 'held for public goods' },
              { key: 'shielded', name: 'Shielded', nam: o.supply.shielded, namNode: <Num v={o.supply.shielded} fmt={fmtNamRule} unit="NAM" />, note: 'total public, owners not' },
              { key: 'rest', name: 'Everything else spendable', short: 'Spendable', nam: o.supply.transparentLiquid, note: 'in wallets on Namada' },
              { key: 'osmosis', name: 'On Osmosis', nam: o.supply.osmosis, namNode: <Num v={o.supply.osmosis} fmt={fmtNamRule} unit="NAM" prov={as(o.supply.osmosisProv, 'conflict')} />, note: 'the one place it can be sold' },
            ]}
          />
        ) : (
          <SkeletonBlock height={120} />
        )}

        {o ? (
          <Fact items={[
            { n: <Num v={o.namada.holders} fmt={fmtCount} />, label: 'holders on Namada', scope: { label: 'Holders on Namada', p: o.namada.coverage } },
            { n: <Num v={o.dex.holders} fmt={fmtCount} />, label: 'holders on Osmosis', scope: { label: 'Holders on Osmosis', p: o.dex.prov } },
            { n: <Num v={o.concentration.namadaTop10Pct} fmt={(n) => fmtPctRule(n, 1)} />, label: 'owned by the top 10', scope: { label: 'Top 10 share, Namada', p: o.supply.prov } },
            { n: <Num v={o.concentration.osmosisTop10Pct} fmt={(n) => fmtPctRule(n, 1)} />, label: 'owned by the top 10 there', scope: { label: 'Top 10 share, Osmosis', p: o.dex.prov } },
          ]} />
        ) : null}

        <h3 className="demo-h3">Holders (compact, as on Home)</h3>
        {holders.data ? <HoldersDemo rows={holders.data.holders} total={o?.supply.total ?? null} full={false} /> : <Skeleton rows={6} heights={[64]} label="holders" />}
        <h3 className="demo-h3">Holders (full, as on Activity)</h3>
        {holders.data ? <HoldersDemo rows={holders.data.holders} total={o?.supply.total ?? null} full /> : <Skeleton rows={6} heights={[64]} label="holders" />}

        <h3 className="demo-h3">Pools</h3>
        {pools.data ? <PoolsDemo pools={pools.data.pools} prov={pools.data.prov} /> : <Skeleton rows={6} heights={[68]} label="pools" />}

        <h3 className="demo-h3">Latest moves</h3>
        {flows.data && o ? (
          <DataList kind="moves" label="Latest moves" old={o.dex.coverage.status === 'stale'} oldSentence={<>The flow index was last updated {fmtAgo(o.dex.coverage.at, now)}, so the rows are shown dimmed.</>} scope={[{ label: 'Moves on Osmosis', p: o.dex.coverage }, { label: 'Moves on Namada', p: o.namada.coverage }]} scopeLabel="Where the moves come from">
            {flows.data.flows.slice(0, 6).map((f, i) => (
              <MoveRow key={f.id} no={i + 1} fresh={i === 0} tag={<Tag kind={tagKindOf(f.kind, f.chain)} />} amount={<Num v={signedAmount(f)} fmt={fmtNamSigned} unit="NAM" />} caption={<>{fmtAgo(f.ts, now)} · <span className="mono">{fmtAddr(f.from ?? f.to)}</span>{f.valueUsd != null ? <> · <Num v={f.valueUsd} fmt={fmtUsdRule} /></> : null}</>} />
            ))}
          </DataList>
        ) : (
          <Skeleton rows={6} heights={[64]} label="moves" />
        )}
      </Sec>

      {/* ------------------------------------------------------------ charts */}
      <Sec id="d-charts" title="Charts: price, order size, sparkline">
        {exec.data ? (
          <PriceChart
            headingId="d-chart-h"
            level={3}
            series={{ executed: execPts, quoted: quotePts }}
            events={events}
            range={range}
            onRange={setRange}
            end={now}
            prov={{ executed: o?.price.swap1h.prov ?? null, quoted: o?.price.usd.prov ?? null }}
          />
        ) : (
          <SkeletonBlock height={288} />
        )}
        <h3 className="demo-h3">Order-size curve (explore)</h3>
        {curvePts.length ? <OrderSizeCurve points={curvePts} prov={curveProv} /> : <SkeletonBlock height={248} />}

        <div className="ground-accent demo-inset">
          <h3 className="demo-h3">Order-size curve (ticket, shared state with the ladder; {side === 'sell' ? 'selling' : 'buying'})</h3>
          {curvePts.length ? (
            <>
              <OrderSizeCurve points={curvePts} prov={curveProv} value={size} onChange={setSize} side={side} mode="ticket" />
              <DataList kind="ladder" label="Price move by order size">
                {curvePts.map((p) => (
                  <LadderRow
                    key={p.amountNam}
                    size={<Num v={p.amountNam} fmt={fmtNamRule} unit="NAM" />}
                    pickLabel={`Quote ${fmtNamRule(p.amountNam)} NAM`}
                    value={<Num v={p.usdSize} fmt={fmtUsdRule} />}
                    sellGet={<Num v={p.sellOutUsdc} fmt={(n) => fmtCoin(n)} />}
                    sellMove={<Num v={p.sellImpactPct == null ? null : -Math.abs(p.sellImpactPct)} fmt={(n) => fmtPctSigned(n)} />}
                    buyPay={<Num v={p.buyInUsdc} fmt={(n) => fmtCoin(n)} />}
                    buyMove={<Num v={p.buyImpactPct == null ? null : Math.abs(p.buyImpactPct)} fmt={(n) => fmtPctSigned(n)} />}
                    selected={p.amountNam === size}
                    onPick={() => setSize(p.amountNam)}
                  />
                ))}
              </DataList>
            </>
          ) : null}
        </div>
        <h3 className="demo-h3">Outside the quoted sizes</h3>
        {curvePts.length && outOfRange ? <OrderSizeCurve points={curvePts} value={outOfRange} /> : null}
        <h3 className="demo-h3">Sparkline</h3>
        {execPts.length ? (
          <Sparkline points={execPts} label={`Executed price, ${fmtUsdRule(execPts[0].v)} to ${fmtUsdRule(execPts[execPts.length - 1].v)}`}>
            <Derived inputs={[{ value: execPts[0].v, prov: o?.price.swap1h.prov ?? { source: 'executed NAM/USDC swaps (hourly median)', at: null, status: 'missing' } }, { value: execPts[execPts.length - 1].v, prov: o?.price.swap1h.prov ?? { source: 'executed NAM/USDC swaps (hourly median)', at: null, status: 'missing' } }]} label="change over the window" compute={(a, b) => ((b - a) / a) * 100} fmt={(n) => fmtPctSigned(n, 0)} /> over 30 days, executed price <ProvDot p={o?.price.swap1h.prov} label="Executed price" />
          </Sparkline>
        ) : null}
        <h3 className="demo-h3">A chart with two points (dots, no trend)</h3>
        {execPts.length >= 2 ? <PriceChart headingId="d-chart2" level={3} series={{ executed: execPts.slice(-2) }} range="24h" end={execPts[execPts.length - 1].t} /> : null}
      </Sec>
      {ov.err || curve.err ? <p className="demo-note">API: {ov.err ?? curve.err}</p> : null}
    </div>
  );
}

function signedAmount(f: Flow): number {
  const k = tagKindOf(f.kind, f.chain);
  const s = k === 'sell' || k === 'toNamada' || k === 'poolRemove' || k === 'shieldOut' || k === 'unstaking' ? -1 : 1;
  return s * f.amount;
}

function HoldersDemo({ rows, total, full }: { rows: Holder[]; total: number | null; full: boolean }) {
  const now = useUiNow();
  const top = Math.max(...rows.map((r) => r.total));
  const oldest = Math.min(...rows.map((r) => r.verifiedAt ?? r.updatedAt ?? now));
  // the row status the server sends (owner decision 7; lib/compat.ts fills it for an older server)
  const isOld = rows.length > 0 && rows.every((r) => r.status === 'stale');
  const stamp: Stamp = { source: 'indexer.namada.net', at: oldest, status: isOld ? 'stale' : 'live' };
  const anyChange = rows.some((r) => r.change7d !== 0);
  return (
    <DataList
      kind="holders"
      full={full}
      change={full && anyChange}
      label="Ten biggest NAM holders"
      old={isOld}
      oldSentence={<>Balances were last checked {fmtAge(now - oldest)} ago, so they are shown dimmed.</>}
      scope={[{ label: 'Balances', p: stamp }]}
      scopeLabel="Where the holder figures come from"
    >
      {rows.map((h) => {
        const differ = h.bonded != null && h.bondedEstimated != null && Math.abs(h.bonded - h.bondedEstimated) > 1;
        const dis: Stamp | null = differ ? derive([{ source: 'indexer.namada.net', at: h.bondedVerifiedAt, status: 'conflict', note: 'The chain reading is shown; the other is the flow estimate.' }], 'two readings of staked NAM') : null;
        return (
          <HolderRow
            key={h.address}
            rank={h.rank}
            name={h.label_plain ?? h.label ?? fmtAddr(h.address)}
            sub={<>{h.label ? fmtAddr(h.address) : 'no label'}{h.linked?.length ? ` · +${h.linked.length} linked on Osmosis` : ''}</>}
            tags={h.category === 'foundation' && !/foundation/i.test(h.label ?? '') ? <Tag cat="Foundation" ring /> : null}
            total={<Num v={h.total} fmt={fmtNamRule} unit="NAM" />}
            share={<Derived inputs={[{ value: h.total, prov: stamp }, { value: total, prov: stamp }]} label="balance / all NAM" compute={(a, b) => (a / b) * 100} fmt={(n) => fmtPctRule(n)} unit="of supply" />}
            spendable={<Num v={h.balance} fmt={fmtNamRule} />}
            staked={<Num v={h.bonded} fmt={fmtNamRule} status={differ ? 'disagree' : undefined} />}
            stakedNote={dis && h.bondedEstimated != null ? <ProvDot p={dis} label="Staked NAM, two readings" text={`estimate ${fmtNamRule(h.bondedEstimated)}`} /> : null}
            change7d={full && anyChange ? <Num v={h.change7d} fmt={fmtNamSigned} /> : undefined}
            exception={dis && h.bonded != null && h.bondedEstimated != null ? <ProvDot p={dis} label="Staked NAM, two readings" text={`staked figures differ by ${fmtNamRule(Math.abs(h.bonded - h.bondedEstimated))} NAM`} wrap /> : null}
            bar={top > 0 ? h.total / top : null}
          />
        );
      })}
    </DataList>
  );
}

function PoolsDemo({ pools, prov }: { pools: PoolInfo[]; prov: Provenance }) {
  const sorted = [...pools].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const total = sorted.reduce((a, p) => a + (p.liquidityUsd || 0), 0);
  const shown = sorted.slice(0, 5);
  const rest = sorted.slice(5);
  const restUsd = rest.reduce((a, p) => a + (p.liquidityUsd || 0), 0);
  const top = shown[0]?.liquidityUsd || 0;
  return (
    <DataList kind="pools" label="Pools that trade NAM" scope={[{ label: 'Pool depth', p: prov }]} scopeLabel="Where the pool figures come from">
      {shown.map((p, i) => (
        <PoolRow
          key={`${p.id}-${p.address}`}
          pair={p.pair.replace('/', ' / ')}
          sub={<><span>{p.id ? `#${p.id}` : 'no id'} · {p.type}</span>{i === 0 ? <Tag cat="Sets the price" look="ref" /> : null}</>}
          depth={<Num v={p.liquidityUsd} fmt={fmtUsdWhole} />}
          share={<Num v={total > 0 ? (p.liquidityUsd / total) * 100 : null} fmt={(n) => fmtPctRule(n, 1)} unit="of all depth" />}
          nam={<Num v={p.namReserve} fmt={fmtNamRule} unit="NAM" />}
          fee={<Num v={p.spreadFactor * 100} fmt={(n) => fmtPctRule(n)} unit="fee" />}
          bar={top > 0 ? p.liquidityUsd / top : null}
        />
      ))}
      {rest.length ? (
        <PoolRestRow>
          <Num v={rest.length} fmt={fmtCount} /> smaller pools hold <Num v={restUsd} fmt={fmtUsdWhole} />
        </PoolRestRow>
      ) : null}
    </DataList>
  );
}

const DEMO_CSS = `
@layer components {
  .demo-sec { padding: var(--s-7) 0; border-top: 1px solid var(--c-line); }
  .demo-wrap { width: 100%; max-width: var(--max); margin-inline: auto; padding-inline: var(--gutter); display: grid; gap: var(--s-4); min-width: 0; }
  .demo-h1 { font-size: var(--t-32); line-height: var(--lh-32); font-weight: var(--w-semi); text-transform: uppercase; letter-spacing: var(--track-display); }
  .demo-eyebrow { color: var(--c-ink-2); }
  .demo-h2 { font-size: var(--t-24); line-height: var(--lh-24); font-weight: var(--w-semi); letter-spacing: var(--track-h2); }
  .demo-h3 { margin-top: var(--s-5); font-size: var(--t-15); line-height: var(--lh-15); font-weight: var(--w-semi); }
  .demo-note { font-size: var(--t-15); line-height: var(--lh-15); color: var(--c-ink-2); max-width: 60ch; }
  .demo-p { font-size: var(--t-15); line-height: 28px; max-width: 60ch; }
  .demo-row { display: grid; gap: var(--s-2); padding: var(--s-3) 0; border-top: 1px solid var(--c-line); min-width: 0; }
  .demo-k { font: var(--w-medium) var(--t-12) / 16px var(--font-code); color: var(--c-ink-2); }
  .demo-v { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-3) var(--s-4); min-width: 0; color: var(--c-ink-2); font-size: var(--t-13); }
  .demo-row .demo-v { color: var(--c-ink); font-size: var(--t-15); }
  .demo-big { font-size: var(--t-32); line-height: var(--lh-32); font-weight: var(--w-medium); letter-spacing: var(--track-num); }
  .demo-flex { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-4); }
  .demo-stack { display: grid; gap: var(--s-4); }
  .demo-grid2 { display: grid; gap: var(--s-5); }
  .demo-checks { display: grid; gap: var(--s-2); font-size: var(--t-13); }
  .demo-chk { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
  .demo-chk .mono { color: var(--c-ink-2); }
  .demo-theme { justify-self: start; min-width: 240px; }
  .demo-inset { padding: var(--s-5) var(--gutter); margin-inline: calc(var(--gutter) * -1); }
  @media (min-width: 768px) { .demo-row { grid-template-columns: 220px minmax(0, 1fr); align-items: center; } .demo-grid2 { grid-template-columns: 1fr 1fr; } }
}`;
