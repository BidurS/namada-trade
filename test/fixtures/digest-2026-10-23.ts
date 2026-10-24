// The digest's figures for the 24 h to 2026-10-23 08:00 UTC, as production's stored rows held them: the readings of
// the read-only survey of 2026-10-23 (every value below is a stored row, named by the statement that read it). The
// worked example of the digest spec's section 7 is rendered from these. The two largest requests' tx hashes were not
// captured, so those rows carry none and the lines carry no explorer link; the Namada cursor, the Osmosis sweep, the
// holder index's top-10 stamps and the proposal cache's time were read in the afternoon (the kv rows are overwritten)
// and are printed as stored. No address of a person appears here: the validator addresses are public validators.
import type { DigestFigures, Metric, OperatorFigures } from '../../worker/src/digest/message';
import { CADENCE } from '../../worker/src/digest/message';

/** The instants: T (the digest's now), 24 h and 7 d before. */
export const T = 1792742400000;
export const A24 = T - 86_400_000;
export const A7 = T - 7 * 86_400_000;

/** A metric's "now" reading and its 24 h base, as the latest-at-or-before statements read them. */
const metric = (value: number, at: number, cadenceMs: number, base?: { value: number; at: number }, label: '24 h' | '7 d' = '24 h'): Metric => ({
  value, at, cadenceMs, bases: base ? [{ label, instant: label === '24 h' ? A24 : A7, base }] : [],
});

/** The minute keys' last tick before 08:00 and before 08:00 the day before (metrics rows). */
const MINUTE_NOW = 1792742342769; // 07:59:02 UTC
const MINUTE_24H = 1792655942278; // 07:59:02 UTC on 22 Oct
/** The bond listing that completed 07:38:42 UTC (height 8,384,271, epoch 2696, Papadritta) and the 07:54:02 UTC one of 22 Oct. */
const BOND_NOW = 1792741122300;
const BOND_24H = 1792655642703;

export const figures = (): DigestFigures => ({
  kind: 'daily',
  now: T,
  from: A24,
  to: T,
  anchors: {
    // kv namada.cursor 8388520 (updated_at 15:45:53 UTC), kv namada.head { height 8388513 }
    namada: { cursor: 8388520, cursorAt: 1792770353357, head: 8388513 },
    // kv osmosis.live { connected true, height 73054078 } (updated_at 15:45:06 UTC); kv osmosis.cursor { height 73054078, at 15:43:52 UTC }
    osmosis: { live: { connected: true, at: 1792770306828, height: 73054078 }, sweep: { height: 73054078, at: 1792770232662 } },
    bondListing: { at: BOND_NOW, height: 8384271, epoch: 2696, provider: 'Papadritta' },
    // the balance listing that completed 07:52:03 UTC at height 8,384,388 (5ElementsNodes)
    balanceListing: { at: 1792741923099, height: 8384388, provider: '5ElementsNodes' },
    // metrics epoch: 2696 at 07:59:02; its first reading 03:33:03.586 UTC, the reading before it 03:23:26 UTC (m_epoch_changes);
    // kv chain.params { epochSec 21617.16293333333, epochSecNote, fetchedAt 10:09:06 UTC }
    epoch: {
      epoch: 2696,
      at: MINUTE_NOW,
      startedAt: 1792726383586,
      plusMinusMs: 1792726383586 - 1792725806538,
      params: { epochSec: 21617.16293333333, epochSecNote: 'about 6.00 h an epoch, measured over the last 30 epochs', fetchedAt: 1792750146318 },
    },
  },
  staked: {
    value: {
      totalStake: metric(267774764.266631, MINUTE_NOW, CADENCE.minute, { value: 267307557.266631, at: MINUTE_24H }),
      posAccount: metric(341793716.357239, MINUTE_NOW, CADENCE.minute, { value: 342513983.706558, at: MINUTE_24H }),
      stakers: metric(19340, BOND_NOW, CADENCE.bondListing, { value: 19342, at: BOND_24H }),
      validators: metric(246, BOND_NOW, CADENCE.bondListing),
    },
  },
  requests: {
    value: {
      // flows kind bond: 10 rows, 373,220 NAM; three bonds of 50,000 NAM at 12:35:21 UTC in block 8,374,275 to three validators
      bonds: { n: 10, nam: 373220, late: 0, largest: { amount: 50000, ts: 1792672521237, height: 8374275, validator: 'tnam1qx405kgvey8wwfcyt7rgsr4nvkrqsnztxs2kz7wv', ties: 3, tieValidators: 3 } },
      // flows kind unbond: 2 rows, 30,900 NAM; the larger 25,100 NAM at 20:33:39 UTC (block 8,378,453)
      unbonds: { n: 2, nam: 30900, late: 0, largest: { amount: 25100, ts: 1792701219137, height: 8378453, validator: null, ties: 1, tieValidators: 1 } },
      decodeFailures: 0,
    },
  },
  pipeline: {
    value: {
      listing: { at: BOND_NOW, height: 8384271, epoch: 2696, provider: 'Papadritta' },
      inFlight: 181962.018281,
      withdrawable: 36859599.847648,
      queueFromEpoch: 56,
      base: { listing: { at: BOND_24H, height: null, epoch: 2692, provider: 'Papadritta' }, withdrawable: 38029599.847648 },
      baseEpoch: 2692,
      withdrawnBetween: { nam: 1170000, n: 1 },
      directMatured: { nam: 0, n: 0 },
      withdrawn: { n: 1, nam: 1170000, largest: 1170000, ts: 1792678774775 },
      // unbond_queue rows after epoch 2696 (kv unbond.term_structure's buckets, read 15:06 UTC)
      buckets: [
        { epoch: 2704, nam: 37489.267473, n: 2 }, { epoch: 2708, nam: 5784.366953, n: 6 }, { epoch: 2715, nam: 159.915364, n: 4 },
        { epoch: 2725, nam: 100000, n: 3 }, { epoch: 2726, nam: 1000, n: 2 }, { epoch: 2729, nam: 611, n: 1 }, { epoch: 2731, nam: 6017.468491, n: 2 },
        { epoch: 2750, nam: 5800, n: 2 }, { epoch: 2751, nam: 25100, n: 10 }, { epoch: 2753, nam: 1020, n: 1 },
      ],
    },
  },
  rewards: { value: { n: 17, nam: 3250.146476, largest: 928.274047, late: 0 } },
  price: {
    value: {
      quote: {
        value: 0.000873590633754392, at: MINUTE_NOW, cadenceMs: CADENCE.minute,
        bases: [
          { label: '24 h', instant: A24, base: { at: MINUTE_24H, value: 0.000845573830047854 } },
          { label: '7 d', instant: A7, base: { at: 1792137567420, value: 0.001015425133170758 } },
        ],
      },
    },
  },
  trades: {
    value: {
      // metrics price.swap_1h at 05:00 UTC from the one trusted trade of the hour (9,970.02 NAM for 9.137572 USDC)
      executed: { hourStart: 1792731600000, price: 0.0009165048816351421, n: 1 },
      vwap: { n: 1, vwap: 0.0009165048816351421, lo: 0.0009165048816351421, hi: 0.0009165048816351421 },
      window: { n: 9, nam: 60537.859869, usd: 53.90965357712074, unpriced: 0, traders: 4, buyNam: 29284.644236000004, sellNam: 31253.215633, overBound: false, basis: { execution: 1, pool_1h: 0, spot: 8, swap_1h: 0, unstated: 0 } },
      dataApi: metric(41.73517318478308, 1792742304000, CADENCE.hourly),
    },
  },
  bridge: {
    value: {
      ibcIn: { n: 1, nam: 1454.202387, largest: 1454.202387, late: 0 },
      ibcOut: { n: 5, nam: 359041.657201, largest: 259041.657201, late: 0 },
      refunded: { n: 0, nam: 0 },
      escrow: metric(20832856.303644, MINUTE_NOW, CADENCE.minute, { value: 21190443.758458, at: MINUTE_24H }),
    },
  },
  masp: {
    value: {
      shield: { n: 2, nam: 3 },
      ibcIn: { n: 4, nam: 100000 },
      unshield: { n: 4, nam: 3.0341 },
      ibcOut: { n: 0, nam: 0 },
      feesNam: 0.2409,
      balance: metric(49187665.00507, MINUTE_NOW, CADENCE.minute, { value: 49087665.28007, at: MINUTE_24H }),
    },
  },
  holders: {
    value: {
      namada: metric(64825, 1792741923099, CADENCE.balanceListing, { value: 64826, at: 1792654025087 }),
      osmosis: metric(1313, 1792741802657, CADENCE.hourly, { value: 1313, at: 1792655402216 }),
      osmosisPassTrustedAt: 1792768802762,
      // kv holders.figures namada.top10 { s, at 14:56:53 UTC } and osmosis.top10 { s, at 15:20:02 UTC }
      namadaTop10: { nam: 274832001.624664, at: 1792767413343, previousPct: null },
      osmosisTop10: { nam: 10221302.566133, at: 1792768802762, previousPct: null },
      mintedNam: metric(1147916525.090649, MINUTE_NOW, CADENCE.minute),
      osmosisNam: metric(20831242.303644, MINUTE_NOW, CADENCE.minute),
      stakeTop10Pct: metric(53.152634675145336, BOND_NOW, CADENCE.bondListing, { value: 53.23679235186314, at: BOND_24H }),
    },
  },
  governance: {
    value: {
      // kv intel.cache fetchedAt 15:41:09 UTC, indexerEpoch 2698; its 20 proposals (titles as the survey stored them, cut at 60)
      fetchedAt: 1792770069095,
      indexerEpoch: 2698,
      proposals: [
        { id: 42, title: 'Signalling - Knowable is leaving Namada', status: 'executedRejected', type: 'default', startEpoch: 1827, endEpoch: 1867, discussionsUrl: null },
        { id: 41, title: 'Whitelist Osmosis and Cosmos Hub channels permissionlessly', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 1508, endEpoch: 1520, discussionsUrl: null },
        { id: 40, title: 'Turn off PGF treasury inflation', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 1468, endEpoch: 1488, discussionsUrl: null },
        { id: 39, title: 'Update tx_ibc.wasm for mainnet v201.0.7', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 1466, endEpoch: 1478, discussionsUrl: null },
        { id: 38, title: 'Update two protocol parameters needed for IBC Eureka activat', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 1452, endEpoch: 1464, discussionsUrl: null },
        { id: 37, title: 'Signalling - Upgrade to v201.0.7 at Block 4514500', status: 'executedPassed', type: 'default', startEpoch: 1429, endEpoch: 1453, discussionsUrl: null },
        { id: 36, title: 'Adjust Shielded Set Rewards to Align with PMF Experiments.', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 1364, endEpoch: 1388, discussionsUrl: null },
        { id: 35, title: 'Whitelist tokens over the Osmosis IBC channel for Polaris in', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 1324, endEpoch: 1349, discussionsUrl: null },
        { id: 34, title: 'Update two gas parameter values', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 1289, endEpoch: 1309, discussionsUrl: null },
        { id: 33, title: 'Add USDN support to the MASP, whitelist USDN as a gas token,', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 1281, endEpoch: 1312, discussionsUrl: null },
        { id: 32, title: 'Update Shielded Inflation: MASP Gain Calibration & SSR Targe', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 1154, endEpoch: 1173, discussionsUrl: null },
        { id: 31, title: 'Reduce staking inflation from 5% to 2.75%', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 1154, endEpoch: 1173, discussionsUrl: null },
        { id: 30, title: 'Update tx_withdraw wasm on-chain', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 1073, endEpoch: 1097, discussionsUrl: null },
        { id: 29, title: 'cPGF - Namada Validator 1-Year Subsidy - 0.67% inflation', status: 'executedPassed', type: 'pgfFunding', startEpoch: 955, endEpoch: 979, discussionsUrl: null },
        { id: 28, title: 'Phase 4: enable shielding rewards', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 873, endEpoch: 891, discussionsUrl: null },
        { id: 27, title: 'Migrate shielded data ahead of shielded rewards (Phase 4)', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 825, endEpoch: 842, discussionsUrl: null },
        { id: 26, title: 'Phase 5 IBC transfers for NAM', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 783, endEpoch: 795, discussionsUrl: null },
        { id: 25, title: 'Begin Phase 5: enable internal NAM transfers within Namada', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 753, endEpoch: 765, discussionsUrl: null },
        { id: 24, title: 'Update the transfer tx in on-chain storage ahead of Phase 5', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 744, endEpoch: 756, discussionsUrl: null },
        { id: 23, title: 'Update the claim-rewards tx in on-chain storage ahead of Pha', status: 'executedPassed', type: 'defaultWithWasm', startEpoch: 740, endEpoch: 754, discussionsUrl: null },
      ],
      opened: [],
      closed: [],
    },
  },
  validators: {
    value: {
      // validator_daily: 2026-10-23 from the 00:10:02 UTC listing (height 8,380,347), 2026-10-22 from the 00:27:03 UTC one (8,367,878); names read 00:00:03 UTC
      today: { day: '2026-10-23', validators: 246, stake: 267749664.266631, asOf: 1792714202705, height: 8380347, namesAt: 1792713603334 },
      base: { day: '2026-10-22', validators: 246, stake: 267307557.266631, asOf: 1792628823324, height: 8367878, namesAt: 1792627202776 },
      noListingToday: false,
      joined: 0,
      left: 0,
      gross: 504213,
      movers: [
        { validator: 'tnam1qx405kgvey8wwfcyt7rgsr4nvkrqsnztxs2kz7wv', name: 'PathrockNetwork', state: 'consensus', d: 100000, delegatorsToday: 58, delegatorsBase: 57 },
        { validator: 'tnam1q8a2xwh072herrmlgf06gvrhna775sqjuufnxydn', name: 'Stake&Relax 🦥', state: 'consensus', d: 50000, delegatorsToday: 128, delegatorsBase: 128 },
        { validator: 'tnam1q8d8ypu5j88qqvx89grct795uap82dtlqvjqjh3h', name: 'MELLIFERA', state: 'consensus', d: 50000, delegatorsToday: 82, delegatorsBase: 81 },
        { validator: 'tnam1q8hck7594xqw9dz35m8wwtgtvdxf4xn0mg908r8x', name: 'OriginStake', state: 'consensus', d: 50000, delegatorsToday: 80, delegatorsBase: 79 },
        { validator: 'tnam1q96m7kwchdgzjk7dpvxkq3dxwzjhyjcggyuua5xf', name: 'StakeUp', state: 'consensus', d: 50000, delegatorsToday: 46, delegatorsBase: 45 },
        { validator: 'tnam1qx64zytr93rjj23ztf32y2rnrxwlm9j6svyznxez', name: 'CroutonDigital', state: 'consensus', d: 50000, delegatorsToday: 93, delegatorsBase: 93 },
      ],
      stateChanges: [],
    },
  },
});

/** The operator's figures at 08:00: kv source.health's 28 rows all ok, the 11 checks ok, 19 alert claims in the window. */
export const operator = (): OperatorFigures => ({
  health: { value: { ok: 28, total: 28, notOk: [] } },
  healthLog: { value: { firstAt: null, flips: [] } },
  checks: { value: { ok: 11, total: 11, failing: [] } },
  // 14 move claims, 5 of them bridge crossings (each also claimed per channel): 14 posts
  claims: { value: { n: 14, moves: 14, crossings: 5, firstAt: 1792656467877, lastAt: 1792722880139 } },
  skipped: null,
  previous: { last: null, missed: [] },
  channels: 1,
  subscribers: 0,
  watchCapWallets: 0,
});
