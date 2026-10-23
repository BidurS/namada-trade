/**
 * Live PoS unbond requests from a block's `tx/applied` events + raw tx bytes (the decoder is shared with bonds:
 * namada-pos.ts parsePosRequests says how it reads them).
 *
 * An unbond moves no tokens, so the token/transfer parser never sees it. An applied unbond's `changed_keys` include
 * `<PoS>/unbond/<source>/<validator>/…` (the prefilter, so the extra `/block` fetch only happens for such blocks); its
 * Data section is decoded as `Unbond { validator, amount, source }`. Withdraws also touch `unbond/…` keys (they delete
 * them), so the code the inner tx ran decides: a known `tx_unbond.wasm` checksum (UNBOND_CODE_HASHES) is decoded
 * whatever tag the signer wrote on its Code section, and so is a section tagged `tx_unbond.wasm` whose checksum no list
 * knows (a newer unbond wasm); a known checksum of other code, and other tagged code, is counted in `skipped`.
 * Rows: id `namada:<INNER_HASH>:pos`, from = PoS, to = delegator, meta.validator / meta.wrapper / meta.tsSource, as the
 * indexer backfill writes them (scripts/backfill-history.ts step `pos`).
 */
import type { NamadaBlock } from './namada';
import { appliedPosWrites, parsePosRequests, UNBOND_REQUEST, type PosParse } from './namada-pos';

export { UNBOND_CODE_HASHES } from './namada-pos';

interface AppliedInner {
  wrapperHash: string;
  innerHash: string;
  /** (source, validator) pairs from `<PoS>/unbond/<source>/<validator>` changed keys */
  unbondKeys: { source: string; validator: string }[];
}

/** Applied inner txs that wrote to a PoS unbond key, from the block's tx/applied events. */
export function appliedUnbonds(block: NamadaBlock): AppliedInner[] {
  return appliedPosWrites(block, 'unbond').map((w) => ({ wrapperHash: w.wrapperHash, innerHash: w.innerHash, unbondKeys: w.keys }));
}

/** True when the block needs its tx bytes fetched to extract unbond requests. */
export const blockHasUnbond = (block: NamadaBlock): boolean => appliedPosWrites(block, 'unbond').length > 0;

export type UnbondParse = PosParse;

/**
 * @param block   block_results events with the exact block time (block.ts must come from block metas)
 * @param txsB64  the block's txs as returned by RPC `/block` (base64)
 */
export const parseNamadaUnbonds = (block: NamadaBlock, txsB64: readonly string[], priceUsd: number | null): UnbondParse =>
  parsePosRequests(UNBOND_REQUEST, block, txsB64, priceUsd);
