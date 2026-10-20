import { describe, expect, it } from 'vitest';
import { explorerHashOf } from '../shared/flow-rules';
import { rowToFlow } from '../worker/src/analytics';

// Owner report 2026-10-18: Supply "Unstaking and restaking" record links opened valopers' 404 page. Indexer-imported
// rows keep the inner hash in tx_hash; valopers files transactions under the wrapper hash (meta.wrapper).
const INNER = '8EE8FDE4999DE486CCE6F20DF1241FF2217667D78BD9761DD61C571A871FE3BC';
const WRAPPER = '3b5e4643659c34e8802b731d75564349119a74c2e37e9a1990cb0d172660b325';

describe('explorer hash', () => {
  it('an indexer row links by its wrapper hash, upper case', () => {
    expect(explorerHashOf({ txHash: INNER, meta: { source: 'namada-indexer', wrapper: WRAPPER } })).toBe(WRAPPER.toUpperCase());
  });
  it('a block-reader row (wrapper in tx_hash) and an Osmosis row link by tx_hash', () => {
    expect(explorerHashOf({ txHash: 'ABC', meta: { innerTxHash: INNER } })).toBe('ABC');
    expect(explorerHashOf({ txHash: 'ABC', meta: null })).toBe('ABC');
  });
  it('a malformed wrapper is ignored', () => {
    expect(explorerHashOf({ txHash: INNER, meta: { wrapper: 'not-a-hash' } })).toBe(INNER);
  });
  it('rowToFlow sends explorerHash', () => {
    const f = rowToFlow({ id: `namada:${INNER}:pos`, chain: 'namada', height: 8260323, ts: 1, tx_hash: INNER, kind: 'bond', amount_num: 149000, meta: JSON.stringify({ wrapper: WRAPPER }) });
    expect(f.explorerHash).toBe(WRAPPER.toUpperCase());
    expect(f.txHash).toBe(INNER);
  });
});
