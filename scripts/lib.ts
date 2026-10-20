import { execFileSync } from 'node:child_process';

/** Run a read-only query against the remote D1 and return the rows. */
export function d1<T = any>(sql: string): T[] {
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'namada-trade-db', '--remote', '--json', '--command', sql], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(out).flatMap((r: any) => r.results) as T[];
}

export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
