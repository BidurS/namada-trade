// The overview bar (system.md 12), under the header on every page, for the two ways the shared
// overview can fail:
// - it never answered: no figure from it can be shown, and the screens show "—" where they would
//   wait (useOverviewFailed); this bar says why, once, with one "Try again";
// - it stopped answering (live): the last poll failed, or two polls went unanswered. Every figure from
//   it already reads old (OverviewProvider ages out its stamps); this bar says since when and why.
// It goes away with the next answer.
import { fmtUtcClock } from '../lib/format';
import { useOverview } from './overview';
import { useReplay } from './replay';

const lowerFirst = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;

export function StaleBanner() {
  const { overview, stale, error, receivedAt, pending, refresh } = useOverview();
  const { rewound } = useReplay();
  const failed = overview == null && error != null;
  if (!stale && !failed) return null;
  let text: string;
  if (failed) {
    text = `The figures did not load: ${lowerFirst(error!)}${rewound ? '' : ' The page asks again every 20 seconds.'}`;
  } else {
    const since = receivedAt != null ? ` since ${fmtUtcClock(receivedAt)}` : '';
    text = `The figures have not refreshed${since}${error ? `: ${lowerFirst(error)}` : '. No new reading has arrived.'} They are shown as old.`;
  }
  return (
    <div className="upd upd--stale" role="status">
      <div className="upd__in">
        <p>{text}</p>
        <button type="button" className="upd__btn" aria-busy={pending || undefined} disabled={pending} onClick={refresh}>
          Try again
        </button>
      </div>
    </div>
  );
}
