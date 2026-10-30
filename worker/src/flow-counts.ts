// The stored counts of the moves list (migration 0017, scale plan Stage 1 item 6): flow_counts holds the moves up to
// flow_count_mark.mark by chain, kind, crossing twin, bot trade and size step, and the list's first page adds the moves
// after the mark, counted live (flows-query.ts storedCountSql), so its count is exact without a walk of every move.
//
// Kept by the cron, once a tick (cron.ts), in one transaction each time:
// - written whole when the triggers marked the counts dirty (a move up to 15 minutes past the mark was written,
//   replaced, changed or deleted: an outage caught up, a backfill, a repair) or when they were never written: every
//   move read once, as the list's count did on every cache miss before; at most once every FLOW_RECOUNT_GAP_MS, so a
//   catch-up that writes old moves on every tick costs one such read every quarter hour, not one a minute;
// - moved on when the mark trails the tick by more than FLOW_COUNT_LAG_MS + FLOW_COUNT_STEP_MS: the moves after the
//   mark are added to the counts (about an hour of moves), and only if nothing marked the counts dirty since the cron
//   read the mark (the statements check it themselves, inside the transaction).
// Between two writes the reader's live part is the moves of the last two to three hours.

import { flowCountGroupsSql } from './flows-query';

/**
 * How far the mark trails the tick: moves are written up to this late (a Namada block scanned behind, the Osmosis
 * catch-up search) without touching the counts; one written later than that, and older, marks them dirty.
 */
export const FLOW_COUNT_LAG_MS = 2 * 3_600_000;
/** How much the mark moves on at a time: once an hour, by the moves of that hour. */
export const FLOW_COUNT_STEP_MS = 3_600_000;
/**
 * The least time between two writes of the counts, when dirty: a whole write reads every move, about the cost of one
 * count of the old head page (0.76 to 0.93 s of D1 time), in one transaction that holds D1's writer. While dirty the
 * list counts the moves itself, exactly, as it did on every cache miss before the stored counts (api.ts readFlows).
 */
export const FLOW_RECOUNT_GAP_MS = 15 * 60_000;

const INTO = 'INSERT INTO flow_counts (chain, kind, twin, bot, size, n)';

/**
 * Write or move on the stored counts as of `now`: 'whole' when they were written from every move, 'step' when moved
 * on, null when nothing was due (or the migration is not applied: no mark row).
 */
export async function refreshFlowCounts(db: D1Database, now: number): Promise<'whole' | 'step' | null> {
  const m = await db.prepare('SELECT mark, dirty, at FROM flow_count_mark WHERE id = 1').first<{ mark: number | null; dirty: number; at: number | null }>();
  if (!m) return null;
  // on a whole minute, so the counts of one mark are the same however the tick's own time fell
  const to = Math.floor((now - FLOW_COUNT_LAG_MS) / 60_000) * 60_000;
  if (Number(m.dirty) !== 0 || m.mark == null) {
    // written (whole or moved on) less than FLOW_RECOUNT_GAP_MS ago: not yet; never written: now
    if (m.mark != null && m.at != null && now - Number(m.at) < FLOW_RECOUNT_GAP_MS) return null;
    const all = flowCountGroupsSql(null, to);
    await db.batch([
      db.prepare('DELETE FROM flow_counts'),
      db.prepare(`${INTO} ${all.sql}`).bind(...all.params),
      db.prepare('UPDATE flow_count_mark SET mark = ?, dirty = 0, at = ? WHERE id = 1').bind(to, now),
    ]);
    return 'whole';
  }
  const mark = Number(m.mark);
  if (to - mark < FLOW_COUNT_STEP_MS) return null;
  // the moves after the mark, added only to the counts this read saw: still clean, still at this mark
  const guard = { sql: '(SELECT dirty FROM flow_count_mark WHERE id = 1) = 0 AND (SELECT mark FROM flow_count_mark WHERE id = 1) = ?', params: [mark] };
  const step = flowCountGroupsSql(mark, to, guard);
  await db.batch([
    db.prepare(`${INTO} ${step.sql} ON CONFLICT (chain, kind, twin, bot, size) DO UPDATE SET n = n + excluded.n`).bind(...step.params),
    db.prepare('UPDATE flow_count_mark SET mark = ?, at = ? WHERE id = 1 AND dirty = 0 AND mark = ?').bind(to, now, mark),
  ]);
  return 'step';
}
