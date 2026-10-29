// The protobuf the depth reads need, by hand and read-only: the request bodies of the chain node's abci_query for
// poolmanager Query/Pool, concentrated-liquidity PositionById and the two store subspaces (the tick map 0x01|poolId and
// the pool-to-position index 0x09|poolId), the JSON-RPC batch that carries them in one POST, and the decoders of their
// answers. Field numbers are the ones the research read the chain's answers with (scratchpad depth/proto.mjs,
// cl3005.mjs, positions3005.mjs on 2026-10-29): a Pool is 1 address, 2 incentives_address, 3 spread_rewards_address,
// 4 id, 5 current_tick_liquidity, 6 token0, 7 token1, 8 current_sqrt_price, 9 current_tick, 10 tick_spacing,
// 11 exponent_at_price_one, 12 spread_factor, 13 last_liquidity_update; a Position is 1 position_id, 2 address,
// 3 pool_id, 4 lower_tick, 5 upper_tick, 6 join_time, 7 liquidity, inside a FullPositionBreakdown with 2 asset0,
// 3 asset1, 4 claimable_spread_rewards, 5 claimable_incentives. Decimals travel as integer strings scaled by 1e18
// (Dec) or 1e36 (BigDec, the sqrt price); the decoders give them back as decimal strings, the shape the REST gateway
// serves, so one model reads both.
// Workers have no Buffer: everything here is Uint8Array; base64 goes through util.ts's loop decoders, never atob or a spread.
import { base64Bytes } from '../util';

export interface PbField {
  f: number;
  w: number;
  v: bigint | Uint8Array | number;
}

const te = new TextEncoder();
const td = new TextDecoder();

export const hexToBytes = (hex: string): Uint8Array => {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
export const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// ---------------------------------------------------------------------------------------------------- encode
export const varint = (n: bigint | number): Uint8Array => {
  let v = BigInt(n);
  const b: number[] = [];
  while (v >= 0x80n) { b.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  b.push(Number(v));
  return Uint8Array.from(b);
};
/** A uint64 field. */
export const fU64 = (f: number, n: bigint | number): Uint8Array => concat(varint((f << 3) | 0), varint(n));
/** A bytes or string field. */
export const fBytes = (f: number, b: Uint8Array): Uint8Array => concat(varint((f << 3) | 2), varint(b.length), b);
export const fStr = (f: number, s: string): Uint8Array => fBytes(f, te.encode(s));
/** A uint64 as eight big-endian bytes: how the store keys carry a pool id. */
export const u64be = (n: bigint | number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};

export interface AbciQuery {
  path: string;
  data: Uint8Array;
}
export const PATHS = {
  pool: '/osmosis.poolmanager.v1beta1.Query/Pool',
  positionById: '/osmosis.concentratedliquidity.v1beta1.Query/PositionById',
  subspace: '/store/concentratedliquidity/subspace',
} as const;
export const TICK_PREFIX = 0x01;
export const POSITION_INDEX_PREFIX = 0x09;

/** poolmanager Query/Pool { pool_id = 1 }: 0x08bd17 for pool 3005. */
export const poolQuery = (poolId: string | number): AbciQuery => ({ path: PATHS.pool, data: fU64(1, BigInt(poolId)) });
/** The tick map of a pool: every TickInfo under 0x01|poolId. */
export const tickSubspaceQuery = (poolId: string | number): AbciQuery => ({ path: PATHS.subspace, data: concat(Uint8Array.of(TICK_PREFIX), u64be(BigInt(poolId))) });
/** The pool-to-position index: every key under 0x09|poolId, the position id in its last eight bytes. */
export const positionIndexQuery = (poolId: string | number): AbciQuery => ({ path: PATHS.subspace, data: concat(Uint8Array.of(POSITION_INDEX_PREFIX), u64be(BigInt(poolId))) });
/** concentrated-liquidity Query/PositionById { position_id = 1 }. */
export const positionByIdQuery = (positionId: string | number): AbciQuery => ({ path: PATHS.positionById, data: fU64(1, BigInt(positionId)) });

/** One JSON-RPC batch body: every query an abci_query with its own id, so one POST answers all at one height. */
export const batchBody = (queries: AbciQuery[]): string =>
  JSON.stringify(queries.map((q, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'abci_query', params: { path: q.path, data: bytesToHex(q.data), prove: false } })));

export interface AbciAnswer {
  code: number;
  height: number | null;
  log: string;
  value: Uint8Array;
}
/** The batch's answers in the order asked; a missing answer is code -1 with an empty value. */
export function parseBatch(text: string, n: number): AbciAnswer[] {
  const arr = JSON.parse(text);
  const list: any[] = Array.isArray(arr) ? arr : [arr];
  const byId = new Map<number, any>(list.map((a) => [Number(a?.id), a?.result?.response ?? (a?.error ? { code: -1, log: String(a.error?.message ?? a.error) } : {})]));
  return Array.from({ length: n }, (_, i) => {
    const r = byId.get(i + 1);
    if (!r) return { code: -1, height: null, log: 'no answer in the batch', value: new Uint8Array(0) };
    return { code: Number(r.code ?? 0), height: r.height ? Number(r.height) : null, log: String(r.log ?? ''), value: r.value ? base64Bytes(r.value) : new Uint8Array(0) };
  });
}

// ---------------------------------------------------------------------------------------------------- decode
export function pbDecode(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  const rv = (): bigint => {
    let s = 0n, r = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('varint past the end');
      const b = buf[i++];
      r |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return r;
      s += 7n;
    }
  };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (i < buf.length) {
    const k = rv();
    const f = Number(k >> 3n), w = Number(k & 7n);
    if (w === 0) out.push({ f, w, v: rv() });
    else if (w === 2) { const l = Number(rv()); out.push({ f, w, v: buf.subarray(i, i + l) }); i += l; }
    else if (w === 1) { out.push({ f, w, v: dv.getBigUint64(i, true) }); i += 8; }
    else if (w === 5) { out.push({ f, w, v: dv.getUint32(i, true) }); i += 4; }
    else throw new Error('wire type ' + w);
  }
  return out;
}
const str = (v: PbField['v'] | undefined, dflt = ''): string => (v === undefined ? dflt : v instanceof Uint8Array ? td.decode(v) : String(v));
const bytes = (v: PbField['v']): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(0));
const int64 = (v: PbField['v']): bigint => BigInt.asIntN(64, typeof v === 'bigint' ? v : BigInt(v as number));
const field = (fs: PbField[], f: number): PbField | undefined => fs.find((x) => x.f === f);

/** An integer string scaled by 10^scale (the wire form of Dec and BigDec) as a decimal string. */
export function scaledToDec(int: string, scale: number): string {
  const neg = int.startsWith('-');
  const digits = (neg ? int.slice(1) : int).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale), frac = digits.slice(digits.length - scale);
  return `${neg ? '-' : ''}${whole}.${frac}`;
}
/** A decimal string as a BigInt scaled by 10^scale (truncating digits past the scale). "0.002" at 18 is 2000000000000000n. */
export function decToScaled(dec: string, scale: number): bigint {
  const s = dec.trim();
  const neg = s.startsWith('-');
  const [w, f = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt((w || '0') + f.slice(0, scale).padEnd(scale, '0'));
  return neg ? -v : v;
}

const timestampMs = (v: Uint8Array): number | null => {
  const t = pbDecode(v);
  const s = field(t, 1), ns = field(t, 2);
  if (!s) return null;
  return Number(int64(s.v)) * 1000 + (ns ? Math.floor(Number(ns.v) / 1e6) : 0);
};

export interface ClPoolWire {
  typeUrl: string;
  id: string;
  address: string;
  token0: string;
  token1: string;
  current_tick_liquidity: string;
  current_sqrt_price: string;
  current_tick: string;
  tick_spacing: string;
  exponent_at_price_one: string;
  spread_factor: string;
  /** unix ms */
  last_liquidity_update: number | null;
}
/** QueryPoolResponse { pool: Any = 1 } for a concentrated-liquidity pool. Throws for another pool type (the Any names it). */
export function decodePool(value: Uint8Array): ClPoolWire {
  const any = pbDecode(bytes(field(pbDecode(value), 1)?.v ?? new Uint8Array(0)));
  const typeUrl = str(field(any, 1)?.v);
  if (!typeUrl.includes('concentratedliquidity')) throw new Error(`not a concentrated-liquidity pool: ${typeUrl || 'no type'}`);
  const p = pbDecode(bytes(field(any, 2)?.v ?? new Uint8Array(0)));
  const s = (f: number) => str(field(p, f)?.v);
  const u = (f: number) => String(field(p, f)?.v ?? '0');
  const i = (f: number) => int64(field(p, f)?.v ?? 0n).toString();
  const ts = field(p, 13);
  return {
    typeUrl, id: u(4), address: s(1), token0: s(6), token1: s(7),
    current_tick_liquidity: scaledToDec(s(5), 18), current_sqrt_price: scaledToDec(s(8), 36), current_tick: i(9),
    tick_spacing: u(10), exponent_at_price_one: i(11), spread_factor: scaledToDec(s(12), 18),
    last_liquidity_update: ts ? timestampMs(bytes(ts.v)) : null,
  };
}

/** The pairs of a store subspace answer: { pairs: repeated Pair { key = 1, value = 2 } = 1 }. */
export function decodePairs(value: Uint8Array): { key: Uint8Array; value: Uint8Array }[] {
  if (!value.length) return [];
  return pbDecode(value).filter((x) => x.f === 1).map((pr) => {
    const kv = pbDecode(bytes(pr.v));
    return { key: bytes(field(kv, 1)?.v ?? new Uint8Array(0)), value: bytes(field(kv, 2)?.v ?? new Uint8Array(0)) };
  });
}

export interface TickInfoWire {
  tick: number;
  liquidity_gross: string;
  liquidity_net: string;
}
/** The tick's index from a tick-store key 0x01 | poolId(8) | sort byte | tick (int64 big-endian, two's complement). */
export const tickOfKey = (key: Uint8Array): number => Number(new DataView(key.buffer, key.byteOffset + key.length - 8, 8).getBigInt64(0));
/** The tick map: every initialized tick with its liquidity_gross and liquidity_net (decimal strings), ascending. */
export function decodeTickInfos(value: Uint8Array): TickInfoWire[] {
  return decodePairs(value).map(({ key, value: v }) => {
    const t = pbDecode(v);
    return { tick: tickOfKey(key), liquidity_gross: scaledToDec(str(field(t, 1)?.v, '0'), 18), liquidity_net: scaledToDec(str(field(t, 2)?.v, '0'), 18) };
  }).sort((a, b) => a.tick - b.tick);
}

/** The position ids of the pool-to-position index: 0x09 | poolId(8) | '|' | positionId(8). */
export const decodePositionIndex = (value: Uint8Array): string[] => decodePairs(value).map(({ key }) => new DataView(key.buffer, key.byteOffset + key.length - 8, 8).getBigUint64(0).toString());

export interface CoinWire {
  denom: string;
  amount: string;
}
export interface PositionWire {
  position_id: string;
  address: string;
  pool_id: string;
  lower_tick: number;
  upper_tick: number;
  /** unix ms */
  join_time: number | null;
  liquidity: string;
  asset0: CoinWire | null;
  asset1: CoinWire | null;
  claimable_spread_rewards: CoinWire[];
  claimable_incentives: CoinWire[];
}
const coin = (v: Uint8Array): CoinWire => { const c = pbDecode(v); return { denom: str(field(c, 1)?.v), amount: str(field(c, 2)?.v, '0') }; };
/** QueryPositionByIdResponse { position: FullPositionBreakdown = 1 }. */
export function decodePosition(value: Uint8Array): PositionWire {
  const fb = pbDecode(bytes(field(pbDecode(value), 1)?.v ?? new Uint8Array(0)));
  const pos = pbDecode(bytes(field(fb, 1)?.v ?? new Uint8Array(0)));
  const g = (f: number) => field(pos, f);
  const coins = (f: number) => fb.filter((x) => x.f === f).map((x) => coin(bytes(x.v)));
  const jt = g(6);
  return {
    position_id: String(g(1)?.v ?? '0'), address: str(g(2)?.v), pool_id: String(g(3)?.v ?? '0'),
    lower_tick: Number(int64(g(4)?.v ?? 0n)), upper_tick: Number(int64(g(5)?.v ?? 0n)),
    join_time: jt ? timestampMs(bytes(jt.v)) : null, liquidity: scaledToDec(str(g(7)?.v, '0'), 18),
    asset0: field(fb, 2) ? coin(bytes(field(fb, 2)!.v)) : null, asset1: field(fb, 3) ? coin(bytes(field(fb, 3)!.v)) : null,
    claimable_spread_rewards: coins(4), claimable_incentives: coins(5),
  };
}

// ---------------------------------------------------------------------------------------------------- encode the answers (tests and fixtures)
/** A Pair message, as the store packs each key and value. */
export const encodePair = (key: Uint8Array, value: Uint8Array): Uint8Array => fBytes(1, concat(fBytes(1, key), fBytes(2, value)));
/** A TickInfo from its two decimal strings (the fields the depth reads). */
export const encodeTickInfo = (liquidityGross: string, liquidityNet: string): Uint8Array =>
  concat(fStr(1, decToScaled(liquidityGross, 18).toString()), fStr(2, decToScaled(liquidityNet, 18).toString()));
/** A tick-store key: 0x01 | poolId(8) | 0x05 for a negative tick or 0x06 for a tick at or above zero | tick(8, big-endian two's complement). */
export const tickKey = (poolId: string | number, tick: number): Uint8Array => {
  const t = new Uint8Array(8);
  new DataView(t.buffer).setBigInt64(0, BigInt(tick));
  return concat(Uint8Array.of(TICK_PREFIX), u64be(BigInt(poolId)), Uint8Array.of(tick < 0 ? 0x05 : 0x06), t);
};
const encodeTimestamp = (ms: number): Uint8Array => concat(fU64(1, BigInt(Math.floor(ms / 1000))), fU64(2, BigInt(Math.round((ms % 1000) * 1e6))));
const encodeCoin = (c: CoinWire): Uint8Array => concat(fStr(1, c.denom), fStr(2, c.amount));
const fI64 = (f: number, n: bigint | number): Uint8Array => fU64(f, BigInt.asUintN(64, BigInt(n)));
/** A QueryPoolResponse carrying a concentrated-liquidity Pool, from the REST gateway's shape of it. */
export function encodePoolResponse(p: Omit<ClPoolWire, 'typeUrl'> & { typeUrl?: string }): Uint8Array {
  const pool = concat(
    fStr(1, p.address), fU64(4, BigInt(p.id)), fStr(5, decToScaled(p.current_tick_liquidity, 18).toString()), fStr(6, p.token0), fStr(7, p.token1),
    fStr(8, decToScaled(p.current_sqrt_price, 36).toString()), fI64(9, BigInt(p.current_tick)), fU64(10, BigInt(p.tick_spacing)),
    fI64(11, BigInt(p.exponent_at_price_one)), fStr(12, decToScaled(p.spread_factor, 18).toString()),
    ...(p.last_liquidity_update != null ? [fBytes(13, encodeTimestamp(p.last_liquidity_update))] : []),
  );
  return fBytes(1, concat(fStr(1, p.typeUrl ?? '/osmosis.concentratedliquidity.v1beta1.Pool'), fBytes(2, pool)));
}
/** A QueryPositionByIdResponse from a decoded position. */
export function encodePositionResponse(p: PositionWire): Uint8Array {
  const pos = concat(
    fU64(1, BigInt(p.position_id)), fStr(2, p.address), fU64(3, BigInt(p.pool_id)), fI64(4, p.lower_tick), fI64(5, p.upper_tick),
    ...(p.join_time != null ? [fBytes(6, encodeTimestamp(p.join_time))] : []), fStr(7, decToScaled(p.liquidity, 18).toString()),
  );
  return fBytes(1, concat(
    fBytes(1, pos), ...(p.asset0 ? [fBytes(2, encodeCoin(p.asset0))] : []), ...(p.asset1 ? [fBytes(3, encodeCoin(p.asset1))] : []),
    ...p.claimable_spread_rewards.map((c) => fBytes(4, encodeCoin(c))), ...p.claimable_incentives.map((c) => fBytes(5, encodeCoin(c))),
  ));
}
