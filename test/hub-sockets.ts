// The live hub's sockets for its tests: the Workers answer to an upgrade (status 101, which the test runtime's
// Response refuses) and the hub's end of a WebSocketPair, whose listeners are kept so a test can close it as a reader
// leaving would. stubHubSockets puts both in place; the sockets the hub accepted are listed in order.
import { vi } from 'vitest';

/** A Response that reads 101 when made with it, as the platform's upgrade answer does. */
export class Upgrade extends Response {
  private up: boolean;
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    this.up = init?.status === 101;
  }
  // an accessor over Response's own status getter
  get status() { return this.up ? 101 : super.status; }
}

/** One end of a socket pair: accepts, sends nothing anywhere, and fires its own listeners when told to. */
export class FakeSocket {
  private on = new Map<string, () => void>();
  accept() {}
  send() {}
  close() {}
  addEventListener(type: string, f: () => void) { this.on.set(type, f); }
  fire(type: string) { this.on.get(type)?.(); }
}

/** WebSocketPair and Response stubbed for LiveHub.fetch('/ws'); returns the hub's ends of the pairs made, in order. */
export function stubHubSockets(): FakeSocket[] {
  const ends: FakeSocket[] = [];
  vi.stubGlobal('WebSocketPair', class { 0: FakeSocket; 1: FakeSocket; constructor() { this[0] = new FakeSocket(); this[1] = new FakeSocket(); ends.push(this[1]); } });
  vi.stubGlobal('Response', Upgrade);
  return ends;
}
