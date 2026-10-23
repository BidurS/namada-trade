// Security review (2026-10-22), the epoch answer: a node's 200 answer without result.response ended an ABCI read
// on that node (the other node was never asked), and an epoch answer with no value decoded to epoch 0 while the
// cron's health called the read ok. Now an answer without a response is no answer (the next node is asked, as the
// listing reads and rpcRead already do), and an epoch answer that is not an epoch (an error code, no value, a value
// that is not 8 bytes, epoch 0) is refused at its node: the node is put last and the next node is asked, so one
// node answering so cannot leave every tick without an epoch while the other node has it. When every node answers
// so, the read fails and the Sources sheet shows it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { namadaEpoch, namBalance, RpcBreaker, QUICK } from '../worker/src/sources/namada';

afterEach(() => { vi.unstubAllGlobals(); });

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const rpcs = [{ provider: 'A', url: 'https://a.example' }, { provider: 'B', url: 'https://b.example' }];
const EPOCH_2715 = btoa(String.fromCharCode(155, 10, 0, 0, 0, 0, 0, 0));

function nodes(answer: (node: 'A' | 'B', path: string) => unknown) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const node = url.startsWith('https://a.example') ? 'A' : 'B';
    asked.push(node);
    return json(answer(node, decodeURIComponent(url.split('path=')[1] ?? '')));
  }));
  return asked;
}

describe('an ABCI answer without a response', () => {
  it('is no answer: the next node is asked and the first is put last for the rest of the tick', async () => {
    const asked = nodes((node) => (node === 'A' ? { jsonrpc: '2.0', id: -1 } : { result: { response: { code: 0, value: EPOCH_2715, height: '9' } } }));
    const breaker = new RpcBreaker();
    expect(await namadaEpoch({ ...QUICK, rpcs, breaker })).toBe(2715);
    expect(asked).toEqual(['A', 'B']);
    expect(breaker.failures('A')).toBe(1);
  });

  it('from every node is still a failed read, with the same message', async () => {
    nodes(() => ({ jsonrpc: '2.0', id: -1 }));
    await expect(namadaEpoch({ ...QUICK, rpcs })).rejects.toThrow('abci /shell/epoch: answer without a response');
  });

  it('an error code is still an answer about the query, not a reason to ask another node', async () => {
    const asked = nodes(() => ({ result: { response: { code: 1, info: 'no such key', value: null, height: '9' } } }));
    await expect(namBalance('tnam1qxyz', { ...QUICK, rpcs })).rejects.toThrow(/code 1: no such key/);
    expect(asked).toEqual(['A']);
  });
});

describe('an epoch answer that is not an epoch', () => {
  for (const [what, first, why] of [
    ['no value', { result: { response: { code: 0, value: null, height: '9' } } }, 'answered without a value'],
    ['an empty value', { result: { response: { code: 0, value: '', height: '9' } } }, 'answered without a value'],
    ['an error code', { result: { response: { code: 1, info: 'storage error', value: null, height: '9' } } }, 'answered code 1: storage error'],
    ['eight zero bytes', { result: { response: { code: 0, value: 'AAAAAAAAAAA=', height: '9' } } }, 'answered epoch 0'],
    ['a value that is not 8 bytes', { result: { response: { code: 0, value: btoa('\x9b\x0a'), height: '9' } } }, 'answered a value that is not an epoch'],
  ] as const) {
    it(`(${what}) from the first node: the next node is asked, and the first is put last`, async () => {
      const asked = nodes((node) => (node === 'A' ? first : { result: { response: { code: 0, value: EPOCH_2715, height: '9' } } }));
      const breaker = new RpcBreaker();
      expect(await namadaEpoch({ ...QUICK, rpcs, breaker })).toBe(2715);
      expect(asked).toEqual(['A', 'B']);
      expect(breaker.failures('A')).toBe(1);
    });

    it(`(${what}) from every node: a failed read, never epoch 0`, async () => {
      const asked = nodes(() => first);
      await expect(namadaEpoch({ ...QUICK, rpcs })).rejects.toThrow(`abci /shell/epoch: B ${why}`);
      expect(asked).toEqual(['A', 'B']);
    });
  }

  it('the other ABCI reads still take an error code as an answer, from the first node', async () => {
    const asked = nodes(() => ({ result: { response: { code: 1, info: 'no such key', value: null, height: '9' } } }));
    await expect(namBalance('tnam1qxyz', { ...QUICK, rpcs })).rejects.toThrow(/code 1: no such key/);
    expect(asked).toEqual(['A']);
  });

  it('a node list given empty (every node names another chain) leaves no node to ask', async () => {
    const asked = nodes(() => ({ result: { response: { code: 0, value: EPOCH_2715, height: '9' } } }));
    await expect(namadaEpoch({ ...QUICK, rpcs: [] })).rejects.toThrow('abci /shell/epoch: no node on this chain to ask');
    expect(asked).toEqual([]);
  });

  it('a real epoch still reads as before', async () => {
    nodes(() => ({ result: { response: { code: 0, value: EPOCH_2715, height: '9' } } }));
    expect(await namadaEpoch({ ...QUICK, rpcs })).toBe(2715);
  });
});
