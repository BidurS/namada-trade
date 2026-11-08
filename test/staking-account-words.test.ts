// A move of NAM out of or into the staking account by a transparent transfer (kind 'pos_balance'; on mainnet the
// 2026-08-31 drain and its repayment, migrations/0019) is named by the way it went, never as a move within the account,
// and its tag names the kind as a transfer, never as an internal one.
import { describe, it, expect } from 'vitest';
import { moveTitle, pastWords } from '../shared/flow-words';
import { KINDS, kindInfo } from '../shared/kinds';
import { INTERNAL_ADDRESSES } from '../shared/alerts';
import { GLOSSARY } from '../web/src/lib/glossary';
import { KIND_CHIP } from '../shared/search-grammar';
import { rowToFlow } from '../worker/src/analytics';
import { publicMoveOf, publicTitle } from '../worker/src/public-posts';
import type { Flow } from '../shared/types';

const POS = INTERNAL_ADDRESSES.pos;
const OUT_TO = 'tnam1qxreceiver000000000000000000000000000000';
const BACK_FROM = 'tnam1qxsender0000000000000000000000000000000';
const move = (from: string | null, to: string | null, amount: number): Pick<Flow, 'kind' | 'chain' | 'from' | 'to' | 'amount' | 'meta'> =>
  ({ kind: 'pos_balance', chain: 'namada', from, to, amount, meta: { descriptor: 'transfer-from-wasm' } });

describe('a staking account transfer, by its direction', () => {
  it('titles the NAM that left the account as out of it, and the NAM that came back as into it', () => {
    expect(moveTitle(move(POS, OUT_TO, 331_386_682.183413))).toBe('331,386,682 NAM moved out of the staking account');
    expect(moveTitle(move(BACK_FROM, POS, 99_999_900))).toBe('99,999,900 NAM moved into the staking account');
  });

  it('says both ways when the caller gives neither side', () => {
    expect(moveTitle({ kind: 'pos_balance', chain: 'namada', amount: 1, to: null })).toBe('1.00 NAM moved into or out of the staking account');
  });

  it('never says the NAM moved within the account', () => {
    for (const f of [move(POS, OUT_TO, 1_000_000), move(BACK_FROM, POS, 100), { kind: 'pos_balance' as const, chain: 'namada' as const, amount: 1, to: null }]) {
      expect(moveTitle(f)).not.toMatch(/within/);
    }
  });

  it('lists an earlier one from the side of the person it names', () => {
    expect(pastWords(move(POS, OUT_TO, 1), true, '1,000,000 NAM')).toBe('received 1,000,000 NAM from the staking account');
    expect(pastWords(move(BACK_FROM, POS, 1), false, '100,000,000 NAM')).toBe('moved 100,000,000 NAM into the staking account');
  });
});

describe('the tag of a staking account transfer', () => {
  it('names the kind as a transfer out of or into the account, not as an internal move or a balance', () => {
    expect(kindInfo('pos_balance')).toBe(KINDS.posBalance);
    expect(KINDS.posBalance).toMatchObject({ word: 'Staking account transfer', hue: 'pos', term: 'staking-account' });
    expect(KINDS.posBalance.expert).toBe('Transparent transfer out of or into the staking account, not a bond or a withdrawal');
    expect(`${KINDS.posBalance.word} ${KINDS.posBalance.expert}`).not.toMatch(/internal|balance/i);
  });
});

describe('the other places that name the kind say the same', () => {
  it("the glossary entry the tag links to, and the search chip, name it as the tag does", () => {
    const entry = GLOSSARY.find((g) => g.id === KINDS.posBalance.term)!;
    expect(entry).toMatchObject({ plain: KINDS.posBalance.word, expert: KINDS.posBalance.expert });
    expect(`${entry.plain} ${entry.expert} ${entry.text}`).not.toMatch(/internal|only the chain/i);
    expect(KIND_CHIP.pos_balance).toBe('Staking account transfers only');
  });

  it('a public post of one says which way the NAM went, from the allowlisted fields alone', () => {
    const stored = (from: string, to: string) => rowToFlow({
      id: `namada:POS${from.slice(-3)}:0`, chain: 'namada', height: 7_900_851, ts: Date.UTC(2026, 7, 31, 23, 35), tx_hash: 'POS', kind: 'pos_balance',
      from_addr: from, to_addr: to, amount_num: 331_386_682.183413, price_usd: 0.004, value_usd: 1_325_546, meta: JSON.stringify({ descriptor: 'transfer-from-wasm', priceSource: 'spot' }),
    });
    const out = publicMoveOf(stored(POS, OUT_TO), { namada: 10000, osmosis: 10000 })!;
    expect(out.posWay).toBe('out');
    expect(publicTitle(out)).toBe('331,386,682 NAM moved out of the staking account');
    const back = publicMoveOf(stored(BACK_FROM, POS), { namada: 10000, osmosis: 10000 })!;
    expect(back.posWay).toBe('in');
    expect(publicTitle(back)).toBe('331,386,682 NAM moved into the staking account');
  });
});
