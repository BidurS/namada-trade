/**
 * Live PoS bond requests from a block's `tx/applied` events + raw tx bytes, read as unbond requests are (namada-pos.ts
 * parsePosRequests says how).
 *
 * A bond moves the delegator's NAM to the staking account with no token/transfer event, so the event parser never
 * sees it. An applied bond's `changed_keys` include `<PoS>/bond/<source>/<validator>/…` (the prefilter; an unbond and a
 * redelegation write those keys too); its Data section is decoded as `Bond { validator, amount, source }`. The code
 * the inner tx ran decides: a known `tx_bond.wasm` checksum (BOND_CODE_HASHES) is decoded whatever tag the signer
 * wrote, and so is a section tagged `tx_bond.wasm` whose checksum no list knows (a newer bond wasm); an unbond, a
 * redelegation or other tagged code is counted in `skipped`, and untagged code no list knows is reported in
 * `undecoded`. Rows are the indexer backfill's bond rows (scripts/backfill-history.ts step `pos`, kind 'bond'): id
 * `namada:<INNER_HASH>:pos`, from = delegator (the validator for its own bond, meta.selfBond), to = PoS,
 * meta.validator / meta.wrapper / meta.tsSource, here with meta.source 'namada-rpc' and meta.code.
 */
import type { NamadaBlock } from './namada';
import { appliedPosWrites, BOND_REQUEST, parsePosRequests, type PosParse } from './namada-pos';

export { BOND_CODE_HASHES } from './namada-pos';

/** Applied inner txs that wrote to a PoS bond key, from the block's tx/applied events. */
export const appliedBonds = (block: NamadaBlock) => appliedPosWrites(block, 'bond');

/** True when the block needs its tx bytes fetched to extract bond requests. */
export const blockHasBond = (block: NamadaBlock): boolean => appliedPosWrites(block, 'bond').length > 0;

export type BondParse = PosParse;

/**
 * @param block   block_results events with the exact block time (block.ts must come from block metas)
 * @param txsB64  the block's txs as returned by RPC `/block` (base64)
 */
export const parseNamadaBonds = (block: NamadaBlock, txsB64: readonly string[], priceUsd: number | null): BondParse =>
  parsePosRequests(BOND_REQUEST, block, txsB64, priceUsd);
