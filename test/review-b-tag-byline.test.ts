// Security review (2026-10-22), user tags: a tag a signed-in wallet wrote is shown with "Tag by tnam1qxyz…" on every
// page (shared/labels.ts tagByline), so it never reads like a curated name. Two places dropped the byline: an alert
// hit's detail ("Heliax team wallet moved 90,000 NAM…") and the moves CSV, whose from_label/to_label columns carried
// the tag with nothing saying who wrote it.
import { describe, it, expect } from 'vitest';
import { evaluateFlow } from '../shared/alerts';
import { app } from '../worker/src/api';
import { testD1, insert } from './d1-sqlite';
import type { Flow } from '../shared/types';

const T = Date.UTC(2026, 9, 22, 12);
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';
const STAKER = 'tnam1qstaker0000000000000000000000000000000';
const AUTHOR = 'tnam1qauthor000000000000000000000000000000';
const CURATED = 'tnam1qcurated00000000000000000000000000000';

/** A 900,000 NAM unbond to `to`: the unstake rule's hit names the receiver in its detail. */
const unbond = (to: string, label: Partial<Flow>): Flow => ({
  id: `namada:u-${to.slice(6, 12)}:0`, chain: 'namada', height: 1, ts: T - 60_000, txHash: 'U1', kind: 'unbond', from: POS, to, amount: 900_000, meta: null, ...label,
});

describe('a wallet tag keeps its byline', () => {
  it("in an alert hit's detail: the tag, then who wrote it; a curated name stays as it is", () => {
    const tagged = evaluateFlow(unbond(STAKER, { toLabel: 'Heliax team wallet', toLabelPlain: 'Heliax team wallet', toLabelSource: 'user', toLabelAuthor: 'tnam1qauthor…' }));
    expect(tagged.length).toBeGreaterThan(0);
    for (const h of tagged) {
      expect(h.detail).toContain('Heliax team wallet (Tag by tnam1qauthor…)');
    }
    const unsigned = evaluateFlow(unbond(STAKER, { toLabel: 'Heliax team wallet', toLabelSource: 'user', toLabelAuthor: null }));
    for (const h of unsigned) expect(h.detail).toContain('Heliax team wallet (Tag by a signed-in wallet)');
    const curated = evaluateFlow(unbond(CURATED, { toLabel: 'Genesis: af_backers', toLabelPlain: 'Early backer', toLabelSource: 'genesis' }));
    expect(curated.length).toBeGreaterThan(0);
    for (const h of curated) {
      expect(h.detail).toContain('Early backer');
      expect(h.detail).not.toContain('Tag by');
    }
  });

  it('in the moves CSV: each label with its source and, for a wallet tag, its author', async () => {
    const db = testD1();
    insert(db, 'flows', [
      { id: 'namada:a:0', chain: 'namada', height: 1, ts: T - 120_000, tx_hash: 'A1', kind: 'unbond', from_addr: POS, to_addr: STAKER, amount_num: 10, meta: null },
      { id: 'namada:b:0', chain: 'namada', height: 2, ts: T - 60_000, tx_hash: 'B1', kind: 'unbond', from_addr: POS, to_addr: CURATED, amount_num: 20, meta: null },
    ]);
    insert(db, 'labels', [
      { address: STAKER, chain: 'namada', label: 'Heliax team wallet', category: 'watch', source: 'user', author: AUTHOR, updated_at: T - 86_400_000, created_at: T - 86_400_000 },
      { address: CURATED, chain: 'namada', label: 'Genesis: af_backers', category: 'genesis', source: 'genesis', updated_at: T - 86_400_000 },
    ]);
    const res = await app.request(`/api/export/flows?format=csv&at=${T}`, {}, { DB: db } as any);
    expect(res.status).toBe(200);
    const [head, ...lines] = (await res.text()).trim().split(/\r?\n/);
    const cols = head.split(',');
    for (const c of ['from_label_source', 'from_label_author', 'to_label_source', 'to_label_author']) expect(cols).toContain(c);
    const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v.replace(/^"|"$/g, '')])));
    const tagged = rows.find((r) => r.to === STAKER)!;
    expect(tagged.to_label).toBe('Heliax team wallet');
    expect(tagged.to_label_source).toBe('user');
    expect(tagged.to_label_author).toBe(`${AUTHOR.slice(0, 12)}…`);
    const curated = rows.find((r) => r.to === CURATED)!;
    expect(curated.to_label_source).toBe('genesis');
    expect(curated.to_label_author).toBe('');
  });
});
