// List pieces every screen with address rows uses (Supply, Shielded, Activity, Alerts, the sheets):
// the address name that opens the Address sheet, the record link to a public explorer, the "you"
// tag and the show-all toggle. CSS: styles/components/page.css (.xaddr, .xrec, .xmore).
import React from 'react';
import { useUiConfig } from './now';
import { explorerTx, fmtAddr, labelNeedsAddr } from '../lib/format';
import { tagByline } from '../../../shared/labels';
import { Icon } from './Icon';
import { Tag } from './Tag';

// ---------------------------------------------------------------- address name

/**
 * The name of an address (its plain label, else the short address) as a button that opens the
 * address sheet. Balances in that sheet are current, not rewound; the sheet says so.
 *
 * `withAddr`: where no other line of the row prints the short address, a label carries it, in the code
 * face ("from Public sale allocation (genesis) tnam1qrt5t…7k2vd"); when the line is short it wraps under
 * the label, the name-over-address pattern of the rows. A genesis label is shared by thousands of
 * addresses, so the label alone cannot tell two of them apart (lib/format labelNeedsAddr; a protocol
 * account's name stays alone).
 *
 * `source` / `author`: where the label came from. A name a signed-in wallet typed (source 'user') is followed by
 * its byline ("· Tag by tnam1qxyz…", shared/labels tagByline), so it never reads like a curated name.
 */
export function AddrName({ address, label, prefix, withAddr = false, source, author, className = '' }: { address: string | null | undefined; label?: string | null; prefix?: string; withAddr?: boolean; source?: string | null; author?: string | null; className?: string }) {
  const { openAddress } = useUiConfig();
  if (!address) return <span className={className}>unknown address</span>;
  const short = fmtAddr(address);
  const name = label ?? short;
  const by = label ? tagByline(source, author) : null;
  const showAddr = withAddr && labelNeedsAddr(address, label);
  const pre = prefix ? <span className="xaddr__pre">{prefix} </span> : null;
  const tail = (
    <>
      {showAddr ? <>{' '}<span className="xaddr__a">{short}</span></> : null}
      {by ? <span className="xaddr__by"> · {by}</span> : null}
    </>
  );
  // The name read out starts with the words on screen, in their order (WCAG 2.5.3, axe label-content-name-mismatch);
  // a label shown alone adds its short address after them.
  const spoken = `${prefix ? `${prefix} ` : ''}${name}${showAddr ? ` ${short}` : ''}${by ? ` · ${by}` : ''}${label && !showAddr ? ` (${short})` : ''}`;
  if (!openAddress) return <span className={`xaddr ${className}`}>{pre}<span className="xaddr__n">{name}</span>{tail}</span>;
  return (
    <button type="button" className={`xaddr ${className}`} onClick={() => openAddress(address)} aria-label={`${spoken}. Open this address.`}>
      {pre}
      <span className="xaddr__n">{name}</span>
      {tail}
    </button>
  );
}

// ---------------------------------------------------------------- record link

/** The move's record on a public explorer (a new tab). */
export function RecordLink({ chain, hash }: { chain: 'namada' | 'osmosis'; hash: string }) {
  return (
    <a className="xrec" href={explorerTx(chain, hash)} target="_blank" rel="noreferrer noopener" aria-label="Record of this move, opens in a new tab">
      <span>Record</span>
      <Icon name="external" className="ico ico--inline" />
    </a>
  );
}

// ---------------------------------------------------------------- you

/** "You": the signed-in address or its bridge counterpart. */
export function YouTag() {
  return <Tag cat="You" look="you" />;
}

export const isMineIn = (mine: string[]) => (a: string | null | undefined) => !!a && mine.includes(a);

// ---------------------------------------------------------------- show all

/** Shows the first `n` items, then a 44 px toggle with the full count. */
export function useShowAll<T>(items: T[], n: number): [T[], React.ReactNode] {
  const [all, setAll] = React.useState(false);
  if (items.length <= n) return [items, null];
  const list = all ? items : items.slice(0, n);
  const btn = (
    <p className="xmore">
      <button type="button" className="btn btn--secondary btn--sm" aria-expanded={all} onClick={() => setAll((v) => !v)}>
        {all ? `Show the first ${n}` : `Show all ${items.length}`}
      </button>
    </p>
  );
  return [list, btn];
}
