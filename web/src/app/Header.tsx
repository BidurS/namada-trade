// The header, the instrument's bezel (system.md 3): black in both themes, 52 px on phones,
// 64 px from 1024 px, one row. Mark (44 px target) · six text tabs (from 1024) · the NAM price
// with its 24 h change in a fixed-width slot · Rewind (from 1024; the banner is the only replay
// control below) · the status pill · search · account.
//
// Search (nav-search-plan 3.1): the icon button below 1024 px; from 1024 px the same button is field-shaped, with the
// words "Search an address, a name or a page" and, where there is a keyboard, the "/" hint. It is a button that opens
// the palette, never a second input whose text would have to be mirrored into the palette's.
import { lazy, Suspense, useState } from 'react';
import { TABS } from '../../../shared/routes';
import { Icon } from '../ui/Icon';
import { Mark, Wordmark } from '../ui/Wordmark';
import { fmtPctSigned, fmtUsdRule } from '../lib/format';
import { uiStatus } from '../lib/prov';
import type { Stamp } from '../lib/prov';
import { Link } from './Link';
import { osmosisStreaming, useNow, useOverview, useVisible } from './overview';
import { useOverlays, prefetchPalette } from './overlays';
import { PartBoundary } from './LoadFailed';
import { useReplay, REWIND_WORDS } from './replay';
import { useRoute } from './router';
import { useSession } from './session';
import { StatusPill } from './StatusPill';

const ProvSheet = lazy(() => import('../ui/Sheet').then((m) => ({ default: m.ProvSheet })));

/**
 * The header price: the live quote, or under Rewind the last trade price at that time (labelled).
 * `error` is set when the overview has not answered at all (no figure, and the reason).
 */
export function useHeaderPrice(): { value: number | null; stamp: Stamp | null; label: string; change: number | null; error: string | null } {
  const { overview, error } = useOverview();
  const { rewound } = useReplay();
  if (!overview) return { value: null, stamp: null, label: 'NAM price', change: null, error };
  const quote = overview.price.usd;
  if (rewound) {
    // the quoted price was not recorded then: the server answers with the executed-swap price
    // (its source says so); if it sends nothing, fall back to the executed price ourselves
    const useSwap = quote.value == null || quote.prov.status === 'missing';
    const s = useSwap ? overview.price.swap1h : quote;
    const executed = useSwap || /executed|swap/i.test(s.prov.source);
    return { value: s.value, stamp: s.prov, label: executed ? REWIND_WORDS.price : 'NAM price', change: overview.price.change24h, error: null };
  }
  return { value: quote.value, stamp: quote.prov, label: 'NAM price', change: overview.price.change24h, error: null };
}

export function Header() {
  const { route } = useRoute();
  const { stream } = useOverview();
  const visible = useVisible();
  const now = useNow();
  const { rewound } = useReplay();
  const { session } = useSession();
  const { openPalette, openSources, openSheet, openSignIn } = useOverlays();
  const price = useHeaderPrice();
  const [priceOpen, setPriceOpen] = useState(false);
  const activeTab = route?.tab ?? null;

  const status = price.stamp ? uiStatus(price.stamp.status) : 'none';
  const priceText = price.value != null ? fmtUsdRule(price.value) : null;
  // A change of 100% or more without its decimal ("+137%"): the digit says nothing at that size, and its width left the
  // 375 px header 3 px too wide after the 2026-10-21 crash and rebound ("+136.6%").
  const changeText = price.change != null ? fmtPctSigned(price.change, Math.abs(price.change) >= 100 ? 0 : 1) : '';
  // the pulse means "streaming": not while the hub's Osmosis feed is down
  const live = !rewound && stream.connected && osmosisStreaming(stream, now) !== false && visible && status === 'fresh';
  const priceAria = priceText
    ? `${price.label} ${priceText}${changeText ? `, ${changeText} since this time yesterday` : ''}. Show source.`
    : price.stamp
      ? `${price.label}: no data${price.stamp.note ? `, ${price.stamp.note.replace(/\.$/, '')}` : ''}. Show source.`
      : price.error
        ? `NAM price: no data, ${price.error.charAt(0).toLowerCase()}${price.error.slice(1).replace(/\.$/, '')}. Where every number comes from.`
        : 'NAM price: no data yet. Show source.';

  return (
    <header className="hdr ground-chrome">
      <div className="hdr__in">
        <Link className="brand" to="/" aria-label="Namada Trade, home">
          <Mark className="brand__mark" />
          <Wordmark className="brand__word" />
        </Link>

        <nav className="tabs" aria-label="Primary">
          <ul>
            {TABS.map((t) => (
              <li key={t.id}>
                <Link to={t.path} aria-current={activeTab === t.id ? 'page' : undefined}>
                  {t.label}
                  {t.id === 'alerts' ? <AlertsCount /> : null}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <span className="hdr__sp" />

        <button type="button" className="hprice" data-live={live ? '' : undefined} aria-label={priceAria} title={price.label} onClick={() => (price.stamp ? setPriceOpen(true) : openSources())}>
          {/* under Rewind the dot is a plain ring: green reads as "live", and nothing is live then */}
          <i className="dot" data-status={rewound ? 'age' : status} />
          {priceText ? (
            <span className="hprice__v" data-num data-status={status}>{priceText}</span>
          ) : price.stamp || price.error ? (
            // the overview answered without a price, or did not answer: say so ("—"); the reason is in the label and the sheet
            <span className="hprice__v" data-num data-status="none">—</span>
          ) : (
            <span className="hprice__v"><span className="hprice__wait" aria-hidden="true" /></span>
          )}
          <span className="hprice__d">{changeText}</span>
        </button>

        <button type="button" className="hbtn hbtn--rewind" data-on={rewound ? '' : undefined} aria-label={rewound ? 'Rewind to another time (rewound now)' : 'Rewind to a date'} onClick={() => openPalette({ focus: 'rewind' })} onPointerEnter={prefetchPalette}>
          <Icon name="rewind" />
          <span>Rewind</span>
        </button>

        <StatusPill onOpen={openSources} />

        <button type="button" className="ibtn hsearch" aria-label="Search" aria-keyshortcuts="/ Control+K Meta+K" onClick={() => openPalette()} onPointerEnter={prefetchPalette} onFocus={prefetchPalette}>
          <Icon name="search" />
          <span className="hsearch__t" aria-hidden="true">Search an address, a name or a page</span>
          <span className="hsearch__w" aria-hidden="true">Search</span>
          <kbd className="hsearch__k" aria-hidden="true">/</kbd>
        </button>
        <button
          type="button"
          className="ibtn"
          aria-label={session ? `Account: signed in as ${session.address.slice(0, 10)}…` : 'Account: sign in'}
          onClick={() => (session ? openSheet({ kind: 'account' }) : openSignIn())}
        >
          <Icon name="account" />
          {session ? <i className="ibtn__on" aria-hidden="true" /> : null}
        </button>
      </div>
      {priceOpen && price.stamp ? (
        <PartBoundary onClose={() => setPriceOpen(false)} resetKey={priceOpen}>
          <Suspense fallback={null}>
            <ProvSheet p={price.stamp} label={price.label} open onClose={() => setPriceOpen(false)} />
          </Suspense>
        </PartBoundary>
      ) : null}
    </header>
  );
}

/** The Alerts count dot: hits since the last visit (hidden at 0 and under Rewind). */
export function AlertsCount({ className = 'count' }: { className?: string }) {
  const { alerts } = useOverview();
  if (!alerts.count) return null;
  const n = alerts.count > 99 ? '99+' : String(alerts.count);
  return (
    <span className={className}>
      <span aria-hidden="true">{n}</span>
      <span className="sr-only">, {alerts.count} new since your last visit</span>
    </span>
  );
}
