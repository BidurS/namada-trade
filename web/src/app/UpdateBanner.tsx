// The update bar (kept from the old App.tsx): a deployed tab keeps running the old bundle, so
// every 2 minutes and whenever the tab becomes visible the served index.html's entry script is
// compared with ours. A different one means a new version was deployed.
import { useEffect, useState } from 'react';

const ENTRY = /assets\/index-[A-Za-z0-9_-]+\.js/;

export function UpdateBanner() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const mine = Array.from(document.scripts).map((s) => s.src).find((src) => ENTRY.test(src));
    if (!mine) return; // development, or an unexpected build: nothing to compare
    let alive = true;
    const check = async () => {
      try {
        const html = await (await fetch(`/?v=${Date.now()}`, { cache: 'no-store' })).text();
        const m = html.match(ENTRY);
        if (alive && m && !mine.endsWith(m[0])) setReady(true);
      } catch {
        /* offline: try again later */
      }
    };
    const t = setInterval(check, 120_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  if (!ready) return null;
  return (
    <div className="upd" role="status">
      <div className="upd__in">
        <p>A new version was deployed.</p>
        <button type="button" className="upd__btn" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}
