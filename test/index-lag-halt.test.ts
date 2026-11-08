// The namada_index_lag row while the chain makes no block (2026-11-08, after the halt of 2 November): the index stands
// at the chain's newest block and the row says 'idle', not 'fail' on the cursor's age; a fresh cursor at the head is
// 'ok', a lag is judged as before, and no cursor is 'fail'. A quiet cursor with no head read this tick (no node answered
// its height) is 'idle' too, with its own reason: the index cannot be placed against a chain whose height was not read,
// and the node outage is the node rows' to say. The public line names each idle reason.
import { describe, it, expect } from 'vitest';
import { namadaIndexLagRow } from '../worker/src/cron';
import { NAMADA_CURSOR_STALE_MS, NAMADA_CURSOR_MAX_LAG } from '../worker/src/analytics';
import { checkDetail } from '../web/src/lib/prov';
import { BANNED } from './banned-words';

const NOW = Date.UTC(2026, 10, 8, 8, 0, 0);
const HEAD = 8_517_986;

describe('namada_index_lag on a chain that stands still', () => {
  it('a cursor at the head, older than the stale window, is idle with the reason, never fail', () => {
    const r = namadaIndexLagRow({ height: HEAD, at: Date.UTC(2026, 10, 2, 22, 49, 36) }, HEAD, NOW);
    expect(r.status).toBe('idle');
    expect(r.detail).toMatchObject({ cursorHeight: HEAD, rpcHeight: HEAD, lagBlocks: 0, judged: false, notJudged: 'no-new-blocks' });
    // fmtUtcLong sets its own spaces in the time; the words around it are asserted exactly
    expect(String(r.detail.note)).toMatch(/^the index stands at the chain's newest block 8,517,986, written 2 Nov 2026,\s22:49\sUTC; no block since to index$/);
    expect(String(r.detail.note)).not.toMatch(BANNED);
  });
  it('a fresh cursor at or near the head is ok; a short lag with a cursor under 30 min warns; far behind fails', () => {
    expect(namadaIndexLagRow({ height: HEAD, at: NOW - 1000 }, HEAD, NOW).status).toBe('ok');
    expect(namadaIndexLagRow({ height: HEAD - NAMADA_CURSOR_MAX_LAG, at: NOW - 1000 }, HEAD, NOW).status).toBe('ok');
    expect(namadaIndexLagRow({ height: HEAD - 200, at: NOW - 10 * 60000 }, HEAD, NOW).status).toBe('warn');
    expect(namadaIndexLagRow({ height: HEAD - 2000, at: NOW - 1000 }, HEAD, NOW).status).toBe('fail');
    // behind the head and quiet: the chain moved and the index did not, so the age counts against it
    expect(namadaIndexLagRow({ height: HEAD - 5, at: NOW - NAMADA_CURSOR_STALE_MS - 1 }, HEAD, NOW).status).toBe('warn');
  });
  it('no cursor is fail; no head read leaves the lag unknown: a fresh cursor is ok, a quiet one is idle with the reason, never fail', () => {
    expect(namadaIndexLagRow(null, HEAD, NOW).status).toBe('fail');
    expect(namadaIndexLagRow({ height: HEAD, at: NOW - 1000 }, null, NOW)).toMatchObject({ status: 'ok', detail: { lagBlocks: null } });
    // the halt's standing state when every node is out: nothing of this site's to judge, so no incident opens on it
    const quiet = namadaIndexLagRow({ height: HEAD, at: NOW - 2 * 3600_000 }, null, NOW);
    expect(quiet.status).toBe('idle');
    expect(quiet.detail).toMatchObject({ cursorHeight: HEAD, rpcHeight: null, lagBlocks: null, judged: false, notJudged: 'head-not-read', note: 'no Namada node answered its height this tick, so the index cannot be placed against the chain' });
    expect(String(quiet.detail.note)).not.toMatch(BANNED);
    // a head of 0 (no node's status carried a height) is no head
    expect(namadaIndexLagRow({ height: HEAD, at: NOW - 2 * 3600_000 }, 0, NOW).status).toBe('idle');
  });
  it('the public line for each idle row says what it is', () => {
    const line = (r: ReturnType<typeof namadaIndexLagRow>) => checkDetail({ key: 'namada_index_lag', status: r.status, title: 't', detail: r.detail, checkedAt: NOW } as never);
    const still = line(namadaIndexLagRow({ height: HEAD, at: NOW - 5 * 86_400_000 }, HEAD, NOW));
    expect(still).toBe("at the chain's newest block: no new block to index");
    const noHead = line(namadaIndexLagRow({ height: HEAD, at: NOW - 5 * 86_400_000 }, null, NOW));
    expect(noHead).toBe('no Namada node answered its height: the index cannot be placed against the chain');
    for (const l of [still, noHead]) expect(String(l)).not.toMatch(BANNED);
  });
});
