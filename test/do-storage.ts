// A Durable Object storage stand-in for the live hub's tests: the calls the hub makes (get, put, delete, list by
// prefix in key order, with a limit and from after a key, and the alarm), over a Map. Values are copied in and out, as
// the real storage serialises them.

export interface MemStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(opts?: { prefix?: string; limit?: number; startAfter?: string }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  /** How many keys are stored (a test's own read). */
  size(): number;
}

export function memStorage(): MemStorage {
  const m = new Map<string, unknown>();
  return {
    async get(key) { return structuredClone(m.get(key)) as any; },
    async put(key, value) { m.set(key, structuredClone(value)); },
    async delete(key) { return m.delete(key); },
    async list(opts = {}) {
      const out = new Map<string, any>();
      for (const k of [...m.keys()].sort()) {
        if (opts.prefix && !k.startsWith(opts.prefix)) continue;
        if (opts.startAfter && k <= opts.startAfter) continue;
        out.set(k, structuredClone(m.get(k)));
        if (opts.limit && out.size >= opts.limit) break;
      }
      return out;
    },
    async getAlarm() { return 1; },
    async setAlarm() {},
    size: () => m.size,
  };
}
