import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchNamPrice, quoteErrorText } from '../worker/src/sources/sqs';
import { NAM, OSMOSIS } from '../worker/src/config';

const priceBody = JSON.stringify({ [NAM.osmoDenom]: { [OSMOSIS.allUsdc]: '0.001' } });
afterEach(() => vi.unstubAllGlobals());

describe('Osmosis quote service resilience', () => {
  it('retries the 403 that SQS returns to bursts and then succeeds', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
      .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
      .mockResolvedValueOnce(new Response(priceBody, { status: 200 }));
    vi.stubGlobal('fetch', f);
    const r = await fetchNamPrice();
    expect(f).toHaveBeenCalledTimes(3);
    expect(r.usd).toBe(0.001);
  });

  it('after three 403s reports a plain sentence, never a URL or a status line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response('blocked', { status: 403 })));
    const r = await fetchNamPrice();
    expect(r.usd).toBeNull();
    expect(r.error).toBe(quoteErrorText('busy'));
    expect(r.error).not.toMatch(/https?:|HTTP \d|sqs\.osmosis/i);
  });

  it('every error text is human', () => {
    for (const c of ['busy', 'unavailable', 'no_route', 'no_price'] as const) expect(quoteErrorText(c)).not.toMatch(/https?:|HTTP \d|\/router\//i);
  });
});
