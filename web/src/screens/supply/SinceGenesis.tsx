// NAM since genesis (the Supply page, 2026-11-07). The one sentence: how NAM supply grew from the genesis total to the
// minted total now, split into the shielded rewards the chain's own total gives, and the staking and public-funding
// inflation the dated split (web/src/generated/supply.ts) tells apart from epoch 1207 on; before that, together.
// A phone shows the sentence alone, in place of the "What this page shows" paragraph (owner: a phone line replaces
// one). From 1024 px the section adds the dated split as a bar with its legend and the modelled caveat, the newest
// epoch's staking inflation from the chain's own record, and the one large transfer into the public-funding account.
// Every live figure comes from the overview with its stamp; the dated part carries its day. Nothing here is typed.
import type { Overview } from '../../../../shared/types';
import { SUPPLY_WORDS } from '../../../../shared/copy';
import { SUPPLY_SPLIT } from '../../generated/supply';
import { Num, ProvDot, ProvScope, SourceLine, Tag, derive, type ScopeItem, type Stamp } from '../../ui';
import { fmtCount, fmtDayMonthYear, fmtNamRule, fmtPctRule } from '../../lib/format';
import { SUPPLY_SOURCES } from '../../lib/prov';
import { genesisShares, sinceGenesisParts } from './since-genesis';

/** The dated split's stamp: the day it was re-derived and what from (a static figure with its date, as the proof block). */
const SPLIT_STAMP: Stamp = {
  source: 'public chain figures, re-derived (docs/data)',
  plain: 'Public chain figures, re-derived',
  at: SUPPLY_SPLIT.derivedAt,
  status: 'live',
  note: `Re-derived ${fmtDayMonthYear(SUPPLY_SPLIT.derivedAt)} from ${SUPPLY_SPLIT.source}. The method and the coverage are in the repository's docs/data folder.`,
};
/** A server before 2026-11-07 does not send the chain's rewards total or the newest epoch's mint: said, never 0. */
const notSent = (source: string, what: string): Stamp => ({ source, at: null, status: 'missing', note: `This server does not send ${what} yet.` });

const PART_CLASS = { rewards: 'sp-gen__f--rewards', staking: 'sp-gen__f--staking', publicFunding: 'sp-gen__f--pgf', together: 'sp-gen__f--together' } as const;

export function SinceGenesis({ overview: o, wide }: { overview: Overview | null; wide: boolean }) {
  if (!o) return null;
  const totalStamp: Stamp = o.supply.prov;
  const rewardsStamp: Stamp = o.supply.shieldedRewards?.prov ?? notSent(SUPPLY_SOURCES.rewards, 'the chain’s total of shielded rewards');
  const mintStamp: Stamp = o.supply.mint?.prov ?? notSent(SUPPLY_SOURCES.mint, 'the newest epoch’s staking inflation');
  const answer = sinceGenesisParts(o.supply.total, o.supply.shieldedRewards?.value ?? null, SUPPLY_SPLIT);
  const sentenceStamp = derive([totalStamp, rewardsStamp, SPLIT_STAMP], 'all NAM − the genesis total, less the chain’s total of shielded rewards, less the dated split');
  const p = answer.parts;
  const from = String(SUPPLY_SPLIT.fromEpoch), to = String(SUPPLY_SPLIT.toEpoch);
  const sentence = p
    ? SUPPLY_WORDS.sinceGenesis(fmtNamRule(p.genesisNam), fmtNamRule(p.nowNam), fmtNamRule(p.rewardsNam), from, fmtNamRule(p.stakingNam), fmtNamRule(p.publicFundingNam))
    : null;
  const mint = o.supply.mint ?? null;
  const mintWords = mint?.nam != null && mint.epoch != null && mint.height != null
    ? SUPPLY_WORDS.mintNow(fmtNamRule(mint.nam), String(mint.epoch), fmtCount(mint.height))
    : SUPPLY_WORDS.mintNotRead;
  const scope: ScopeItem[] = [
    { label: SUPPLY_WORDS.scope.total, p: totalStamp },
    { label: SUPPLY_WORDS.scope.rewards, p: rewardsStamp },
    { label: SUPPLY_WORDS.scope.split, p: SPLIT_STAMP },
    ...(wide ? [{ label: SUPPLY_WORDS.scope.mint, p: mintStamp }] : []),
  ];
  const names = {
    rewards: SUPPLY_WORDS.parts.rewards,
    staking: SUPPLY_WORDS.parts.staking(from, to),
    publicFunding: SUPPLY_WORDS.parts.publicFunding(from, to),
    together: SUPPLY_WORDS.parts.together(from, to),
  };
  const shares = p ? genesisShares(p) : [];
  return (
    <ProvScope as="section" className="ipg-sec ipg-col--full sp-gen" aria-labelledby="sp-gen-h">
      <div className="ipg-sec__head">
        <h2 id="sp-gen-h" className="h2">{SUPPLY_WORDS.heading}</h2>
      </div>
      <p className="ipg-prose" data-prov-group="">
        {sentence ?? <Num v={null} prov={{ ...sentenceStamp, status: 'missing', note: answer.why ?? sentenceStamp.note }} label={SUPPLY_WORDS.heading} />}{' '}
        <ProvDot p={sentence ? sentenceStamp : { ...sentenceStamp, status: 'missing', note: answer.why ?? sentenceStamp.note }} label={SUPPLY_WORDS.heading} />
      </p>
      {wide && p ? (
        <div className="sp-gen__bar">
          <Tag cat={SUPPLY_WORDS.dated(fmtDayMonthYear(SUPPLY_SPLIT.derivedAt))} />
          <div className="sp-gen__track" role="img" aria-label={shares.map((s) => `${names[s.key]} ${fmtNamRule(s.nam)} NAM (${fmtPctRule(s.pct, 1)})`).join(', ')}>
            {shares.map((s) => (s.nam > 0 ? <span key={s.key} className={`sp-gen__seg ${PART_CLASS[s.key]}`} style={{ width: `${s.pct.toFixed(2)}%` }} /> : null))}
          </div>
          <ul className="sp-gen__legend">
            {shares.map((s) => (
              <li key={s.key} className="sp-gen__item">
                <i className={`sp-gen__sw ${PART_CLASS[s.key]}`} aria-hidden="true" />
                <span className="sp-gen__name">{names[s.key]}</span>
                <span className="sp-gen__v">
                  <Num v={s.nam} fmt={fmtNamRule} unit="NAM" />
                  <span className="sp-gen__pct" data-num="">{fmtPctRule(s.pct, 1)}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="cap">
            {SUPPLY_WORDS.caveat(
              fmtDayMonthYear(SUPPLY_SPLIT.derivedAt), from, to, fmtCount(SUPPLY_SPLIT.measuredEpochs), fmtCount(SUPPLY_SPLIT.epochs),
              fmtCount(SUPPLY_SPLIT.modelled.toEpoch - SUPPLY_SPLIT.modelled.fromEpoch + 1), fmtDayMonthYear(Date.parse(`${SUPPLY_SPLIT.modelled.fromDay}T00:00:00Z`)), fmtDayMonthYear(Date.parse(`${SUPPLY_SPLIT.modelled.toDay}T00:00:00Z`)),
              fmtNamRule(SUPPLY_SPLIT.modelled.stakingNam),
            )}
          </p>
        </div>
      ) : null}
      {wide ? (
        <>
          <p className="ipg-prose" data-prov-group="">
            {mintWords}{' '}
            <ProvDot p={mintStamp} label={SUPPLY_WORDS.scope.mint} />
          </p>
          <p className="cap">{SUPPLY_WORDS.transfer(fmtNamRule(SUPPLY_SPLIT.transfer.nam), fmtCount(SUPPLY_SPLIT.transfer.block), fmtDayMonthYear(SUPPLY_SPLIT.transfer.at))}</p>
        </>
      ) : null}
      <SourceLine items={scope} label="Where the since-genesis figures come from" />
    </ProvScope>
  );
}
