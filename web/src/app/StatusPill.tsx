// The header status pill (system.md 3 and the "header 5/7" red flag): a check icon (amber
// when any cross-check needs a look) plus "5/7" on phones, "5 of 7" from 400 px, "5 of 7
// checks" from 640 px. It opens the Sources sheet ("Where every number comes from").
// Under Rewind overview.checks is empty: the pill reads "no data", "Checks were not recorded
// then" (build-plan W7). Before the first answer it keeps its width and says nothing. When the
// page stops refreshing (a poll failed, or two went unanswered) the count stays but the pill turns
// amber, and its name and title say since when and why: the checks shown are that old.
import { Icon } from '../ui/Icon';
import { fmtUtcClock } from '../lib/format';
import { useOverview } from './overview';
import { useReplay, REWIND_WORDS } from './replay';

export interface CheckCount {
  state: 'wait' | 'none' | 'ok' | 'look';
  ok: number;
  total: number;
}

export function useCheckCount(): CheckCount {
  const { overview, error } = useOverview();
  if (!overview) return { state: error ? 'none' : 'wait', ok: 0, total: 0 };
  const total = overview.checks.length;
  if (!total) return { state: 'none', ok: 0, total: 0 };
  const ok = overview.checks.filter((c) => c.status === 'ok').length;
  return { state: ok === total ? 'ok' : 'look', ok, total };
}

export function StatusPill({ onOpen }: { onOpen: () => void }) {
  const c = useCheckCount();
  const { rewound } = useReplay();
  const { error, stale, receivedAt } = useOverview();
  const staleWords = stale
    ? `Not refreshed since ${receivedAt != null ? fmtUtcClock(receivedAt) : 'the page loaded'}${error ? `: ${error.charAt(0).toLowerCase()}${error.slice(1).replace(/\.$/, '')}` : ''}.`
    : null;
  const status = c.state === 'ok' ? (stale ? 'old' : 'fresh') : c.state === 'look' ? 'old' : c.state;
  const label =
    c.state === 'wait' ? 'Cross-checks are being read. Where every number comes from.'
    : c.state === 'none' ? `No data: ${(rewound ? REWIND_WORDS.checks : error ?? 'No cross-checks were reported').replace(/\.$/, '')}. Where every number comes from.`
    : `${c.ok} of ${c.total} checks pass${c.state === 'look' ? `, ${c.total - c.ok} need a look or have no recent result` : ''}.${staleWords ? ` ${staleWords}` : ''} Where every number comes from.`;
  // The name starts with the words on screen ("5 of 7 checks", "no data": WCAG 2.5.3, label in name).
  // The phone short form "5/7" is drawn from data-s by CSS, so it is not a second, different name.
  return (
    <button type="button" className="hbtn hbtn--status" data-status={status} aria-label={label} title={c.state === 'none' && rewound ? REWIND_WORDS.checks : staleWords ?? undefined} onClick={onOpen}>
      <Icon name={c.state === 'none' ? 'info' : 'check'} />
      {c.state === 'wait' ? (
        <span aria-hidden="true" className="hbtn__wait" />
      ) : c.state === 'none' ? (
        <span>
          <span className="hbtn__ns">—</span>
          <span className="hbtn__nl">no data</span>
        </span>
      ) : (
        <span>
          <span className="hbtn__s" data-s={`${c.ok}/${c.total}`} aria-hidden="true" />
          <span className="hbtn__l">{c.ok} of {c.total}</span>
          <span className="hbtn__more"> checks</span>
        </span>
      )}
    </button>
  );
}
