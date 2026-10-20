// The rewound banner (system.md 8): full width, black on yellow, sticky under the header, one
// line and a 44 px "Back to now". Phone: "Rewound · 30 Aug, 19:05 UTC"; from 640 px the
// full sentence. Below 1024 px it is the only replay control (the header Rewind is hidden).
import { Icon } from '../ui/Icon';
import { REWIND_WORDS, useReplay } from './replay';

export function RewindBanner() {
  const { at, backToNow } = useReplay();
  if (!at) return null;
  return (
    <div className="rwb" role="region" aria-label="Rewind">
      <div className="rwb__in">
        <Icon name="rewind" />
        <p className="rwb__t" aria-live="polite">
          {REWIND_WORDS.banner(at)}
          <span className="rwb__more">. {REWIND_WORDS.bannerMore}</span>
        </p>
        <button type="button" className="rwb__btn" onClick={backToNow}>
          {REWIND_WORDS.back}
        </button>
      </div>
    </div>
  );
}
