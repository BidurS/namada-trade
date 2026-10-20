import { NAMADA } from '../config';
import { fetchJson } from '../util';

export async function fetchValopersValidators(): Promise<Record<string, string>> {
  try {
    const res = await fetchJson<Record<string, string>>(NAMADA.valopersValidators, {
      timeoutMs: 15000,
      retries: 2,
    });
    return res || {};
  } catch {
    return {};
  }
}
