// The Keys sheet (docs/design/nav-search-plan.md 3.3): `?` opens it (and "Keys" in search). Every row comes from
// SHORTCUTS in app/keys.ts, the one table of the bindings and their words, so this list and the keys cannot drift.
// Lazy-loaded by the overlays host; it opens itself on mount and returns focus to its opener (ui/Sheet.tsx).
import { Fragment } from 'react';
import { Sheet } from '../ui/Sheet';
import { SHORTCUTS } from './keys';

/** Where a key works, in the order and the words of the sheet. Any other value of `where` is listed after these. */
const WHERE_TITLE: Record<string, string> = {
  everywhere: 'On every page',
  lists: 'On the two lists, holders and transactions',
  search: 'In search',
};

/** "1 to 6" for a run of digit keys; otherwise each key on its own. */
function KeysOf({ keys }: { keys: readonly string[] }) {
  if (keys.length === 2 && keys.every((k) => /^\d$/.test(k)) && Number(keys[1]) > Number(keys[0]) + 1) {
    return (
      <>
        <kbd>{keys[0]}</kbd> to <kbd>{keys[1]}</kbd>
      </>
    );
  }
  return (
    <>
      {keys.map((k, i) => (
        <Fragment key={k}>
          {i ? ' ' : null}
          <kbd>{k}</kbd>
        </Fragment>
      ))}
    </>
  );
}

const upperFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export default function KeysSheet({ onClose }: { onClose: () => void }) {
  const wheres = [...new Set(SHORTCUTS.map((s) => s.where as string))].sort((a, b) => {
    const order = Object.keys(WHERE_TITLE);
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
  });
  return (
    <Sheet open onClose={onClose} title="Keys" className="sh-keys" lead="Single keys work when you are not typing in a field and no sheet is open.">
      {wheres.map((w) => (
        <section key={w} className="sh-keys__g" aria-labelledby={`keys-${w}`}>
          <h3 id={`keys-${w}`} className="sh-keys__h">{WHERE_TITLE[w] ?? upperFirst(w)}</h3>
          <dl className="sh-keys__kv">
            {SHORTCUTS.filter((s) => s.where === w).map((s) => (
              <div key={`${s.keys.join(' ')} ${s.does}`} className="sh-keys__row">
                <dt>
                  <KeysOf keys={s.keys} />
                </dt>
                <dd>{upperFirst(s.does)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Sheet>
  );
}
