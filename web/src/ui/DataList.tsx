// DataList (system.md 8): a role="table" grid with NO <table> element and NO display: contents.
// Cells are direct children of their row, so the accessibility tree is clean. Below a container
// width each row is a two-line phone row; above it the same cells line up as a table (container
// queries in data.css: holders compact 620 px, holders full 930 px, ladder 600 px, pools 600 px).
//
// Figures in a list carry no per-row stamp: the list is a ProvScope with one SourceLine
// (pass `scope`), dimmed once (`old`) with one sentence when the whole list is old. A row that
// differs from its scope carries its own mark (pass a <ProvDot> in `exception`).
import React from 'react';
import type { ScopeItem } from './Sheet';
import { SourceLine } from './SourceLine';
import { fmtCount } from '../lib/format';

export type DataListKind = 'holders' | 'ladder' | 'pools' | 'moves';

export interface Column {
  label: React.ReactNode;
  align?: 'l' | 'r';
}

const DEFAULT_COLUMNS: Record<DataListKind, Column[]> = {
  holders: [{ label: '#' }, { label: 'Holder' }, { label: 'Total NAM', align: 'r' }, { label: 'Share', align: 'r' }],
  ladder: [{ label: 'Size' }, { label: 'Value', align: 'r' }, { label: 'You get', align: 'r' }, { label: 'Price move', align: 'r' }, { label: 'You pay', align: 'r' }, { label: 'Price move', align: 'r' }],
  pools: [{ label: 'Pool' }, { label: 'Depth', align: 'r' }, { label: 'Share', align: 'r' }, { label: 'NAM inside', align: 'r' }, { label: 'Fee', align: 'r' }],
  moves: [],
};
const FULL_HOLDERS: Column[] = [...DEFAULT_COLUMNS.holders, { label: 'Spendable', align: 'r' }, { label: 'Staked', align: 'r' }];

export interface DataListProps {
  kind: DataListKind;
  /** Accessible name of the table ("Ten biggest NAM holders"). */
  label: string;
  /** Holders: the full layout with Spendable and Staked columns from 930 px. */
  full?: boolean;
  /** Holders full: add the 7-day change column (only when any value is not zero). */
  change?: boolean;
  /** Column heads (defaults per kind). */
  columns?: Column[];
  /** The whole list is old: dim once (.is-old). Say why in `oldSentence` (shown above the rows). */
  old?: boolean;
  oldSentence?: React.ReactNode;
  /** The list's provenance scope: one SourceLine under the rows. */
  scope?: ScopeItem[];
  scopeLabel?: string;
  className?: string;
  children: React.ReactNode;
}

export function DataList({ kind, label, full, change, columns, old, oldSentence, scope, scopeLabel, className = '', children }: DataListProps) {
  const cols = columns ?? (kind === 'holders' && full ? [...FULL_HOLDERS, ...(change ? [{ label: '7 days', align: 'r' as const }] : [])] : DEFAULT_COLUMNS[kind]);
  return (
    <div className={`dl-scope${old ? ' is-old' : ''}`} data-prov-scope="">
      {old && oldSentence ? (
        <p className="scope__old">
          <i className="dot" data-status="old" aria-hidden="true" />
          <span>{oldSentence}</span>
        </p>
      ) : null}
      <div className={`dl dl--${kind}${full ? ' dl--full' : ''}${change ? ' dl--chg' : ''} ${className}`} role="table" aria-label={label}>
        {cols.length ? (
          <div className="dl__head" role="row">
            {cols.map((c, i) => (
              <span key={i} role="columnheader" className={c.align === 'r' ? 'r' : undefined}>{c.label}</span>
            ))}
          </div>
        ) : null}
        {children}
      </div>
      {scope?.length ? <SourceLine items={scope} label={scopeLabel} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- holders

export interface HolderRowProps {
  rank: number;
  /** Name (plain label) or the short address when unlabelled; a link or button to the address sheet. */
  name: React.ReactNode;
  /** Second line: short address, "+2 linked on Osmosis", or "no label". */
  sub?: React.ReactNode;
  /** A category tag only when it adds information. */
  tags?: React.ReactNode;
  total: React.ReactNode;
  share: React.ReactNode;
  spendable?: React.ReactNode;
  staked?: React.ReactNode;
  /** Under the staked cell from 930 px (e.g. a ProvDot "estimate 14,562,107"). */
  stakedNote?: React.ReactNode;
  change7d?: React.ReactNode;
  /** The row's own mark when it differs from its scope (a ProvDot), shown as line three on phones. */
  exception?: React.ReactNode;
  /** Share bar width relative to the largest row, 0..1. */
  bar?: number | null;
  className?: string;
}

export function HolderRow({ rank, name, sub, tags, total, share, spendable, staked, stakedNote, change7d, exception, bar, className = '' }: HolderRowProps) {
  return (
    <div className={`hrow ${className}`} role="row">
      <span className="hrow__rk" role="cell">{fmtCount(rank)}</span>
      <span className="hrow__id" role="cell">
        <span className="hrow__name">{name}</span>
        {sub ? <span className="hrow__addr">{sub}</span> : null}
        {tags ? <span className="hrow__tags">{tags}</span> : null}
      </span>
      <span className="hrow__tot" role="cell">{total}</span>
      <span className="hrow__pct" role="cell">{share}</span>
      <span className="hrow__spend" role="cell">{spendable ?? '—'}</span>
      <span className="hrow__stake" role="cell">
        {staked ?? '—'}
        {stakedNote ? <span className="hrow__est">{stakedNote}</span> : null}
      </span>
      {change7d !== undefined ? <span className="hrow__chg" role="cell">{change7d}</span> : null}
      {exception ? <span className="hrow__x" role="cell">{exception}</span> : null}
      {bar != null && Number.isFinite(bar) ? <i className="hrow__bar" style={{ ['--w' as string]: `${(Math.max(0, Math.min(1, bar)) * 100).toFixed(2)}%` } as React.CSSProperties} aria-hidden="true" /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- ladder

export interface LadderRowProps {
  /** Size cell content ("5,000 NAM"). */
  size: React.ReactNode;
  /** Accessible name of the pick button ("Quote 5,000 NAM"). */
  pickLabel: string;
  value: React.ReactNode;
  sellGet: React.ReactNode;
  sellMove: React.ReactNode;
  buyPay: React.ReactNode;
  buyMove: React.ReactNode;
  selected?: boolean;
  /** Tapping anywhere on the row sets the ticket size (a button laid over the whole row). */
  onPick?: () => void;
}

export function LadderRow({ size, pickLabel, value, sellGet, sellMove, buyPay, buyMove, selected, onPick }: LadderRowProps) {
  return (
    <div className={`lrow${selected ? ' is-sel' : ''}`} role="row" aria-selected={selected || undefined}>
      <span className="lrow__size" role="cell">
        {size}
        {onPick ? <button type="button" className="lrow__pick" aria-pressed={!!selected} aria-label={pickLabel} onClick={onPick} /> : null}
      </span>
      <span className="lrow__val" role="cell"><span className="wl">worth </span>{value}</span>
      <span className="lrow__sell" role="cell"><span className="lrow__w">Sell</span><span className="lrow__mv">{sellMove}</span><span>get <span className="lrow__get">{sellGet}</span></span></span>
      <span className="lrow__buy" role="cell"><span className="lrow__w">Buy</span><span className="lrow__mv">{buyMove}</span><span>pay <span className="lrow__pay">{buyPay}</span></span></span>
      <span className="lrow__sget" role="cell">{sellGet}<span className="u"> USDC</span></span>
      <span className="lrow__smv" role="cell">{sellMove}</span>
      <span className="lrow__bpay" role="cell">{buyPay}<span className="u"> USDC</span></span>
      <span className="lrow__bmv" role="cell">{buyMove}</span>
    </div>
  );
}

// ---------------------------------------------------------------- pools

export interface PoolRowProps {
  pair: React.ReactNode;
  /** "#3005 · concentrated" and a tag such as "Sets the price". */
  sub?: React.ReactNode;
  depth: React.ReactNode;
  share: React.ReactNode;
  nam: React.ReactNode;
  fee: React.ReactNode;
  /** Depth relative to the deepest pool, 0..1. */
  bar?: number | null;
}

export function PoolRow({ pair, sub, depth, share, nam, fee, bar }: PoolRowProps) {
  return (
    <div className="prow" role="row">
      <span className="prow__id" role="cell">
        <span className="prow__pair">{pair}</span>
        {sub ? <span className="prow__sub">{sub}</span> : null}
      </span>
      <span className="prow__liq" role="cell">{depth}</span>
      <span className="prow__share" role="cell">{share}</span>
      <span className="prow__nam" role="cell">{nam}</span>
      <span className="prow__fee" role="cell">{fee}</span>
      {bar != null && Number.isFinite(bar) ? <i className="prow__bar" style={{ ['--w' as string]: `${(Math.max(0, Math.min(1, bar)) * 100).toFixed(1)}%` } as React.CSSProperties} aria-hidden="true" /> : null}
    </div>
  );
}

/** The closing row of the pools list ("22 smaller pools hold $54"). */
/** The closing pools row: "N more pools" and, at the row's end, their total (`end`). */
export function PoolRestRow({ children, end }: { children: React.ReactNode; end?: React.ReactNode }) {
  return (
    <div className="prow prow--rest" role="row">
      <span role="cell">{children}</span>
      {end != null ? <span role="cell" className="r">{end}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------- latest moves

export interface MoveRowProps {
  /** Position in the list (01, 02 …). */
  no: number;
  /** The kind tag (<Tag kind=…/>). */
  tag: React.ReactNode;
  /** The signed NAM figure (<Num fmt={fmtNamSigned} unit="NAM"/>). */
  amount: React.ReactNode;
  /** "32 min ago · osmo1vkyae…mlrl4 · net of 24 h: 136 buys, 0 sells" */
  caption: React.ReactNode;
  /** A row that arrived from the stream (animates in once; never on load). */
  fresh?: boolean;
}

export function MoveRow({ no, tag, amount, caption, fresh }: MoveRowProps) {
  return (
    <div className={`tp${fresh ? ' is-new' : ''}`} role="row">
      <span className="tp__no" role="cell">{String(no).padStart(2, '0')}</span>
      <span role="cell">{tag}</span>
      <span className="tp__n" role="cell">{amount}</span>
      <span className="tp__c" role="cell">{caption}</span>
    </div>
  );
}

export default DataList;
