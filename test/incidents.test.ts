// The public incidents timeline (scripts/incidents.ts, written into web/src/generated/events.ts as INCIDENTS): every row
// has a day, plain words and a source a reader can open; the halts' hours are what the public node's block headers
// give (test/fixtures/namada_blockchain_*.json, namada-rpc.stakeandrelax.net on 2026-11-07, which namada-rpc.polkachu.com
// agreed with to the millisecond); the halt of 2 November is the HALT row; and the chart markers never stand before
// the price history (web/src/screens/trade/model.ts incidentMarks).
import { TIMELINE_SHOWN } from '../shared/copy';
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { INCIDENTS, blockUrl } from '../scripts/incidents';
import { checkIncidents, INCIDENT_MARK_MAX } from '../scripts/export-proof';
import { INCIDENTS as GENERATED } from '../web/src/generated/events';
import { HALT } from '../shared/halt';
import { routeByPath } from '../shared/routes';
import { incidentMarks } from '../web/src/screens/trade/model';
import { incidentDays } from '../web/src/screens/shielded/timeline-words';
import { BANNED } from './banned-words';

const FIXTURES = join(__dirname, 'fixtures');
/** The header time of a block as the node answered it, from the fixture that holds it (null when none does). */
function headerTime(height: number): number | null {
  for (const f of [`namada_blockchain_${height}.json`, ...INCIDENTS.flatMap((r) => (r.halts ?? []).map((h) => `namada_blockchain_${h.from}_${h.to}.json`))]) {
    const p = join(FIXTURES, f);
    if (!existsSync(p)) continue;
    const metas = JSON.parse(readFileSync(p, 'utf8')).result.block_metas as { header: { height: string; time: string } }[];
    const m = metas.find((x) => Number(x.header.height) === height);
    if (m) return Date.parse(m.header.time);
  }
  return null;
}
const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const H = 3_600_000;

describe('the rows', () => {
  it('pass the generator\'s checks and are what the generated file carries', () => {
    expect(checkIncidents(INCIDENTS)).toBe(INCIDENTS);
    expect(GENERATED).toEqual(INCIDENTS);
    expect(INCIDENTS.length).toBeGreaterThanOrEqual(10);
  });

  it('each has a UTC day, a title, one or two plain sentences, and at least one source that opens', () => {
    for (const r of INCIDENTS) {
      expect(r.date, r.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(r.at).toISOString().slice(0, 10), r.id).toBe(r.date);
      expect(r.title.length, r.id).toBeGreaterThan(8);
      expect(r.text.split(/(?<=[.!?])\s+(?=[A-Z])/).length, `${r.id}: ${r.text}`).toBeLessThanOrEqual(3);
      expect(r.sources.some((s) => s.url?.startsWith('https://')), r.id).toBe(true);
      for (const s of r.sources) {
        expect(s.label.trim().length, r.id).toBeGreaterThan(0);
        // a chain source links the explorer's page of the first block it names
        const blocks = /^The chain: blocks? ([\d,]+)/.exec(s.label);
        if (blocks) expect(s.url).toBe(blockUrl(Number(blocks[1].replace(/,/g, ''))));
        else if (s.url) expect(s.url, r.id).toMatch(/^https:\/\/github\.com\/namada-net\/namada\/releases\/tag\/v\d+\.\d+\.\d+$/);
      }
      for (const p of r.pages) expect(routeByPath(p)?.index, `${r.id}: page ${p}`).toBe(true);
      if (r.mark != null) expect(r.mark.length, r.id).toBeLessThanOrEqual(INCIDENT_MARK_MAX);
    }
    // time order, no row twice
    expect(INCIDENTS.map((r) => r.at)).toEqual([...INCIDENTS.map((r) => r.at)].sort((a, b) => a - b));
    expect(new Set(INCIDENTS.map((r) => r.id)).size).toBe(INCIDENTS.length);
  });

  it('say what happened in the site\'s words: none of the copy lint\'s banned words', () => {
    for (const r of INCIDENTS) {
      for (const t of [r.title, r.text, ...r.sources.map((s) => s.label)]) expect(t, `${r.id}: ${t}`).not.toMatch(BANNED);
    }
  });

  it('every release row links Namada\'s release notes and describes nothing of what they change', () => {
    const releases = INCIDENTS.filter((r) => /^release-/.test(r.id));
    expect(releases.map((r) => r.id)).toEqual(['release-v201-0-9', 'release-v201-0-10', 'release-v201-0-11']);
    for (const r of releases) {
      expect(r.sources).toHaveLength(1);
      expect(r.text).toMatch(/its release notes on GitHub list the changes\.$/);
      expect(r.mark).toBeUndefined();
    }
  });
});

describe('the halts, measured from the blocks\' header times', () => {
  it('each row\'s hours are the gap between the two blocks it names, to two decimals, said to one in its words', () => {
    const halts = INCIDENTS.flatMap((r) => (r.halts ?? []).map((h) => ({ r, h })));
    expect(halts).toHaveLength(6);
    for (const { r, h } of halts) {
      const a = headerTime(h.from), b = headerTime(h.to);
      expect(a, `${r.id}: block ${h.from}`).not.toBeNull();
      expect(b, `${r.id}: block ${h.to}`).not.toBeNull();
      const hours = (b! - a!) / H;
      expect(h.hours, `${r.id}: ${h.from} to ${h.to}`).toBeCloseTo(hours, 2);
      expect(`${r.title} ${r.text}`, r.id).toContain(`${hours.toFixed(1)} hours`);
      expect(r.text).toContain(`${h.from.toLocaleString('en-US')}`);
      expect(r.text).toContain(`${h.to.toLocaleString('en-US')}`);
      expect(r.sources.some((s) => s.url === blockUrl(h.from)), `${r.id}: source for block ${h.from}`).toBe(true);
    }
    // the four of September as the brief gives them, and 2 November's last block
    const sep = INCIDENTS.find((r) => r.id === 'halts-2026-09')!;
    expect(sep.halts!.map((h) => h.hours)).toEqual([3.39, 33.43, 67.7, 195.08]);
    expect(clock(headerTime(7_914_154)!)).toBe('16:50');
    expect(sep.text).toContain('14 September at 16:50 UTC');
    const oct = INCIDENTS.find((r) => r.id === 'halt-2026-10-07')!;
    expect(oct.halts![0].hours).toBe(30.85);
  });

  it('a row is placed at the header time of the first block it names, and its clock words are those blocks\' minutes', () => {
    const named = (r: { text: string }) => [...r.text.matchAll(/blocks? ([\d,]+)(?: (?:and|to) ([\d,]+))?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean).map((x) => Number(x.replace(/,/g, ''))));
    for (const r of INCIDENTS) {
      const blocks = named(r);
      if (!blocks.length) continue;
      const first = headerTime(blocks[0]);
      if (first != null) expect(Math.abs(r.at - first), `${r.id}: at`).toBeLessThan(1000);
      for (const b of blocks) {
        const t = headerTime(b);
        if (t != null && /\d\d:\d\d/.test(r.text) && !r.halts) expect(r.text, `${r.id}: ${b}`).toContain(clock(t));
      }
    }
    // the June row's two blocks, both in fixtures
    const june = INCIDENTS.find((r) => r.id === 'pool-assets-2026-06-18')!;
    expect(clock(headerTime(6_966_393)!)).toBe('09:13');
    expect(clock(headerTime(6_966_885)!)).toBe('10:09');
    expect(june.text).toContain('09:13 to 10:09 UTC');
  });

  it('the halt of 2 November is the HALT row: the chain\'s last block, the team\'s words and their source, ongoing while HALT.on', () => {
    const r = INCIDENTS.find((x) => x.id === HALT.id)!;
    expect(r).toBeDefined();
    expect(r.date).toBe('2026-11-02');
    const last = JSON.parse(readFileSync(join(FIXTURES, 'namada_blockchain_8517986.json'), 'utf8')).result;
    expect(Number(last.last_height)).toBe(8_517_986);
    expect(Math.abs(r.at - Date.parse(last.block_metas[0].header.time))).toBeLessThan(1000);
    expect(r.text).toContain('22:49:36 UTC');
    expect(r.text).toContain(HALT.said);
    expect(r.sources).toEqual([{ label: 'The chain: block 8,517,986', url: blockUrl(8_517_986) }, { label: HALT.source }]);
    expect(r.ongoing).toBe(HALT.on);
    expect(r.mark).toBe('Halt');
  });
});

describe('the chart markers', () => {
  const PRICE_START = Date.UTC(2026, 7, 11); // the executed price begins 2026-08-11
  const TREND_START = Date.UTC(2025, 5, 13); // the shielded trend begins 2025-06-13

  it('place no marker before the price history, and every marked row from the trend\'s start', () => {
    const onTrade = incidentMarks(INCIDENTS, PRICE_START);
    expect(onTrade.length).toBeGreaterThan(0);
    for (const m of onTrade) expect(m.t).toBeGreaterThanOrEqual(PRICE_START);
    expect(onTrade.map((m) => m.label)).not.toContain('v201.0.7');
    expect(onTrade.map((m) => m.label)).not.toContain('Assets out');
    const onTrend = incidentMarks(INCIDENTS, TREND_START);
    expect(onTrend.map((m) => m.label)).toEqual(INCIDENTS.filter((r) => r.mark).map((r) => r.mark));
    expect(onTrend.length).toBeGreaterThan(onTrade.length);
    // a row without a mark is listed, never drawn; the order is time order
    expect(onTrend.some((m) => /v201\.0\.(9|10|11)/.test(m.label))).toBe(false);
    expect(onTrend.map((m) => m.t)).toEqual([...onTrend.map((m) => m.t)].sort((a, b) => a - b));
  });

  it('mark nothing when the series\' start is not known', () => {
    expect(incidentMarks(INCIDENTS, null)).toEqual([]);
    expect(incidentMarks(INCIDENTS, Number.NaN)).toEqual([]);
  });

  it('the list dates a row by its day, a span by both days', () => {
    expect(incidentDays({ date: '2025-12-02' })).toBe('2 Dec 2025');
    expect(incidentDays({ date: '2026-09-01', end: '2026-09-14' })).toBe('1 Sep to 14 Sep 2026');
    expect(incidentDays({ date: '2026-09-22', end: '2026-10-01' })).toBe('22 Sep to 1 Oct 2026');
    expect(incidentDays({ date: '2025-12-20', end: '2026-01-03' })).toBe('20 Dec 2025 to 3 Jan 2026');
  });
});

describe('the owner\'s call of 2026-11-08 (owner-decisions row 39)', () => {
  it('the timeline is hidden: the section and the markers render nothing while the rows and words stay', () => {
    expect(TIMELINE_SHOWN).toBe(false);
    const tl = readFileSync(new URL('../web/src/screens/shielded/Timeline.tsx', import.meta.url), 'utf8');
    expect(tl).toContain('if (!TIMELINE_SHOWN || !wide) return null;');
    for (const f of ['../web/src/screens/trade/index.tsx', '../web/src/screens/shielded/index.tsx']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).toMatch(/TIMELINE_SHOWN (&& wide )?\? incidentMarks\(/);
    }
  });
});
