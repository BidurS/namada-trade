// The safe-size figures in words (W6), shared by Trade's size block and /osmosis, so both pages say the
// same thing the same way. The word before the figure says how it was made (model.ts safeSize): "about"
// between two listed sizes (a straight line, not a quote), "at least" the largest listed size when none
// reaches the limit, "under" the smallest listed size when even it moves the price more.
import { Num, type Stamp } from '../../ui/index';
import { NBSP, fmtNamRule, fmtPctRule } from '../../lib/format';
import type { SafeHow, SafeSize } from './model';

/** The qualifier before the figure. */
export const SAFE_WORD: Record<SafeHow, string> = { interpolated: 'about', at_least: 'at least', below_smallest: 'under' };

/** "about 1,450 NAM", "at least 100,000 NAM", "under 1,000 NAM"; the em dash when there is no figure. */
export function SafeFig({ s, prov, as = 'b', className }: { s: SafeSize; prov?: Stamp | null; as?: 'b' | 'span'; className?: string }) {
  return (
    <>
      {s.how ? <span className={className}>{SAFE_WORD[s.how]}{NBSP}</span> : null}
      <Num as={as} v={s.how ? s.n : null} prov={prov} fmt={fmtNamRule} unit="NAM" showReason={false} />
    </>
  );
}

/**
 * How the figures were made, in one or two sentences (said once under them): the smallest size's own move when
 * a limit is under it, and what "about" and "at least" mean when either is used.
 */
export function safeHowWords(list: SafeSize[]): string {
  const out: string[] = [];
  const below = list.find((s) => s.how === 'below_smallest' && s.smallestNam != null && s.smallestImpactPct != null);
  if (below) out.push(`The smallest size quoted, ${fmtNamRule(below.smallestNam)}${NBSP}NAM, already moves the price ${fmtPctRule(below.smallestImpactPct!, 2)}.`);
  if (list.some((s) => s.how === 'interpolated')) out.push('“About” is a straight line between the two listed sizes around the limit, not a quote.');
  if (list.some((s) => s.how === 'at_least')) out.push('“At least”: even the largest size quoted moves the price less than that.');
  return out.join(' ');
}

/** What the figure was made from, for its stamp (the sheet's "How it is computed"). */
export function safeDerivedFrom(s: SafeSize, limit: string): string {
  if (s.how === 'below_smallest') return `the smallest listed size, which already moves the price more than ${limit}, the worse of buying or selling`;
  if (s.how === 'at_least') return `the largest listed size, which moves the price less than ${limit}, the worse of buying or selling`;
  if (s.a != null && s.b != null) return `a straight line between the ${fmtNamRule(s.a)} and ${fmtNamRule(s.b)} NAM rows of the size table, around a ${limit} move, the worse of buying or selling`;
  return `a straight line between the two listed sizes around a ${limit} move, the worse of buying or selling`;
}
