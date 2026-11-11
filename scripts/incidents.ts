/**
 * The public incidents timeline: what happened on Namada, one reviewed row per event, each with a source a reader can
 * open. scripts/export-proof.ts (npm run gen, which the build runs) writes this array into web/src/generated/events.ts
 * as INCIDENTS while the timeline is shown (shared/timeline-flag.ts; an empty array while it is hidden); the Shielded page lists it under "What happened on Namada", and the Trade price chart and the Shielded
 * trend chart carry the rows that have a `mark` as dated markers (web/src/screens/trade/model.ts incidentMarks).
 *
 * Rules for a row (test/incidents.test.ts keeps them):
 * - Public facts only, in plain words: what happened, when, between which blocks; never how, never who. The release
 *   rows say that a release was published and link its notes; they describe nothing of what the notes change.
 * - Every row has at least one source with a URL: Namada's release notes on GitHub, or the chain itself, as the
 *   public explorer's page of the first block named (the same explorer shared/config.ts links records to). A statement
 *   of Namada's the row repeats is a source of its own, named with where and when it was made, with or without a URL.
 *   A halt's hours are measured from the header times of the last block before it and the first after it, read on
 *   2026-11-07 from two public nodes that agree (namada-rpc.stakeandrelax.net and namada-rpc.polkachu.com); the
 *   stakeandrelax answers are kept as test/fixtures/namada_blockchain_*.json and the test holds the rows to them.
 * - `at` is the moment a chart marks: the header time of the last block before a halt, or of the first block of a
 *   move. A row without a `mark` is listed and not drawn. A mark is 12 characters or fewer.
 * - The halt of 2 November 2026 is `ongoing` while shared/halt.ts HALT.on, and says what the Namada team said in
 *   HALT.said, attributed to HALT.source. When the network is back, the release that turns HALT.on off gives this row
 *   its end date and the plain fact of the restart.
 * No network at build time: every figure here was verified by hand against the public nodes and is fixed.
 */
import { HALT } from '../shared/halt.ts';

export interface IncidentSource {
  /** the link's words ("Release notes, GitHub"; "The chain: blocks 7,912,187 to 7,912,188") */
  label: string;
  /** absent for a statement this site does not link: the team's words in a chat, or a post this site names and does not link */
  url?: string;
}

/** A stretch without blocks: the last block before it, the first after it, and the hours between their header times. */
export interface IncidentHalt { from: number; to: number; hours: number }

export interface Incident {
  id: string;
  /** the UTC day the row is dated (YYYY-MM-DD) and, for a span, its last day */
  date: string;
  end?: string;
  /** unix ms of the moment a chart marks (a block's header time) */
  at: number;
  title: string;
  /** one or two plain sentences */
  text: string;
  /** the pages of this site the row concerns (route paths) */
  pages: string[];
  sources: IncidentSource[];
  /** the chart label, 12 characters or fewer; a row without one is listed, not drawn */
  mark?: string;
  /** measured halts the row states (the test holds each to the fixtures) */
  halts?: IncidentHalt[];
  /** still running */
  ongoing?: boolean;
}

/** The public explorer's page of a block (the explorer shared/config.ts links transactions and accounts to). */
export const blockUrl = (height: number) => `https://namada.valopers.com/blocks/${height}`;
const release = (tag: string): IncidentSource => ({ label: `Namada ${tag} release notes, GitHub`, url: `https://github.com/namada-net/namada/releases/tag/${tag}` });
const n = (x: number) => x.toLocaleString('en-US');
const chain = (from: number, to?: number): IncidentSource =>
  to == null || to === from ? { label: `The chain: block ${n(from)}`, url: blockUrl(from) } : { label: `The chain: blocks ${n(from)} to ${n(to)}`, url: blockUrl(from) };

export const INCIDENTS: Incident[] = [
  {
    id: 'upgrade-v201-0-7',
    date: '2025-12-02',
    at: Date.UTC(2025, 11, 2, 16, 23, 46),
    title: 'Upgrade to Namada v201.0.7',
    text: 'The network paused for about 2.0 hours between blocks 4,514,501 and 4,514,502 (16:23 to 18:23 UTC) for the upgrade to Namada v201.0.7, released on 31 October 2025.',
    pages: ['/staking'],
    sources: [release('v201.0.7'), chain(4_514_501, 4_514_502)],
    mark: 'v201.0.7',
    halts: [{ from: 4_514_501, to: 4_514_502, hours: 1.99 }],
  },
  {
    id: 'pool-assets-2026-06-18',
    date: '2026-06-18',
    at: Date.UTC(2026, 5, 18, 9, 13, 19),
    title: 'Six transfers took the shielded pool’s other assets',
    text: 'Between blocks 6,966,393 and 6,966,885 (09:13 to 10:09 UTC), six transfers took the shielded pool’s USDC, ATOM, OSMO, NYM and TIA; no NAM moved. Namada announced an exploit on 20 June 2026.',
    pages: ['/shielded'],
    sources: [chain(6_966_393, 6_966_885), { label: 'Namada’s announcement on X, 20 June 2026' }],
    mark: 'Assets out',
  },
  {
    id: 'release-v201-0-9',
    date: '2026-08-10',
    at: Date.UTC(2026, 7, 10, 7, 59, 59),
    title: 'Namada v201.0.9 released',
    text: 'Namada published v201.0.9 on 10 August 2026; its release notes on GitHub list the changes.',
    pages: [],
    sources: [release('v201.0.9')],
  },
  {
    id: 'staking-account-2026-08-31',
    date: '2026-08-31',
    at: Date.UTC(2026, 7, 31, 23, 32, 3),
    title: '332,386,683 NAM left the staking account',
    text: 'In plain transfers at blocks 7,900,823 to 7,900,866 (23:32 to 23:36 UTC) the staking account paid out 332,386,683 NAM. Holders do not receive unstaked NAM this way: it is withdrawn after the unstaking wait.',
    pages: ['/supply', '/staking'],
    sources: [chain(7_900_823, 7_900_866)],
    mark: 'Staking out',
  },
  {
    id: 'halts-2026-09',
    date: '2026-09-01',
    end: '2026-09-14',
    at: Date.UTC(2026, 8, 1, 23, 43, 16),
    title: 'The network halted four times in two weeks',
    text: 'No blocks for 3.4 hours (blocks 7,912,187 to 7,912,188), 33.4 hours (7,913,446 to 7,913,447), 67.7 hours (7,914,107 to 7,914,108) and 195.1 hours (7,914,153 to 7,914,154); the last stretch ended on 14 September at 16:50 UTC.',
    pages: ['/staking', '/supply'],
    sources: [chain(7_912_187, 7_912_188), chain(7_913_446, 7_913_447), chain(7_914_107, 7_914_108), chain(7_914_153, 7_914_154)],
    mark: 'Four halts',
    halts: [
      { from: 7_912_187, to: 7_912_188, hours: 3.39 },
      { from: 7_913_446, to: 7_913_447, hours: 33.43 },
      { from: 7_914_107, to: 7_914_108, hours: 67.7 },
      { from: 7_914_153, to: 7_914_154, hours: 195.08 },
    ],
  },
  {
    id: 'release-v201-0-10',
    date: '2026-09-11',
    at: Date.UTC(2026, 8, 11, 13, 18, 16),
    title: 'Namada v201.0.10 released',
    text: 'Namada published v201.0.10 on 11 September 2026, during the longest of the four halts; its release notes on GitHub list the changes.',
    pages: [],
    sources: [release('v201.0.10')],
  },
  {
    id: 'release-v201-0-11',
    date: '2026-09-18',
    at: Date.UTC(2026, 8, 18, 17, 19, 28),
    title: 'Namada v201.0.11 released',
    text: 'Namada published v201.0.11 on 18 September 2026; its release notes on GitHub list the changes.',
    pages: [],
    sources: [release('v201.0.11')],
  },
  {
    id: 'staking-account-repaid',
    date: '2026-09-22',
    end: '2026-10-01',
    at: Date.UTC(2026, 8, 22, 17, 17, 7),
    title: 'The staking account was repaid in full',
    text: 'The 332,386,683 NAM that left the staking account on 31 August was paid back in plain transfers on 22 September (blocks 8,013,338 to 8,013,375) and 1 October 2026 (block 8,121,844), the same amount to the NAM.',
    pages: ['/supply', '/staking'],
    sources: [chain(8_013_338, 8_013_375), chain(8_121_844)],
    mark: 'Repaid',
  },
  {
    id: 'halt-2026-10-07',
    date: '2026-10-07',
    end: '2026-10-08',
    at: Date.UTC(2026, 9, 7, 10, 12, 15),
    title: 'A halt of 30.9 hours',
    text: 'No blocks between 7 October 10:12 UTC and 8 October 17:03 UTC (blocks 8,200,078 to 8,200,079). Namada v201.0.12 was published on 8 October.',
    pages: ['/staking', '/supply'],
    sources: [chain(8_200_078, 8_200_079), release('v201.0.12')],
    mark: 'Halt 30.9 h',
    halts: [{ from: 8_200_078, to: 8_200_079, hours: 30.85 }],
  },
  {
    id: HALT.id,
    date: '2026-11-02',
    at: Date.UTC(2026, 10, 2, 22, 49, 36),
    title: 'The network halted at block 8,517,986',
    text: `The last block was made on 2 November 2026 at 22:49:36 UTC. ${HALT.said}`,
    pages: ['/staking', '/supply', '/shielded'],
    sources: [chain(8_517_986), { label: HALT.source }],
    mark: 'Halt',
    ongoing: HALT.on,
  },
];
