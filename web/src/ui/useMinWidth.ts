// True from the given width up, following resizes: the one media-query hook of the screens (Home fetches its sparkline
// only where it shows; the depth page draws a day in five-minute columns under 1024 px).
import { useEffect, useState } from 'react';

export function useMinWidth(px: number): boolean {
  const q = `(min-width: ${px}px)`;
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const f = () => setOn(m.matches);
    f();
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [q]);
  return on;
}
