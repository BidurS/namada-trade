// Stage 1 (scale plan item 6; own audit 2026-10-29 Low 1): every per-address limit and the live hub's admission count an
// IPv4 address whole and an IPv6 address by its /64, so one machine cannot count as 2^64 clients by taking another
// address of its line's block.
import { describe, it, expect } from 'vitest';
import { clientKey, clientOf, v6Groups, UNKNOWN_CLIENT } from '../worker/src/client-key';
import { admitAmong, admitSocket, MAX_SOCKETS, MAX_SOCKETS_PER_IPV4, MAX_SOCKETS_PER_V6_48, MAX_SOCKETS_PER_V6_64 } from '../worker/src/ws-admit';
import { rateLimited, replayLimited, wsLimited } from '../worker/src/http';

describe('clientKey: an IPv4 address whole, an IPv6 address by its /64', () => {
  it('IPv4: the address as written, in one spelling', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(clientKey('203.000.113.007')).toBe('203.0.113.7');
    expect(clientOf('198.51.100.9')).toEqual({ key: '198.51.100.9', wide: null, v6: false });
    // two addresses are two clients
    expect(clientKey('203.0.113.7')).not.toBe(clientKey('203.0.113.8'));
  });

  it('IPv6 written in full: its first four groups', () => {
    expect(clientOf('2001:0db8:0001:0002:0003:0004:0005:0006')).toEqual({ key: '2001:db8:1:2::/64', wide: '2001:db8:1::/48', v6: true });
    expect(clientKey('2001:DB8:1:2:FFFF:FFFF:FFFF:FFFF')).toBe('2001:db8:1:2::/64');
  });

  it('IPv6 compressed: the same /64 whatever the spelling', () => {
    const spellings = ['2001:db8:1:2::1', '2001:db8:1:2::', '2001:0db8:0001:0002::abcd', '2001:db8:1:2:0:0:0:9', '2001:DB8:1:2:a::b'];
    for (const s of spellings) expect(clientKey(s), s).toBe('2001:db8:1:2::/64');
    // `::` inside the /64 itself
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('fe80::1:2:3:4')).toBe('fe80:0:0:0::/64');
    // another /64 of the same /48 is another key, with the same wide block
    expect(clientOf('2001:db8:1:3::1')).toEqual({ key: '2001:db8:1:3::/64', wide: '2001:db8:1::/48', v6: true });
    expect(clientOf('2001:db8:2:3::1').wide).toBe('2001:db8:2::/48');
  });

  it('every address of one /64 is one client: 2^64 addresses, one key', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 200; i++) keys.add(clientKey(`2001:db8:aa:bb:${((i * 7919) & 0xffff).toString(16)}:${i.toString(16)}:${((i * 31) & 0xffff).toString(16)}:1`));
    expect([...keys]).toEqual(['2001:db8:aa:bb::/64']);
  });

  it('IPv4 written as IPv6 (::ffff:0:0/96) is the IPv4 address', () => {
    expect(clientOf('::ffff:203.0.113.7')).toEqual({ key: '203.0.113.7', wide: null, v6: false });
    expect(clientKey('::FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7');
    expect(clientKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    // a dotted tail elsewhere (a NAT64 prefix) is an IPv6 address, keyed by its /64
    expect(clientKey('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
  });

  it('reads groups as the address says them', () => {
    expect(v6Groups('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(v6Groups('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(v6Groups('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    for (const bad of ['1::2::3', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '12345::1', 'g::1', '1:2:3:4:5:6:7::8', '::ffff:1.2.3.400']) expect(v6Groups(bad), bad).toBeNull();
  });

  it('no address is one bucket; text that is not an address is its own, bounded', () => {
    expect(clientOf(null)).toBe(UNKNOWN_CLIENT);
    expect(clientOf('')).toBe(UNKNOWN_CLIENT);
    expect(clientKey('not-an-address')).toBe('not-an-address');
    expect(clientKey('x'.repeat(500))).toHaveLength(64);
    expect(clientKey('256.1.1.1')).toBe('256.1.1.1');
  });
});

describe('the limiters count the client, not the address as sent', () => {
  const spy = () => {
    const keys: string[] = [];
    return { keys, async limit({ key }: { key: string }) { keys.push(key); return { success: true }; } };
  };
  const req = (path: string, ip: string, headers: Record<string, string> = {}) => new Request(`https://namada.trade${path}`, { headers: { 'cf-connecting-ip': ip, ...headers } });

  it('HEAVY, SEARCH, REPLAY and WS: one key for every address of a /64, the IPv4 key unchanged', async () => {
    const heavy = spy(), search = spy(), replay = spy(), ws = spy();
    for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2:ffff::9', '2001:0db8:0001:0002:0:0:0:abc']) {
      await rateLimited(req('/api/export/flows', ip), { HEAVY_LIMITER: heavy } as any);
      await rateLimited(req('/api/search?q=abc', ip), { SEARCH_LIMITER: search } as any);
      await replayLimited(req('/api/overview?at=1700000000000', ip), { REPLAY_LIMITER: replay } as any);
      await wsLimited(req('/ws', ip, { Upgrade: 'websocket' }), { WS_LIMITER: ws } as any);
    }
    expect(new Set(heavy.keys)).toEqual(new Set(['2001:db8:1:2::/64:/api/export']));
    expect(new Set(search.keys)).toEqual(new Set(['2001:db8:1:2::/64:/api/search']));
    expect(new Set(replay.keys)).toEqual(new Set(['2001:db8:1:2::/64:/api/overview']));
    expect(new Set(ws.keys)).toEqual(new Set(['2001:db8:1:2::/64:/ws']));
    await rateLimited(req('/api/export/flows', '203.0.113.7'), { HEAVY_LIMITER: heavy } as any);
    expect(heavy.keys.at(-1)).toBe('203.0.113.7:/api/export');
    await rateLimited(req('/api/export/flows', '::ffff:203.0.113.7'), { HEAVY_LIMITER: heavy } as any);
    expect(heavy.keys.at(-1)).toBe('203.0.113.7:/api/export');
  });
});

describe('the live hub admits sockets per client: 32 per IPv4 address, 16 per IPv6 /64, 64 per IPv6 /48', () => {
  const v4 = clientOf('203.0.113.7');
  const v6 = (sub: number, host = 1) => clientOf(`2001:db8:1:${sub.toString(16)}::${host.toString(16)}`);

  it('the caps', () => {
    expect(MAX_SOCKETS_PER_IPV4).toBe(32);
    expect(MAX_SOCKETS_PER_V6_64).toBe(16);
    expect(MAX_SOCKETS_PER_V6_48).toBe(64);
    expect(admitSocket(MAX_SOCKETS, v4, 0)).toBe('full');
    expect(admitSocket(MAX_SOCKETS - 1, v4, MAX_SOCKETS_PER_IPV4 - 1)).toBe('ok');
    expect(admitSocket(10, v4, MAX_SOCKETS_PER_IPV4)).toBe('ip');
    expect(admitSocket(10, v6(1), MAX_SOCKETS_PER_V6_64 - 1, MAX_SOCKETS_PER_V6_48 - 1)).toBe('ok');
    expect(admitSocket(10, v6(1), MAX_SOCKETS_PER_V6_64, 0)).toBe('ip');
    expect(admitSocket(10, v6(1), 0, MAX_SOCKETS_PER_V6_48)).toBe('ip');
  });

  /** Open sockets one by one as the hub does (admitAmong over the open ones); the number admitted. */
  const fill = (open: ReturnType<typeof clientOf>[], next: () => ReturnType<typeof clientOf>, tries: number) => {
    let n = 0;
    for (let i = 0; i < tries; i++) {
      const c = next();
      if (admitAmong(open, c) === 'ok') { open.push(c); n++; }
    }
    return n;
  };

  it('one IPv4 address: 32 sockets', () => {
    expect(fill([], () => v4, 100)).toBe(32);
  });

  it('one /64, any address in it: 16 sockets; another address of the same /64 gets no more', () => {
    let host = 0;
    const open: ReturnType<typeof clientOf>[] = [];
    expect(fill(open, () => v6(1, ++host), 100)).toBe(16);
    expect(admitAmong(open, v6(1, 0xffff))).toBe('ip');
  });

  it('a /48 taking a new /64 for each socket: 64 sockets in all, then refused; another /48 and IPv4 are not affected', () => {
    let sub = 0;
    const open: ReturnType<typeof clientOf>[] = [];
    expect(fill(open, () => v6(++sub), 500)).toBe(64);
    expect(admitAmong(open, clientOf('2001:db8:2::1'))).toBe('ok');
    expect(admitAmong(open, v4)).toBe('ok');
  });

  it('the global cap still binds over every client', () => {
    const open = Array.from({ length: MAX_SOCKETS }, (_, i) => clientOf(`198.51.${i >> 8}.${i & 255}`));
    expect(admitAmong(open, clientOf('203.0.113.200'))).toBe('full');
  });
});
