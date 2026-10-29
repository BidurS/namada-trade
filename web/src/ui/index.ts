// The UI kit barrel. Screens import primitives from here only: `import { Num, ProvChip } from '../../ui'`.
// Contracts: docs/design/build-plan.md 5.2. CSS lives in web/src/styles/components/*.css.

// clock, rewind and navigation hooks the shell wires once
export { UiProvider, useUiNow, useWallNow, WallClock, useUiConfig, defaultRewindHref, type UiConfig } from './now';

// provenance (F2)
export { Num, SNum, Derived, Price, fmtPriceNode, type NumProps } from './Num';
export { ProvChip, type ProvControlProps } from './ProvChip';
export { ProvDot } from './ProvDot';
export { SourceLine, ProvScope, sourcesText, scopeSummary, type SourceLineProps, type ScopeItem } from './SourceLine';
export { Sheet, ProvSheet, ScopeSheet, RewindLink, type SheetProps } from './Sheet';
export { Tag, type TagProps } from './Tag';
export { Term, type TermProps } from './Term';

// controls and feedback (F3)
export { Button, ArrowLink, IconButton, type ButtonProps } from './Button';
export { Segmented, type SegmentedProps, type SegOption } from './Segmented';
export { Tabs, type TabItem } from './Tabs';
export { Pager, PageTools, stepFor, type PagerProps, type PageToolsProps, type PageJump } from './Pager';
export { SelectChip, type SelectChipProps, type ChipOption } from './SelectChip';
export { FilterChips, type FilterChip, type FilterChipsProps } from './FilterChips';
export { Field, SearchField, type FieldProps } from './Field';
export { Switch, type SwitchProps } from './Switch';
export { Notice, type NoticeProps, type NoticeTone } from './Notice';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Skeleton, SkeletonBlock, type SkeletonProps } from './Skeleton';

// data display and charts (F4)
export { DataList, HolderRow, LadderRow, PoolRow, PoolRestRow, MoveRow, type Column, type DataListProps, type DataListKind, type HolderRowProps, type LadderRowProps, type PoolRowProps, type MoveRowProps } from './DataList';
export { TxList } from './TxList';
export { AddrName, RecordLink, YouTag, useShowAll, isMineIn } from './ListBits';
export { SupplyBar, type SupplyBarProps, type SupplySegment, type SupplyKey } from './SupplyBar';
export { HeroNumber, type HeroNumberProps } from './HeroNumber';
export { Fact, type FactProps, type FactItem } from './Fact';
export { PriceChart, compactNam, RANGE_MS, RANGES, type PriceChartProps, type ChartRange, type ChartEvent, type SeriesPoint, type BandPoint, type ChartStart } from './PriceChart';
export { Bars, BarsPlot, barsScale, SLOT_MARK_MIN_PX, type BarsProps, type BarsPlotProps, type BarPoint } from './Bars';
export { PairsList, type PairsListProps } from './PairsList';
export { TradesTape, type TradesTapeProps, type TapeGroup } from './TradesTape';
export { OrderflowChart, type OrderflowChartProps } from './OrderflowChart';
export { SeriesChart, namTick, namShort, type SeriesChartProps, type SeriesRange } from './SeriesChart';
export { OrderSizeCurve, type OrderSizeCurveProps } from './OrderSizeCurve';
export { DepthChart, type DepthChartProps, type DepthChartMark, type DepthChartTrade } from './DepthChart';
export { HeatChart, type HeatChartProps, type HeatChartTrade } from './HeatChart';
export { curveAt, fromApi, sliderToSize, sizeToSlider, logPos, type CurveQuote, type CurveReading } from './curveMath';
export { niceTicks, takeaway } from './chartMath';
export { Sparkline, type SparklineProps } from './Sparkline';
export { useSize } from './useSize';
export { useMinWidth } from './useMinWidth';

// icons and the mark (shell, F1)
export * from './Icon';
export * from './Wordmark';

// libraries the components speak
export type { Stamp, Status, UiStatus } from '../lib/prov';
export { uiStatus, statusWord, STATUS_WORD, plainSource, stampText, CHECK_TITLES, checkUi, stampOf } from '../lib/prov';
export { derive, derived, inputNames } from '../lib/derive';
export { GLOSSARY, glossaryEntry, type GlossaryEntry } from '../lib/glossary';
export { KINDS, kindInfo, tagKindOf, type TagKind } from '../lib/kinds';
