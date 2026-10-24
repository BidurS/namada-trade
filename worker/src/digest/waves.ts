// The digest's reads run as a few db.batch waves (a later wave's parameters come from an earlier wave's answers).
// A D1 batch is atomic: one failing statement fails the batch, which would make every section of the wave a
// "not read". So a wave that fails as a batch is run again statement by statement, and only the statements that
// fail alone are failed answers; each section then decides for itself (spec section 1: a failure inside one section
// is that section's NotRead, never a lost digest).
import { answered, failed, type Answer } from './types';

export interface Handle<T> {
  readonly sql: string;
  readonly params: unknown[];
  /** the answer once the wave ran; a failed answer before */
  answer: Answer<T>;
}

/** Statements this wave prepared, with their parameters, for the cost tests. */
export interface Prepared { sql: string; params: unknown[] }

export class Wave {
  private handles: Handle<unknown>[] = [];
  constructor(private readonly db: D1Database, private readonly log: Prepared[] = []) {}

  /** Adds a statement to the wave; its answer is filled by run(). */
  add<T>(sql: string, params: unknown[]): Handle<T> {
    const h: Handle<T> = { sql, params, answer: failed('not run') };
    this.handles.push(h as Handle<unknown>);
    return h;
  }

  get size() { return this.handles.length; }

  /** Runs the wave: one batch, or each statement alone when the batch fails. Never throws for a statement's failure. */
  async run(): Promise<void> {
    if (!this.handles.length) return;
    for (const h of this.handles) this.log.push({ sql: h.sql, params: h.params });
    try {
      const res = await this.db.batch(this.handles.map((h) => this.db.prepare(h.sql).bind(...h.params)));
      this.handles.forEach((h, i) => { h.answer = answered(((res[i] as { results?: unknown[] })?.results ?? []) as unknown[]); });
      return;
    } catch (e) {
      // the batch failed as a whole: find the statement(s) at fault
      const why = String((e as Error)?.message ?? e).slice(0, 200);
      await Promise.all(this.handles.map(async (h) => {
        try {
          const r = await this.db.prepare(h.sql).bind(...h.params).all();
          h.answer = answered((r.results ?? []) as unknown[]);
        } catch (err) {
          h.answer = failed(String((err as Error)?.message ?? err ?? why).slice(0, 200));
        }
      }));
    }
  }
}
