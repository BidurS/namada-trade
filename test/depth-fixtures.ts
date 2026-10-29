// The depth fixtures: real answers of the Osmosis chain node, the REST gateway, the quote service and the order book
// contract, saved by the depth research on 2026-10-29 (each file's header lines carry the time, the URL, the status and
// the size; a JSON file whose first lines start with // is read past them). No test here reaches the network.
import { readFileSync } from 'node:fs';

export const depthFixtureText = (name: string): string => readFileSync(new URL(`./fixtures/depth/${name}`, import.meta.url), 'utf8');
/** A fixture's JSON, past its // header lines. */
export function depthFixture<T = any>(name: string): T {
  const text = depthFixtureText(name);
  const body = text.split('\n').filter((l) => !l.startsWith('//')).join('\n');
  return JSON.parse(body) as T;
}
/** The header lines of a fixture (its provenance), for a test that wants to quote the read time. */
export const depthFixtureHeader = (name: string): string[] => depthFixtureText(name).split('\n').filter((l) => l.startsWith('//'));

/** NAM's denom on Osmosis and Noble USDC's, as the fixtures carry them. */
export const NAM_DENOM = 'ibc/C7110DEC66869DAE9BE9C3C60F4B5313B16A2204AE020C3B0527DD6B322386A3';
export const USDC_DENOM = 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4';
