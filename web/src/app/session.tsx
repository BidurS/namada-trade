// Who is signed in (F1 wiring around lib/auth.ts, which is unchanged). A session proves an
// address by a signed message; nothing moves. Signing out ends this device's session only.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { loadSession, logout, SESSION_ENDED_EVENT, type Session } from '../lib/auth';

export type { Session };

export interface SessionValue {
  session: Session | null;
  /** After a successful sign-in (the sign-in sheet calls this). */
  setSession: (s: Session | null) => void;
  /** Sign this device out. */
  signOut: () => Promise<void>;
}

const SessionCtx = createContext<SessionValue>({ session: null, setSession: () => {}, signOut: async () => {} });

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const signOut = useCallback(async () => {
    try {
      await logout();
    } finally {
      setSession(null);
    }
  }, []);
  // The server refused the stored token (lib/auth.ts authFetch): this device is signed out.
  useEffect(() => {
    const ended = () => setSession(null);
    window.addEventListener(SESSION_ENDED_EVENT, ended);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, ended);
  }, []);
  const value = useMemo(() => ({ session, setSession, signOut }), [session, signOut]);
  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}

/** { session, setSession, signOut } */
export const useSession = (): SessionValue => useContext(SessionCtx);
