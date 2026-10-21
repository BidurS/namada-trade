// Address sheet (S7): bottom sheet on phones, right-hand panel from 1024 px (Sheet size="side").
// system.md 9.8. Keeps everything the old AddressModal did: name, chain and rank, the full address
// with copy and the explorer (namada.valopers.com or Mintscan, lib/format), spendable and staked
// with their checked age, the two drift notes, 24 h and 7 d changes (unknown stays unknown), the
// validators it stakes with, linked addresses across the bridge, who it moves NAM with, its moves
// with a filter, and your own tag (signed in). Rewind: the address report is not recorded over
// time, so the sheet says the balances are current, lists moves up to the rewound time only and
// leaves out the dollar value (a current balance at an old price would be neither).
//
// Where it was opened from (nav-search-plan 3.2): opened from a list row, an eyebrow under the title says which list
// and where in it ("From holders · No. 1,204 by total NAM", "From activity · Move 51 of 53,934"); the rank line says
// both orders, "No. N by total NAM · No. M by spendable NAM", with the stamp of the stored balances they are counted
// over. Close and Escape go back to the row (the kit Sheet returns focus to it), so there is no breadcrumb.
import { useEffect, useMemo, useState } from 'react';
import type { AddressReport, Flow, Overview } from '../../../../shared/types';
import { navigate, useClock, useHeaderPrice, useOverlays, useOverview, useReplay, useSession, REWIND_WORDS } from '../../app/index';
import { fetchAddressReport, saveLabel } from '../../api';
import { Button, Derived, Notice, Num, ProvDot, SelectChip, Sheet, Skeleton, SourceLine, SNum, Tag, type Stamp } from '../../ui/index';
import { Icon } from '../../ui/Icon';
import { explorerAddr, explorerTxOf, fmtAddr, fmtAgo, fmtCount, fmtDayClock, fmtNamRule, fmtNamSigned, fmtPctRule, fmtUsdRule, fmtCoin, labelNeedsAddr } from '../../lib/format';
import { label_plain, tagByline } from '../../../../shared/labels';
import { coinOf, counterpartiesOf, crossingsWith, onePerCrossing } from './moves';
import { plainError, useCopy } from './util';
import { clearOrigin, originFor, type AddressOrigin } from '../activity/sheetOrigin';
import { serverHolderProv } from '../activity/holderStamp';
import { TECH } from '../activity/words';

type Filter = 'all' | 'trades' | 'bridge' | 'other';
const FILTERS: { value: Filter; label: string; kinds: (k: string) => boolean }[] = [
  { value: 'all', label: 'All', kinds: () => true },
  { value: 'trades', label: 'Trades', kinds: (k) => ['buy', 'sell', 'lp_add', 'lp_remove'].includes(k) },
  { value: 'bridge', label: 'Bridge', kinds: (k) => k.startsWith('ibc') },
  { value: 'other', label: 'Staking and shielded', kinds: (k) => ['bond', 'unbond', 'withdraw', 'shield', 'unshield', 'rewards'].includes(k) },
];
const FIRST = 20;
const MORE = 40;
/** The values the server accepts for a tag's category, with the word the page shows. */
const TAG_CATS: [string, string][] = [['watch', 'Watching'], ['whale', 'Large holder'], ['cex', 'Exchange'], ['team', 'Team'], ['backer', 'Backer'], ['foundation', 'Foundation'], ['bot', 'Bot'], ['other', 'Other']];
const STATE_WORD: Record<string, string> = { consensus: 'active', below_capacity: 'waiting to be active', below_threshold: 'below the minimum', jailed: 'jailed', inactive: 'inactive' };

const hrefAt = (t: number) => {
  const u = new URL(location.href);
  u.searchParams.set('at', String(Math.round(t)));
  return `${u.pathname}${u.search}`;
};

const BY_WORD: Record<'total' | 'liquid' | 'bonded', string> = { total: 'total NAM', liquid: 'spendable NAM', bonded: 'staked NAM' };

/**
 * The stamp of the two ranks: they are counted over the stored balances of every holder (the holder index), so
 * they are as old as those balances (the overview's holder figures stamp, the same one the holder counts carry).
 */
function rankStamp(o: Overview | null, osmo: boolean): Stamp {
  const p = serverHolderProv(o, osmo ? 'osmosis' : 'namada');
  const note = 'Counted among the stored balances of every holder when this address was read; the ranks move when a balance listing writes new balances.';
  return p ? { ...p, plain: 'Holder index', note: p.note ? `${p.note} ${note}` : note } : { source: TECH.holderIndex, plain: 'Holder index', at: null, status: 'stale', note: `${note} How old those balances are was not sent by this site’s server.` };
}

/** "From holders · No. 1,204 by total NAM", "From activity · Move 51 of 53,934": the list the sheet was opened from. */
function OriginLine({ o }: { o: AddressOrigin }) {
  if (o.from === 'holders') {
    return (
      <p className="eyebrow sh-addr__from">
        From holders · No. <Num v={o.rank} prov={o.stamp} fmt={fmtCount} showAge={false} showReason={false} /> by {BY_WORD[o.by]}
        {o.chain === 'osmosis' ? ' on Osmosis' : o.chain === 'all' ? ' on Namada and Osmosis' : ''}
      </p>
    );
  }
  return (
    <p className="eyebrow sh-addr__from">
      From activity · Move <Num v={o.pos} prov={o.stamp} fmt={fmtCount} showAge={false} showReason={false} />
      {o.total != null && o.exact ? (
        <>
          {' '}
          of <Num v={o.total} prov={o.stamp} fmt={fmtCount} showAge={false} showReason={false} />
        </>
      ) : null}
    </p>
  );
}

export function AddressSheet({ address, onClose, origin: given }: { address: string; onClose: () => void; origin?: AddressOrigin | null }) {
  const { at, rewound } = useReplay();
  // the opener's own word for where it was opened (app/overlays.tsx, when it passes one), else the list row's note
  const [origin] = useState<AddressOrigin | null>(() => given ?? originFor(address));
  useEffect(() => () => clearOrigin(address), [address]);
  const { overview } = useOverview();
  const { openAddress } = useOverlays();
  const price = useHeaderPrice();
  const now = useClock();
  const [r, setR] = useState<AddressReport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, copy] = useCopy();

  useEffect(() => {
    let alive = true;
    setR(null);
    setErr(null);
    fetchAddressReport(address)
      .then((x) => alive && setR(x))
      .catch((e: unknown) => alive && setErr(plainError(e, 'This address could not be read right now.')));
    return () => {
      alive = false;
    };
  }, [address]);

  const isOsmo = address.startsWith('osmo1');
  const name = r?.label?.label_plain ?? null;
  const title = name ?? fmtAddr(address);
  // a tag a signed-in wallet wrote is shown as that wallet's tag ("Tag by tnam1…"), never with a curated category
  const byline = r?.label ? tagByline(r.label.label_source ?? r.label.source, r.label.label_author ?? null) : null;
  const cat = byline ? null : r?.label ? r.label.category_plain ?? (r.label.category ? r.label.category.charAt(0).toUpperCase() + r.label.category.slice(1) : null) : null;

  return (
    <Sheet open onClose={onClose} title={title} size="side" className="sh-addr">
      <div className="sheet__body sh-addr__body">
        {origin ? <OriginLine o={origin} /> : null}
        <div className="sh-addr__tags">
          <Tag cat={isOsmo ? 'Osmosis address' : 'Namada address'} />
          {byline ? <Tag cat={byline} /> : null}
          {cat && !(name ?? '').toLowerCase().includes(cat.toLowerCase()) ? <Tag cat={cat} /> : null}
        </div>
        {r && (r.rank != null || r.rankTotal != null) ? <Ranks r={r} stamp={rankStamp(overview, isOsmo)} /> : null}
        <div className="sh-addr__id">
          <p className="sh-addr__full">{address}</p>
          <div className="sh-addr__acts">
            <button type="button" className="sh-act" onClick={() => copy(address)}>
              <Icon name={copied ? 'check' : 'copy'} className="ico ico--inline" />
              {copied ? 'Copied' : 'Copy address'}
            </button>
            <a className="sh-act" href={explorerAddr(address)} target="_blank" rel="noreferrer">
              <Icon name="external" className="ico ico--inline" />
              Explorer
              <span className="sr-only"> (opens {isOsmo ? 'Mintscan' : 'namada.valopers.com'})</span>
            </a>
          </div>
        </div>

        {rewound && at ? (
          <p className="sh-note">
            <i className="dot" data-status="old" aria-hidden="true" />
            <span>{REWIND_WORDS.balances(at)} Moves are listed up to that time.</span>
          </p>
        ) : null}

        {err ? (
          <Notice tone="danger" title="This address did not load">{err}</Notice>
        ) : !r ? (
          <Skeleton rows={5} heights={[64]} label="this address" />
        ) : (
          <Report r={r} isOsmo={isOsmo} price={price} now={now} at={rewound ? at : null} openAddress={openAddress} overviewCoverage={overview ? [overview.dex.coverage, overview.namada.coverage] : null} onClose={onClose} />
        )}
      </div>
    </Sheet>
  );
}

/**
 * "No. 1,204 by total NAM · No. 318 by spendable NAM": both orders the holder list has, each its own figure, with one
 * stamp for both (they are counted over the same stored balances). A server before the stored totals sends only the
 * spendable rank; "not ranked" when the address holds nothing in that order.
 */
function Ranks({ r, stamp }: { r: AddressReport; stamp: Stamp }) {
  const total = r.rankTotal;
  return (
    <p className="sh-addr__ranks" data-prov-group="">
      {total !== undefined ? (
        <>
          <span className="sh-addr__rank">
            {total != null ? <>No. <Num v={total} prov={stamp} fmt={fmtCount} showAge={false} /> by total NAM</> : 'Not ranked by total NAM'}
          </span>
          <span className="sh-addr__sep" aria-hidden="true">·</span>
        </>
      ) : null}
      <span className="sh-addr__rank">
        {r.rank != null ? <>No. <Num v={r.rank} prov={stamp} fmt={fmtCount} showAge={false} /> by spendable NAM</> : 'Not ranked by spendable NAM'}
      </span>
      <ProvDot p={stamp} label={total !== undefined ? 'Ranks by total and by spendable NAM' : 'Rank by spendable NAM'} />
    </p>
  );
}

function Report({
  r, isOsmo, price, now, at, openAddress, overviewCoverage, onClose,
}: {
  r: AddressReport;
  isOsmo: boolean;
  price: ReturnType<typeof useHeaderPrice>;
  now: number;
  at: number | null;
  openAddress: (a: string) => void;
  overviewCoverage: [Stamp, Stamp] | null;
  onClose: () => void;
}) {
  const bal = r.balance.value;
  const st = r.staking ?? null;
  const balStamp: Stamp = { ...r.balance.prov };
  const stakeStamp: Stamp | null = st ? st.prov : isOsmo ? null : { source: 'Namada node', at: null, status: 'missing', note: 'Staking could not be read right now.' };
  const changeStamp = (v: number | null, span: string): Stamp =>
    v == null
      ? { source: 'Balance readings', plain: 'Balance readings', at: null, status: 'missing', note: `Not known: no reading from ${span} ago is recorded.` }
      : { source: 'Balance readings', plain: 'Balance readings', at: r.balance.prov.at, status: r.balance.prov.status };
  const drift = r.indexedBalance != null && bal != null && Math.abs(r.indexedBalance - bal) > 1 ? bal - r.indexedBalance : null;
  const estDrift = st?.estimatedNam != null && Math.abs(st.estimatedNam - st.bondedNam) > Math.max(1, st.bondedNam * 0.01) ? st.bondedNam - st.estimatedNam : null;

  const flows = useMemo(() => (at ? r.flows.filter((f) => f.ts <= at) : r.flows), [r.flows, at]);
  const last = flows.length ? Math.max(...flows.map((f) => f.ts)) : null;
  // each bridge crossing once (its sending record); the counterparties and the links are counted from the same rows (moves.ts)
  const moves = useMemo(() => onePerCrossing(flows), [flows]);
  const cps = useMemo(() => counterpartiesOf(moves, r.address), [moves, r.address]);
  const recorded = at ? flows.length : r.totalFlowsCount ?? r.flows.length;
  const partial = (r.totalFlowsCount ?? r.flows.length) > r.flows.length;
  const overWords = partial ? `the newest ${fmtCount(moves.length)} moves listed below` : `the ${fmtCount(moves.length)} moves listed below`;

  return (
    <>
      <section className="sh-sec" data-prov-scope="" aria-label="Balances">
        <dl className="sh-figs">
          <div className="sh-fig">
            <dt>{isOsmo ? 'On Osmosis' : 'Spendable'}</dt>
            <dd>
              <SNum s={r.balance} fmt={fmtNamRule} unit="NAM" className="sh-fig__n" />
              {!at && bal != null && bal > 0 ? (
                <span className="sh-fig__sub">
                  About{' '}
                  <Derived
                    inputs={[{ value: bal, prov: balStamp }, { value: price.value, prov: price.stamp ?? { source: 'Osmosis quote', at: null, status: 'missing' } }]}
                    label="balance x price"
                    name="Spendable NAM in dollars"
                    compute={(a, p) => a * p}
                    fmt={fmtUsdRule}
                    showAge={false}
                  />
                </span>
              ) : null}
            </dd>
          </div>
          <div className="sh-fig">
            <dt>Staked</dt>
            <dd>
              {isOsmo ? (
                <span className="sh-fig__sub">Staking happens on Namada; this is an Osmosis address.</span>
              ) : (
                <>
                  <Num v={st?.bondedNam ?? null} prov={stakeStamp} fmt={fmtNamRule} unit="NAM" className="sh-fig__n" />
                  {st ? (
                    <span className="sh-fig__sub">
                      {st.delegations.length === 1 ? 'with 1 validator' : `with ${fmtCount(st.delegations.length)} validators`}
                    </span>
                  ) : null}
                </>
              )}
            </dd>
          </div>
          {st && st.unbondingNam > 0 ? (
            <div className="sh-fig">
              <dt>Unstaking</dt>
              <dd>
                <Num v={st.unbondingNam} prov={st.prov} fmt={fmtNamRule} unit="NAM" className="sh-fig__n" />
              </dd>
            </div>
          ) : null}
          <div className="sh-fig">
            <dt>Change, 24 hours</dt>
            <dd>
              <Num v={r.change24h} prov={changeStamp(r.change24h, '24 hours')} fmt={fmtNamSigned} unit="NAM" className="sh-fig__n" showAge={false} />
            </dd>
          </div>
          <div className="sh-fig">
            <dt>Change, 7 days</dt>
            <dd>
              <Num v={r.change7d} prov={changeStamp(r.change7d, '7 days')} fmt={fmtNamSigned} unit="NAM" className="sh-fig__n" showAge={false} />
            </dd>
          </div>
        </dl>
        {drift != null ? (
          <p className="sh-cap">
            The flow index had <Num v={r.indexedBalance} prov={balStamp} fmt={fmtNamRule} showAge={false} /> NAM, {fmtNamRule(Math.abs(drift))} apart from the reading above.
          </p>
        ) : null}
        {estDrift != null && st ? (
          <p className="sh-cap">
            Adding up recorded staking moves gives <Num v={st.estimatedNam} prov={st.prov} fmt={fmtNamRule} showAge={false} /> NAM, {fmtNamRule(Math.abs(estDrift))} apart. The chain reading is shown.
          </p>
        ) : null}
        <SourceLine
          items={[
            { label: isOsmo ? 'On Osmosis' : 'Spendable', p: balStamp },
            ...(stakeStamp ? [{ label: 'Staked', p: stakeStamp }] : []),
            { label: 'Changes over 24 hours and 7 days', p: changeStamp(r.change24h ?? r.change7d, '24 hours') },
            ...(!at ? [{ label: 'Dollar value (balance x price)', p: price.stamp }] : []),
          ]}
          label="Where these balances come from"
        />
      </section>

      {st && st.delegations.length ? (
        <section className="sh-sec" data-prov-scope="" aria-labelledby="sh-addr-val">
          <h3 id="sh-addr-val" className="sh-h3">Staked with</h3>
          <ul className="sh-rows">
            {st.delegations.map((d) => (
              <li key={d.validatorAddress} className="sh-row">
                <a className="sh-row__name sh-row__link" href={explorerAddr(d.validatorAddress)} target="_blank" rel="noreferrer">
                  {d.validatorName ?? fmtAddr(d.validatorAddress)}
                  <Icon name="external" className="ico ico--inline" />
                </a>
                <span className="sh-row__n">
                  <Num v={d.amountNam} fmt={fmtNamRule} unit="NAM" />
                </span>
                <span className="sh-row__sub">
                  {fmtPctRule(d.commission * 100, 0)} commission · {STATE_WORD[d.state] ?? d.state.replace(/_/g, ' ')}
                </span>
              </li>
            ))}
          </ul>
          <SourceLine items={[{ label: 'Stake per validator', p: st.prov }]} label="Where the stake comes from" />
        </section>
      ) : null}

      <section className="sh-sec" data-prov-scope="" aria-label="Moves">
        {r.links.length ? (
          <div className="sh-grp">
            <h3 className="sh-h3">Linked across the bridge</h3>
            <ul className="sh-rows">
              {r.links.map((l) => {
                const x = crossingsWith(moves, r.address, l.address);
                return (
                  <li key={l.address} className="sh-row">
                    <button type="button" className="sh-row__name sh-row__btn" onClick={() => openAddress(l.address)}>
                      {label_plain(null, l.address) ?? fmtAddr(l.address)}
                    </button>
                    <span className="sh-row__sub sh-row__sub--wide">
                      {l.chain === 'osmosis' ? 'On Osmosis' : 'On Namada'} ·{' '}
                      {x.n ? (
                        <>
                          {x.n === 1 ? '1 crossing' : `${fmtCount(x.n)} crossings`} · {fmtNamRule(x.nam)} NAM{x.last != null ? <> · last {fmtAgo(x.last, now)}</> : null}
                        </>
                      ) : (
                        <>no crossing among {partial ? 'the newest moves listed below' : 'the moves listed below'}</>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="sh-cap">Crossings are counted over {overWords}, each once.</p>
          </div>
        ) : null}

        {cps.length ? (
          <div className="sh-grp">
            <h3 className="sh-h3">Who it moves NAM with most</h3>
            <ul className="sh-rows">
              {cps.slice(0, 8).map((c) => {
                const by = c.label_plain ? tagByline(c.label_source, c.label_author) : null;
                return (
                  <li key={c.address} className="sh-row">
                    <button type="button" className="sh-row__name sh-row__btn" onClick={() => openAddress(c.address)}>
                      {c.label_plain ?? fmtAddr(c.address)}
                    </button>
                    <span className="sh-row__sub sh-row__sub--wide">
                      {/* a shared label (genesis) names many addresses: its short address says which one; a wallet's tag says who wrote it */}
                      {labelNeedsAddr(c.address, c.label_plain) ? <><span className="mono">{fmtAddr(c.address)}</span> · </> : null}
                      {by ? <>{by} · </> : null}
                      in {fmtNamSigned(c.inNam)} · out {fmtNamSigned(-c.outNam)} NAM · {c.count === 1 ? '1 move' : `${fmtCount(c.count)} moves`}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="sh-cap">NAM only, counted over {overWords}; a bridge crossing counts once.</p>
          </div>
        ) : null}

        <Moves moves={moves} loaded={flows.length} recorded={recorded} address={r.address} now={now} openAddress={openAddress} />

        {last != null ? (
          <p className="sh-rw">
            <a
              className="link"
              href={hrefAt(last + 60_000)}
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                navigate(hrefAt(last + 60_000));
              }}
            >
              <span>Rewind to this address&rsquo;s last move</span>
              <Icon name="rewind" className="ico ico--inline" />
            </a>
          </p>
        ) : null}

        <SourceLine
          items={overviewCoverage ? [{ label: 'Moves on Osmosis', p: overviewCoverage[0] }, { label: 'Moves on Namada', p: overviewCoverage[1] }] : [{ label: 'Moves', p: null }]}
          label="Where the moves come from"
        />
      </section>

      <TagForm address={r.address} current={r.label} onClose={onClose} />
    </>
  );
}

/**
 * The address's moves, newest first, each bridge crossing once. `moves`: the listed moves (crossings once);
 * `loaded`: the records they come from; `recorded`: every record of this address on file.
 */
function Moves({ moves: flows, loaded, recorded, address, now, openAddress }: { moves: Flow[]; loaded: number; recorded: number; address: string; now: number; openAddress: (a: string) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [n, setN] = useState(FIRST);
  const test = FILTERS.find((f) => f.value === filter)!.kinds;
  const list = flows.filter((f) => test(f.kind)).sort((a, b) => b.ts - a.ts);
  const counts = Object.fromEntries(FILTERS.map((f) => [f.value, flows.filter((x) => f.kinds(x.kind)).length])) as Record<Filter, number>;
  const twins = loaded - flows.length;
  return (
    <div className="sh-grp">
      <h3 className="sh-h3">
        Moves{' '}
        <span className="sh-h3__n">
          {recorded > loaded ? `${fmtCount(recorded)} records, the newest ${fmtCount(loaded)} here` : fmtCount(flows.length)}
        </span>
      </h3>
      {twins > 0 ? (
        <p className="sh-cap">
          Each bridge crossing is listed once, by the chain it left: {twins === 1 ? 'one record' : `${fmtCount(twins)} records`} of the same crossing{twins === 1 ? '' : 's'} arriving on the other chain {twins === 1 ? 'is' : 'are'} left out.
        </p>
      ) : null}
      {flows.length ? (
        <SelectChip<Filter> label="Show" hideLegend value={filter} onChange={(v) => { setFilter(v); setN(FIRST); }} options={FILTERS.map((f) => ({ value: f.value, label: f.label, count: counts[f.value] }))} className="sh-filter" />
      ) : null}
      {list.length === 0 ? (
        <p className="sh-cap">{flows.length ? 'No moves of this kind are recorded for this address.' : 'No moves are recorded for this address.'}</p>
      ) : (
        <ul className="sh-moves" aria-label="Moves, newest first">
          {list.slice(0, n).map((f) => {
            const out = f.from === address;
            const cp = out ? f.to : f.from;
            const cpLabel = cp ? (out ? f.toLabelPlain : f.fromLabelPlain) ?? null : null;
            const cpName = cp ? cpLabel ?? fmtAddr(cp) : null;
            const coin = coinOf(f); // a move of another coin (shielded OSMO, USDC…) shows its own coin, never NAM
            return (
              <li key={f.id} className="sh-mv">
                <span className="sh-mv__tag"><Tag kind={f.kind} chain={f.chain} /></span>
                <span className="sh-mv__n">{fmtNamSigned(out ? -f.amount : f.amount)} <span className="u">{coin}</span></span>
                <span className="sh-mv__sub">
                  <a className="sh-mv__tx" href={explorerTxOf(f)} target="_blank" rel="noreferrer" title={`${fmtAgo(f.ts, now)}. Open the transaction in the explorer.`}>
                    <time dateTime={new Date(f.ts).toISOString()}>{fmtDayClock(f.ts)}</time>
                    <Icon name="external" className="ico ico--inline" />
                    <span className="sr-only"> (the transaction, in the explorer)</span>
                  </a>
                  {coin === 'NAM' && f.counterAmount && f.counterDenom ? <span className="sh-mv__x">{fmtCoin(f.counterAmount)} {f.counterDenom}</span> : null}
                  {cp ? (
                    // plain text: a separate span inside this inline-flex button would split into a column
                    <button type="button" className="sh-mv__cp" onClick={() => openAddress(cp)}>{out ? 'to ' : 'from '}{cpName}{labelNeedsAddr(cp, cpLabel) ? ` · ${fmtAddr(cp)}` : ''}</button>
                  ) : f.poolId ? <span className="sh-mv__x">pool {f.poolId}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {list.length > n ? (
        <p>
          <Button size="sm" onClick={() => setN((x) => x + MORE)}>Show {fmtCount(Math.min(MORE, list.length - n))} more</Button>
        </p>
      ) : null}
    </div>
  );
}

function TagForm({ address, current, onClose }: { address: string; current: AddressReport['label']; onClose: () => void }) {
  const { session } = useSession();
  const { openSignIn } = useOverlays();
  const [tag, setTag] = useState(current?.source === 'user' ? current.label : '');
  const [cat, setCat] = useState(current?.source === 'user' ? current.category : 'watch');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (!session) {
    return (
      <section className="sh-sec sh-tag" aria-labelledby="sh-addr-tag">
        <h3 id="sh-addr-tag" className="sh-h3">Your tag</h3>
        <p className="sh-cap">Signed in, you can name this address for everyone. Tags are shared with every user and signed with your address.</p>
        <p>
          <Button size="sm" aria-haspopup="dialog" onClick={() => { onClose(); openSignIn(); }}>Sign in to tag it</Button>
        </p>
      </section>
    );
  }
  return (
    <section className="sh-sec sh-tag" aria-labelledby="sh-addr-tag">
      <h3 id="sh-addr-tag" className="sh-h3">Your tag</h3>
      <form
        className="sh-tag__f"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!tag.trim()) return;
          setBusy(true);
          setMsg(null);
          try {
            const res = await saveLabel(address, tag.trim(), cat);
            setMsg(res.ok ? { ok: true, text: 'Saved. Everyone now sees this tag.' } : { ok: false, text: plainError(res.error ?? '', 'The tag was not saved.') });
          } catch (er) {
            setMsg({ ok: false, text: plainError(er, 'The tag was not saved.') });
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="sh-in">
          <span className="sh-in__l">Name</span>
          <input className="sh-in__i" value={tag} maxLength={60} onChange={(e) => setTag(e.target.value)} placeholder="For example: exchange hot wallet" autoComplete="off" />
        </label>
        <label className="sh-in">
          <span className="sh-in__l">Kind</span>
          <select className="sh-in__i sh-in__sel" value={cat} onChange={(e) => setCat(e.target.value)}>
            {TAG_CATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <Button type="submit" size="sm" busy={busy} disabled={!tag.trim() || busy}>Save tag</Button>
      </form>
      <p className="sh-cap">Tags are shared with every user and signed with your address.</p>
      {msg ? <p className={`sh-msg${msg.ok ? '' : ' sh-msg--bad'}`} role="status">{msg.text}</p> : null}
    </section>
  );
}
