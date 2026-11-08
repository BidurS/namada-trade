// A protocol balance with no value (2026-11-02, sources/namada.ts namProtocolBalance): Namada answers a key it holds nothing for with code 0,
// no value and "No value found for key …" (a never-used address's balance key answered so on 2026-11-02), and that
// decodes to 0. The staking account, the bridge escrow, the shielded pool and public funding always hold a balance,
// and the minted total always exists, so the cron's reads of them now refuse such an answer at its node and ask the
// next one, as the epoch read does (test/review-g-epoch-answer.test.ts); with every node answering so the read fails
// and is stored as not read, never as 0. A holder's balance still reads a missing key as 0: a fresh address has none.
// The mint rule's keys are read at the block it judges, and a node's answer for another block is refused the same way.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { namBalance, namProtocolBalance, namTotalSupply, namadaEpochRead, mintKeysAt, decString, AbciCodeError, RpcBreaker, QUICK } from '../worker/src/sources/namada';
import { NAMADA } from '../worker/src/config';
import { app } from '../worker/src/api';
import { testD1, insert } from './d1-sqlite';

afterEach(() => { vi.unstubAllGlobals(); });

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const rpcs = [{ provider: 'A', url: 'https://a.example' }, { provider: 'B', url: 'https://b.example' }];
const bytesB64 = (b: number[]) => btoa(String.fromCharCode(...b));
const u256 = (n: bigint) => { const b: number[] = []; let v = n; for (let i = 0; i < 32; i++) { b.push(Number(v & 0xffn)); v >>= 8n; } return bytesB64(b); };
const u64 = (n: number) => bytesB64([n & 0xff, (n >> 8) & 0xff, 0, 0, 0, 0, 0, 0]);
const NO_VALUE = { result: { response: { code: 0, value: null, info: 'No value found for key: …', height: '8516662' } } };
const answer = (value: string, height = '8516662') => ({ result: { response: { code: 0, value, height } } });

function nodes(reply: (node: 'A' | 'B', path: string, url: string) => unknown) {
  const asked: { node: string; path: string; url: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const node = url.startsWith('https://a.example') ? 'A' : 'B';
    const path = decodeURIComponent((url.split('path=')[1] ?? '').split('&')[0]).replace(/^"|"$/g, '');
    asked.push({ node, path, url });
    return json(reply(node, path, url));
  }));
  return asked;
}

describe('a protocol balance answered without a value', () => {
  it('is refused at that node: the next node is asked, and the first is put last', async () => {
    const asked = nodes((node) => (node === 'A' ? NO_VALUE : answer(u256(31_618_419_065_539n))));
    const breaker = new RpcBreaker();
    expect(await namProtocolBalance(NAMADA.internal.masp, { ...QUICK, rpcs, breaker })).toEqual({ balance: 31_618_419_065_539n, height: 8516662, provider: 'B' });
    expect(asked.map((a) => a.node)).toEqual(['A', 'B']);
    expect(breaker.failures('A')).toBe(1);
  });

  for (const [what, reply, why] of [
    ['no value', NO_VALUE, 'answered without a value'],
    ['an empty value', answer(''), 'answered without a value'],
    ['a value that is not 32 bytes', answer(u64(5)), 'answered a value that is not an amount'],
  ] as const) {
    it(`(${what}) from every node is a failed read, never 0`, async () => {
      const asked = nodes(() => reply);
      await expect(namProtocolBalance(NAMADA.internal.pos, { ...QUICK, rpcs })).rejects.toThrow(`B ${why}`);
      expect(asked.map((a) => a.node)).toEqual(['A', 'B']);
    });
  }

  it('an error code is still an answer about the query, from the first node', async () => {
    const asked = nodes(() => ({ result: { response: { code: 1, info: 'storage error', value: null, height: '9' } } }));
    await expect(namProtocolBalance(NAMADA.internal.pgf, { ...QUICK, rpcs })).rejects.toBeInstanceOf(AbciCodeError);
    expect(asked.map((a) => a.node)).toEqual(['A']);
  });

  it('every reason a read fails for names the key short, so a health note of 160 characters keeps the reason', async () => {
    const key = '/shell/value/#tnam1pyqqq…/#tnam1q9gr6…/balance/#tnam1pgqqq…';
    nodes(() => ({ result: { response: { code: 1, info: 'storage error', value: null, height: '9' } } }));
    const coded = await namProtocolBalance(NAMADA.internal.pgf, { ...QUICK, rpcs }).catch((e) => e);
    expect(coded).toBeInstanceOf(AbciCodeError);
    expect(coded.message).toBe(`abci ${key} code 1: storage error`);
    // the error keeps the whole key for its readers
    expect(coded.path).toContain(NAMADA.internal.pgf);
    await expect(namProtocolBalance(NAMADA.internal.pgf, { ...QUICK, rpcs: [] })).rejects.toThrow(`abci ${key}: no node on this chain to ask`);
    const gone = new AbortController();
    gone.abort();
    await expect(namProtocolBalance(NAMADA.internal.pgf, { ...QUICK, rpcs, signal: gone.signal })).rejects.toThrow(`abci ${key}: deadline passed`);
    for (const m of [coded.message, `abci ${key}: deadline passed`]) expect(`Error: ${m}`.length).toBeLessThan(160);
  });

  it("the minted total is refused the same way, and its read names the node's block", async () => {
    const asked = nodes((node) => (node === 'A' ? NO_VALUE : answer(u256(1_148_754_488_433_455n), '8516658')));
    expect(await namTotalSupply({ ...QUICK, rpcs })).toEqual({ supply: 1_148_754_488_433_455n, height: 8516658, provider: 'B' });
    expect(asked.map((a) => a.node)).toEqual(['A', 'B']);
    nodes(() => NO_VALUE);
    await expect(namTotalSupply({ ...QUICK, rpcs })).rejects.toThrow('abci /shell/value/#tnam1pyqqq…/#tnam1q9gr6…/balance/minted: B answered without a value');
  });

  it("a holder's balance with no value is still 0, from the first node: an address that never held NAM has no key", async () => {
    const asked = nodes(() => NO_VALUE);
    expect(await namBalance('tnam1qxyz', { ...QUICK, rpcs })).toEqual({ balance: 0n, height: 8516662, provider: 'A' });
    expect(asked.map((a) => a.node)).toEqual(['A']);
  });

  it("the epoch read names the node's block, so the mint rule can tell it was read with the minted total", async () => {
    nodes(() => answer(u64(2738), '8516658'));
    expect(await namadaEpochRead({ ...QUICK, rpcs })).toEqual({ epoch: 2738, height: 8516658, provider: 'A' });
  });
});

describe("the mint rule's keys, read at the block it judges", () => {
  // the values 5ElementsNodes answered on 2026-11-02 (block 8,516,658 and later)
  const LIVE: Record<string, string> = {
    last_inflation_amount: u256(19_961_144_868n),
    pgf_inflation_rate: u256(0n),
    steward_inflation_rate: u256(0n),
    masp_epoch_multiplier: u64(4),
  };
  const keyOf = (path: string) => path.split('/').pop()!;

  it('asks each key at the block, from the staking, public-funding and parameters accounts, and decodes the chain\'s values', async () => {
    const asked = nodes((_, path, url) => answer(LIVE[keyOf(path)], new URL(url).searchParams.get('height')!));
    expect(await mintKeysAt(8516658, { ...QUICK, rpcs })).toEqual({ lastInflationBase: 19_961_144_868n, pgfRate: '0', stewardRate: '0', maspEpochMultiplier: 4, height: 8516658, provider: 'A' });
    expect(asked.map((a) => a.path)).toEqual([
      `/shell/value/#${NAMADA.internal.pos}/last_inflation_amount`,
      `/shell/value/#${NAMADA.internal.pgf}/pgf_inflation_rate`,
      `/shell/value/#${NAMADA.internal.pgf}/steward_inflation_rate`,
      // InternalAddress::Parameters, raw discriminant 4
      '/shell/value/#tnam1qsqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqxdl54l/masp_epoch_multiplier',
    ]);
    expect(asked.every((a) => new URL(a.url).searchParams.get('height') === '8516658')).toBe(true);
  });

  it('a node that answers for another block, with an error code, or without a value is refused there and the next node asked', async () => {
    for (const bad of [answer(LIVE.last_inflation_amount, '8516700'), { result: { response: { code: 1, info: 'Cannot query more than 3600 blocks in the past', value: null, height: '0' } } }, NO_VALUE]) {
      const asked = nodes((node, path, url) => (node === 'A' && keyOf(path) === 'last_inflation_amount' ? bad : answer(LIVE[keyOf(path)], new URL(url).searchParams.get('height')!)));
      expect((await mintKeysAt(8516658, { ...QUICK, rpcs })).lastInflationBase).toBe(19_961_144_868n);
      expect(asked.slice(0, 2).map((a) => a.node)).toEqual(['A', 'B']);
    }
  });

  it('with every node refusing, the read fails: the rule says the step was not read, never a guess', async () => {
    nodes((_, path) => (keyOf(path) === 'masp_epoch_multiplier' ? answer(u64(0), '8516658') : answer(LIVE[keyOf(path)], '8516658')));
    await expect(mintKeysAt(8516658, { ...QUICK, rpcs })).rejects.toThrow('B answered 0');
  });

  it("decodes a Dec with Namada's twelve decimal places", () => {
    expect(decString(u256(0n))).toBe('0');
    expect(decString(u256(27_500_000_000n))).toBe('0.0275');
    expect(decString(u256(254_116_362_341n))).toBe('0.254116362341');
    expect(decString(u256(3n * 10n ** 12n))).toBe('3');
    expect(decString(u256((1n << 256n) - 10n ** 12n))).toBe('-1');
  });
});

// The address answer's live read (api.ts /api/address) read every address with namBalance, which decodes a node's
// "no value" answer as 0, while the cron's reads of the four protocol accounts moved to namProtocolBalance (release 1,
// 2026-11-07): a node answering the shielded pool's key without a value made the sheet show 0 NAM marked live. The
// reader is now picked by the account, so such an answer fails the live read and the stored balance is served with its note.
describe('/api/address for a protocol account', () => {
  const stored = (address: string, at: number) => ({ chain: 'namada', address, balance: '31618419065539', balance_num: 31_618_419.065539, updated_height: 8_516_662, updated_at: at, verified_at: at, verified_src: 'balance_listing' });

  it("the shielded pool's balance answered without a value by every node: the stored balance with its note, never 0 marked live", async () => {
    const db = testD1();
    insert(db, 'holders', [stored(NAMADA.internal.masp, Date.now() - 3_600_000)]);
    const asked = nodes(() => NO_VALUE);
    const res = await app.request(`/api/address/${NAMADA.internal.masp}`, {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as { balance: { value: number | null; prov: Record<string, unknown> } };
    expect(body.balance.value).toBe(31_618_419.065539);
    expect(body.balance.prov).toMatchObject({ source: 'D1 index (RPC failed)', status: 'stale', height: 8_516_662, note: 'The live read from the chain failed, so this is the last indexed balance.' });
    // every configured node was asked for the pool's balance before the stored reading was served
    expect(asked.filter((a) => a.path.endsWith(`/balance/#${NAMADA.internal.masp}`)).length).toBe(NAMADA.rpcs.length);
  });

  it("a holder's address answered so is still 0 NAM, live, from the first node that answered", async () => {
    const db = testD1();
    const asked = nodes(() => NO_VALUE);
    const res = await app.request('/api/address/tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa', {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const body = await res.json() as { balance: { value: number | null; prov: Record<string, unknown> } };
    expect(body.balance.value).toBe(0);
    expect(body.balance.prov).toMatchObject({ source: `Namada RPC ${NAMADA.rpcs[0].provider}`, status: 'live', height: 8_516_662 });
    expect(asked.filter((a) => a.path.endsWith('/balance/#tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa')).length).toBe(1);
  });
});
