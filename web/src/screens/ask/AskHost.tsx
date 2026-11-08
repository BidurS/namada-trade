// Mounted once in the shell, above the routes, so a thread survives following one of its page links. The panel's code
// loads the first time the chat opens, and it stays mounted (closed) after that so the thread is kept until reload.
import { Suspense, lazy } from 'react';
import { ASK_SHOWN } from '../../../../shared/ask-words';
import { useAskStore } from './store';

const AskPanel = lazy(() => import('./Panel'));

export function AskHost() {
  const { open, opened } = useAskStore();
  if (!ASK_SHOWN || !opened) return null;
  return (
    <Suspense fallback={null}>
      <AskPanel open={open} />
    </Suspense>
  );
}
