// Wallet login (signed message), session storage, and pairing — browser side.
import type { Chain } from '../../../shared/types';
import { assertLoginMessage } from '../../../shared/login';

export interface Session { token: string; address: string; chain: Chain; linked: string | null; via: 'namada' | 'keplr' | 'pair'; expiresAt: number }

declare global {
  interface Window {
    namada?: {
      connect?: (chainId?: string) => Promise<void>;
      isConnected?: (chainId?: string) => Promise<boolean>;
      getSigner?: () => { accounts: () => Promise<any[]>; signArbitrary: (signer: string, data: string) => Promise<{ hash: string; signature: string } | undefined> } | undefined;
      accounts?: () => Promise<any[]>;
      defaultAccount?: () => Promise<any>;
    };
    keplr?: {
      enable: (chainId: string) => Promise<void>;
      getKey: (chainId: string) => Promise<{ bech32Address: string; pubKey: Uint8Array }>;
      signArbitrary: (chainId: string, signer: string, data: string | Uint8Array) => Promise<{ pub_key: { type: string; value: string }; signature: string }>;
    };
  }
}

const KEY = 'nt.session';
const NAMADA_CHAIN = 'namada.5f5de2dd1b88cba30586420';
const OSMOSIS_CHAIN = 'osmosis-1';

export function loadSession(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null') as Session | null;
    return s && s.expiresAt > Date.now() ? s : null;
  } catch { return null; }
}
export function storeSession(s: Session | null) {
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch {}
}

/** Fired on window when the server refuses the stored session (it ended, or was signed out from another device). */
export const SESSION_ENDED_EVENT = 'nt:session-ended';

export async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const s = loadSession();
  const headers = new Headers(init.headers || {});
  if (s) headers.set('Authorization', `Bearer ${s.token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  // A refused token is dead: forget it here and tell the app, so no page keeps saying "signed in" with it.
  if (res.status === 401 && s) {
    storeSession(null);
    try { window.dispatchEvent(new Event(SESSION_ENDED_EVENT)); } catch {}
  }
  return res;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(path, { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const hasNamada = () => typeof window !== 'undefined' && !!window.namada;
export const hasKeplr = () => typeof window !== 'undefined' && !!window.keplr;

export async function loginWithNamada(): Promise<Session> {
  const w = window.namada;
  if (!w) throw new Error('Namada Keychain extension not found');
  await w.connect?.(NAMADA_CHAIN);
  const signer = w.getSigner?.();
  const accounts = (await (signer?.accounts?.() ?? w.accounts?.())) ?? [];
  const acct = accounts.find((a: any) => a.type !== 'shielded-keys' && String(a.address || '').startsWith('tnam1')) ?? (await w.defaultAccount?.());
  if (!acct?.address) throw new Error('No transparent account in the Keychain');
  const { nonce, message } = await post<{ nonce: string; message: string }>('/api/auth/nonce', { address: acct.address });
  // The wallet signs the sign-in message and nothing else, whatever the server answered.
  assertLoginMessage(acct.address, nonce, message);
  const signed = await signer?.signArbitrary?.(acct.address, message);
  if (!signed?.signature) throw new Error('Signing was cancelled');
  const session = await post<{ session: Session }>('/api/auth/login', { address: acct.address, nonce, pubkey: acct.publicKey, signature: signed.signature });
  storeSession(session.session);
  return session.session;
}

export async function loginWithKeplr(): Promise<Session> {
  const k = window.keplr;
  if (!k) throw new Error('Keplr not found (on a phone, open this page inside the Keplr app browser)');
  await k.enable(OSMOSIS_CHAIN);
  const key = await k.getKey(OSMOSIS_CHAIN);
  const { nonce, message } = await post<{ nonce: string; message: string }>('/api/auth/nonce', { address: key.bech32Address });
  assertLoginMessage(key.bech32Address, nonce, message);
  const sig = await k.signArbitrary(OSMOSIS_CHAIN, key.bech32Address, message);
  const session = await post<{ session: Session }>('/api/auth/login', { address: key.bech32Address, nonce, pubkey: sig.pub_key.value, signature: sig.signature });
  storeSession(session.session);
  return session.session;
}

export async function claimPairCode(code: string): Promise<Session> {
  const r = await post<{ session: Session }>('/api/auth/pair/claim', { code });
  storeSession(r.session);
  return r.session;
}

export async function createPairCode(): Promise<{ code: string; expiresAt: number }> {
  return post('/api/auth/pair', {});
}

export async function logout() {
  try { await authFetch('/api/auth/logout', { method: 'POST' }); } catch {}
  storeSession(null);
}
