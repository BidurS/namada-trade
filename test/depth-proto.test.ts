// The protobuf behind the depth reads. The request bytes are checked against the URLs the research sent the chain node
// on 2026-10-29 02:17 UTC (fixtures/depth/reads_rpc.tsv and each sample's header: Query/Pool 0x08bd17, the two store
// prefixes 0x01|3005 and 0x09|3005, PositionById 0x08988cfb06 for 14599704). The decoders are held to bytes the chain
// sent: rpc_abci_batch_3005.json keeps the raw values of one batch (Query/Pool 3005, the tick store, the position index,
// then PositionById 14599704) at height 73,435,155, read 04:20 UTC on 29 Oct 2026, beside the REST gateway's JSON of the
// same height, and every decoded field is compared with the gateway's. The research's decoded samples are checked too:
// the store keys as the chain wrote them (rpc_store_subspace_*.json keep them as hex) and the messages re-encoded from
// the decoded answers and decoded back.
import { describe, it, expect } from 'vitest';
import {
  poolQuery, tickSubspaceQuery, positionIndexQuery, positionByIdQuery, batchBody, parseBatch, bytesToHex, hexToBytes,
  pbDecode, decodePool, decodeTickInfos, decodePositionIndex, decodePosition, decodePairs, tickOfKey, tickKey,
  encodePair, encodeTickInfo, encodePoolResponse, encodePositionResponse, scaledToDec, decToScaled, PATHS,
} from '../worker/src/depth/proto';
import { rangesFromTicks } from '../worker/src/depth/model';
import { base64Bytes, bytesToBase64 } from '../worker/src/util';
import { depthFixture, depthFixtureText, depthFixtureHeader, NAM_DENOM, USDC_DENOM } from './depth-fixtures';

const READS = depthFixtureText('reads_rpc.tsv').split('\n').filter((l) => l && !l.startsWith('#'));
const dataOf = (name: string): string => { const line = READS.find((l) => l.split('\t')[1] === name); return decodeURIComponent(line!.split('data=0x')[1]); };
const RPC_POOL = depthFixture<Record<string, string>>('rpc_pm_pool_3005.json');
const LCD_POOL = depthFixture<{ pool: Record<string, string> }>('lcd_pm_pool_3005.json').pool;
const TICKS = depthFixture<{ key_hex: string; tick_key_hex: string; liquidity_gross: string; liquidity_net: string }[]>('rpc_store_subspace_ticks_3005.json');
const INDEX = depthFixture<{ key_hex: string; value_hex: string }[]>('rpc_store_subspace_poolpos_3005.json');
const POSITIONS = depthFixture<any[]>('rpc_cl_positions_3005.json');
const concatBytes = (parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

describe('the request bytes are the ones the chain answered', () => {
  it('Query/Pool { pool_id: 3005 } is 08bd17', () => {
    expect(bytesToHex(poolQuery('3005').data)).toBe('08bd17');
    expect(dataOf('rpc_pm_pool_3005')).toBe('08bd17');
    expect(poolQuery(3005).path).toBe(PATHS.pool);
  });
  it('the tick store prefix is 0x01 | pool id as eight big-endian bytes, the position index 0x09 | the same', () => {
    expect(bytesToHex(tickSubspaceQuery('3005').data)).toBe('010000000000000bbd');
    expect(dataOf('rpc_store_subspace_ticks_3005')).toBe('010000000000000bbd');
    expect(bytesToHex(positionIndexQuery('3005').data)).toBe('090000000000000bbd');
    expect(dataOf('rpc_store_subspace_poolpos_3005')).toBe('090000000000000bbd');
    expect(tickSubspaceQuery('3005').path).toBe(PATHS.subspace);
  });
  it('PositionById { position_id } is a varint: 08988cfb06 for 14599704, and 15392963 as the log has it', () => {
    expect(bytesToHex(positionByIdQuery('14599704').data)).toBe('08988cfb06');
    expect(dataOf('rpc_cl_position_14599704')).toBe('08988cfb06');
    expect(bytesToHex(positionByIdQuery(15392963).data)).toBe(dataOf('rpc_cl_position_15392963'));
  });
  it('one batch body carries every query as its own abci_query, ids 1..n, data as hex, no proof', () => {
    const body = JSON.parse(batchBody([poolQuery('3005'), tickSubspaceQuery('3005'), positionIndexQuery('3005')]));
    expect(body.map((b: any) => b.id)).toEqual([1, 2, 3]);
    expect(body.every((b: any) => b.jsonrpc === '2.0' && b.method === 'abci_query' && b.params.prove === false)).toBe(true);
    expect(body[0].params).toEqual({ path: PATHS.pool, data: '08bd17', prove: false });
    expect(body[1].params.data).toBe('010000000000000bbd');
  });
  it('the batch answer is read by id, in the order asked, a missing answer as code -1', () => {
    const value = bytesToBase64(encodePoolResponse({ ...LCD_POOL, last_liquidity_update: Date.parse(LCD_POOL.last_liquidity_update) } as any));
    const text = JSON.stringify([
      { jsonrpc: '2.0', id: 2, result: { response: { code: 0, height: '73426894', value: '', log: '' } } },
      { jsonrpc: '2.0', id: 1, result: { response: { code: 0, height: '73426894', value } } },
      { jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'refused' } },
    ]);
    const a = parseBatch(text, 4);
    expect(a.map((x) => x.code)).toEqual([0, 0, -1, -1]);
    expect(a[0].height).toBe(73426894);
    expect(decodePool(a[0].value).id).toBe('3005');
    expect(a[1].value.length).toBe(0);
    expect(a[2].log).toBe('no answer in the batch');
    expect(a[3].log).toBe('refused');
  });
});

const CHAIN = depthFixture<any>('rpc_abci_batch_3005.json');
describe('the chain node’s own bytes (rpc_abci_batch_3005.json: height 73,435,155, 04:20 UTC on 29 Oct 2026) decode to the REST gateway’s JSON of the same height', () => {
  it('the fixture is one batch at one height, the gateway read at that height', () => {
    expect(depthFixtureHeader('rpc_abci_batch_3005.json')[0]).toContain('2026-10-29T04:20:47');
    expect(CHAIN.height).toBe(73435155);
    expect(Object.values(CHAIN.rpc).every((r: any) => r.height === 73435155 && r.code === 0)).toBe(true);
    expect(depthFixtureHeader('rpc_abci_batch_3005.json').filter((l) => l.includes('x-cosmos-block-height 73435155')).length).toBe(3);
  });
  it('Query/Pool: every field of the pool the gateway serves, from the node’s 512 bytes', () => {
    const bytes = base64Bytes(CHAIN.rpc.pool.value);
    expect(bytes.length).toBe(512);
    const p = decodePool(bytes);
    const g = CHAIN.rest.pool.pool;
    expect(p.typeUrl).toBe(g['@type']);
    expect(p.id).toBe(g.id);
    expect(p.address).toBe(g.address);
    expect(p.token0).toBe(g.token0);
    expect(p.token1).toBe(g.token1);
    expect(p.current_tick_liquidity).toBe(g.current_tick_liquidity);
    expect(p.current_sqrt_price).toBe(g.current_sqrt_price);
    expect(p.current_tick).toBe(g.current_tick);
    expect(p.tick_spacing).toBe(g.tick_spacing);
    expect(p.exponent_at_price_one).toBe(g.exponent_at_price_one);
    expect(p.spread_factor).toBe(g.spread_factor);
    expect(p.last_liquidity_update).toBe(Date.parse(g.last_liquidity_update));
    expect(p.token0).toBe(NAM_DENOM);
    // the pool had not traded since the research read it at 02:55 UTC: the same sqrt price to the last digit
    expect(p.current_sqrt_price).toBe(depthFixture<any>('verify-pool3005-now.json').pool.current_sqrt_price);
  });
  it('the tick store: the node’s 6,893 bytes walked with liquidity_net are the gateway’s liquidity_per_tick_range, string for string', () => {
    const bytes = base64Bytes(CHAIN.rpc.ticks.value);
    expect(bytes.length).toBe(6893);
    const ticks = decodeTickInfos(bytes);
    expect(ticks.length).toBe(32);
    expect(ticks.reduce((a, t) => a + decToScaled(t.liquidity_net, 18), 0n)).toBe(0n);
    const ranges = rangesFromTicks(ticks);
    const g = CHAIN.rest.ranges.liquidity;
    expect(ranges.length).toBe(g.length);
    expect(ranges.map((r) => [String(r.lower_tick), String(r.upper_tick), r.liquidity_amount])).toEqual(g.map((r: any) => [r.lower_tick, r.upper_tick, r.liquidity_amount]));
    const ct = Number(CHAIN.rest.pool.pool.current_tick);
    expect(ranges.find((r) => Number(r.lower_tick) <= ct && ct < Number(r.upper_tick))?.liquidity_amount).toBe(CHAIN.rest.pool.pool.current_tick_liquidity);
    // every key is the chain's: the pool's prefix, the sort byte, the tick
    for (const t of ticks) expect(bytesToHex(tickKey('3005', t.tick)).slice(0, 18)).toBe('010000000000000bbd');
  });
  it('the position index: the keys under 0x09|3005 name the positions, the first of them the one read', () => {
    const ids = decodePositionIndex(base64Bytes(CHAIN.rpc.index.value));
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).toBe(CHAIN.rpc.position.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^\d+$/.test(id))).toBe(true);
  });
  it('PositionById: the position, its assets and its rewards as the gateway serves them, from the node’s 455 bytes', () => {
    const bytes = base64Bytes(CHAIN.rpc.position.value);
    expect(bytes.length).toBe(455);
    const p = decodePosition(bytes);
    const g = CHAIN.rest.position.position;
    expect(p.position_id).toBe(g.position.position_id);
    expect(p.address).toBe(g.position.address);
    expect(p.pool_id).toBe('3005');
    expect(p.lower_tick).toBe(Number(g.position.lower_tick));
    expect(p.upper_tick).toBe(Number(g.position.upper_tick));
    expect(p.liquidity).toBe(g.position.liquidity);
    expect(p.join_time).toBe(Date.parse(g.position.join_time));
    expect(p.asset0).toEqual(g.asset0);
    expect(p.asset1).toEqual(g.asset1);
    expect(p.claimable_spread_rewards).toEqual(g.claimable_spread_rewards);
    expect(p.claimable_incentives).toEqual(g.claimable_incentives);
    expect(p.lower_tick).toBe(-108_000_000);
    expect(p.upper_tick).toBe(342_000_000);
  });
  it('parseBatch reads a batch of these answers by id and hands the decoders the same bytes', () => {
    const text = JSON.stringify([
      { jsonrpc: '2.0', id: 2, result: { response: { code: 0, height: String(CHAIN.height), value: CHAIN.rpc.ticks.value } } },
      { jsonrpc: '2.0', id: 1, result: { response: { code: 0, height: String(CHAIN.height), value: CHAIN.rpc.pool.value } } },
    ]);
    const a = parseBatch(text, 2);
    expect(decodePool(a[0].value).id).toBe('3005');
    expect(decodeTickInfos(a[1].value).length).toBe(32);
    expect(bytesToBase64(a[1].value)).toBe(CHAIN.rpc.ticks.value);
  });
});

describe('the base64 helpers the depth reads use (worker/src/util.ts): a loop each way, the padded form btoa gives', () => {
  it('bytes to base64 agrees with btoa for every remainder, and a long array works where a spread would not', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 300]) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      expect(bytesToBase64(b)).toBe(btoa(String.fromCharCode(...b)));
      expect(base64Bytes(bytesToBase64(b))).toEqual(b);
    }
    const long = Uint8Array.from({ length: 1_000_000 }, (_, i) => i & 0xff);
    const s = bytesToBase64(long);
    expect(s.length).toBe(Math.ceil(1_000_000 / 3) * 4);
    expect(base64Bytes(s)).toEqual(long);
  });
});

describe('decoding the answers', () => {
  it('Query/Pool: the concentrated pool’s fields come back as the REST gateway spells them (decimal strings, int64 ticks)', () => {
    const value = encodePoolResponse({ ...LCD_POOL, last_liquidity_update: Date.parse(LCD_POOL.last_liquidity_update) } as any);
    const p = decodePool(value);
    expect(p.typeUrl).toBe('/osmosis.concentratedliquidity.v1beta1.Pool');
    expect(p.id).toBe('3005');
    expect(p.token0).toBe(NAM_DENOM);
    expect(p.token1).toBe(USDC_DENOM);
    expect(p.current_sqrt_price).toBe(LCD_POOL.current_sqrt_price);
    expect(p.current_sqrt_price).toBe('0.031935379420358432301010285098659131');
    expect(p.current_tick_liquidity).toBe(LCD_POOL.current_tick_liquidity);
    expect(p.current_tick).toBe('-26980132');
    expect(p.tick_spacing).toBe('100');
    expect(p.exponent_at_price_one).toBe('-6');
    expect(p.spread_factor).toBe('0.002000000000000000');
    expect(p.last_liquidity_update).toBe(Date.parse('2026-10-28T14:49:51.062Z'));
    // the wire integers the chain node sent (rpc_pm_pool_3005.json) are the same figures scaled by 1e18 and 1e36
    expect(scaledToDec(RPC_POOL.current_tick_liquidity, 18)).toBe(p.current_tick_liquidity);
    expect(scaledToDec(RPC_POOL.current_sqrt_price, 36)).toBe(p.current_sqrt_price);
    expect(scaledToDec(RPC_POOL.spread_factor, 18)).toBe(p.spread_factor);
    expect(RPC_POOL.last_liquidity_update).toBe('unix 1793198991.62590774');
  });
  it('a pool of another type is refused by its type url', () => {
    const value = encodePoolResponse({ ...LCD_POOL, typeUrl: '/osmosis.gamm.v1beta1.Pool', last_liquidity_update: null } as any);
    expect(() => decodePool(value)).toThrow(/not a concentrated-liquidity pool/);
  });
  it('the tick store: 32 TickInfo pairs under 0x01|3005, keys as the chain wrote them, liquidity as 18-decimal strings, ascending', () => {
    const pairs = TICKS.map((t) => encodePair(hexToBytes(t.key_hex), encodeTickInfo(scaledToDec(t.liquidity_gross, 18), scaledToDec(t.liquidity_net, 18))));
    const value = concatBytes(pairs);
    expect(decodePairs(value).length).toBe(32);
    const ticks = decodeTickInfos(value);
    expect(ticks.length).toBe(32);
    expect(ticks[0]).toEqual({ tick: -108_000_000, liquidity_gross: '5069118449.895769695695682858', liquidity_net: '5069118449.895769695695682858' });
    expect(ticks[ticks.length - 1].tick).toBe(342_000_000);
    expect(ticks.every((t, i) => i === 0 || t.tick > ticks[i - 1].tick)).toBe(true);
    // the net liquidity over the whole map is zero: every position adds at its lower tick what it takes at its upper
    expect(ticks.reduce((a, t) => a + decToScaled(t.liquidity_net, 18), 0n)).toBe(0n);
  });
  it('a tick key is 0x01 | pool id | a sort byte (0x05 negative, 0x06 not) | the tick as int64 big-endian: the chain’s own keys come back from tickKey', () => {
    expect(bytesToHex(tickKey('3005', -108_000_000))).toBe('010000000000000bbd05fffffffff9900d00');
    expect(bytesToHex(tickKey('3005', -108_000_000))).toBe(TICKS[0].key_hex);
    for (const t of TICKS) expect(bytesToHex(tickKey('3005', tickOfKey(hexToBytes(t.key_hex))))).toBe(t.key_hex);
    expect(tickOfKey(hexToBytes('010000000000000bbd05fffffffff9900d00'))).toBe(-108_000_000);
  });
  it('the pool-to-position index: 19 keys 0x09 | 3005 | "|" | position id, the ids of the 19 positions read', () => {
    const value = concatBytes(INDEX.map((k) => encodePair(hexToBytes(k.key_hex), hexToBytes(k.value_hex))));
    const ids = decodePositionIndex(value);
    expect(ids.length).toBe(19);
    expect(ids[0]).toBe('14599704');
    expect(INDEX[0].key_hex).toBe('090000000000000bbd7c0000000000dec618');
    expect(ids).toEqual(POSITIONS.map((p) => p.position_id));
    expect(decodePositionIndex(new Uint8Array(0))).toEqual([]);
  });
  it('PositionById: the position, its two assets and its rewards round-trip, the ticks as signed int64', () => {
    const src = POSITIONS.find((p) => p.position_id === '15392963');
    const wire = {
      position_id: src.position_id, address: src.address, pool_id: src.pool_id, lower_tick: Number(src.lower_tick), upper_tick: Number(src.upper_tick),
      join_time: src.join_time_unix * 1000, liquidity: scaledToDec(src.liquidity, 18), asset0: src.asset0, asset1: src.asset1,
      claimable_spread_rewards: src.claimable_spread_rewards, claimable_incentives: src.claimable_incentives,
    };
    const p = decodePosition(encodePositionResponse(wire));
    expect(p).toEqual(wire);
    expect(p.lower_tick).toBe(-28_500_000);
    expect(p.upper_tick).toBe(-26_650_000);
    expect(p.liquidity).toBe('6353092755.962217234850521312');
    expect(src.liquidity).toBe('6353092755962217234850521312');
    expect(p.asset0).toEqual({ denom: NAM_DENOM, amount: '26026594582' });
    expect(p.asset1).toEqual({ denom: USDC_DENOM, amount: '17665537' });
  });
  it('pbDecode reads varints, length-delimited fields and the two fixed widths, and refuses a wire type it does not know', () => {
    const fs = pbDecode(hexToBytes('08bd17' + '1203616263' + '19' + '0100000000000000' + '2d' + '02000000'));
    expect(fs.map((f) => [f.f, f.w])).toEqual([[1, 0], [2, 2], [3, 1], [5, 5]]);
    expect(fs[0].v).toBe(3005n);
    expect(new TextDecoder().decode(fs[1].v as Uint8Array)).toBe('abc');
    expect(fs[2].v).toBe(1n);
    expect(fs[3].v).toBe(2);
    expect(() => pbDecode(hexToBytes('0b'))).toThrow(/wire type 3/);
  });
  it('scaled integers and decimal strings round-trip at 18 and 36 decimals, negatives included', () => {
    expect(scaledToDec('2000000000000000', 18)).toBe('0.002000000000000000');
    expect(decToScaled('0.002', 18)).toBe(2000000000000000n);
    expect(decToScaled('12182537984.214367314128069678', 18).toString()).toBe('12182537984214367314128069678');
    expect(scaledToDec('-5949796552322352618329331905', 18)).toBe('-5949796552.322352618329331905');
    expect(decToScaled('-5949796552.322352618329331905', 18).toString()).toBe('-5949796552322352618329331905');
    expect(decToScaled(scaledToDec('31935379420358432301010285098659131', 36), 36).toString()).toBe('31935379420358432301010285098659131');
    expect(scaledToDec('7', 18)).toBe('0.000000000000000007');
  });
});
