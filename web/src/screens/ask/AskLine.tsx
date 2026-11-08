// The one closed line that opens the Ask chat: under the hero on phones and tablets, in the "Right now" rail on a wide
// screen. Nothing else is added to the page. Not shown under Rewind: the chat only knows the current figures.
import { useEffect } from 'react';
import { useReplay } from '../../app/index';
import { Ico } from '../../ui/ico';
import { useMinWidth } from '../../ui/useMinWidth';
import { ASK_SHOWN, ASK_WORDS } from '../../../../shared/ask-words';
import { loadAskState, openAsk, useAskStore } from './store';

const RAIL_FROM = 1024;

export function AskLine({ where }: { where: 'band' | 'rail' }) {
  const { at } = useReplay();
  const wide = useMinWidth(RAIL_FROM);
  const { state, hasThread, open } = useAskStore();
  useEffect(loadAskState, []);
  if (!ASK_SHOWN || at != null || !state || state.state === 'unavailable' || wide !== (where === 'rail')) return null;
  const line = (
    <button type="button" className="ask-line" aria-expanded={open} aria-haspopup="dialog" onClick={(e) => openAsk(e.currentTarget)}>
      <span>{hasThread ? ASK_WORDS.lineThread : ASK_WORDS.line}</span>
      <Ico name="arrow" className="ico" />
    </button>
  );
  return where === 'band' ? <div className="band ground-ink ask-band"><div className="wrap">{line}</div></div> : line;
}
