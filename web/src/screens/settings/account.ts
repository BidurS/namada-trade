// The signed-in user's saved settings (S6), shared by Alerts (the rule switches, the delivery
// line) and Settings. api.ts and lib/auth.ts are used unchanged; the server merges partial
// updates (worker/src/settings.ts applyUpdate), so each control saves only what it changed.
import { useCallback, useEffect, useState } from 'react';
import type { UserSettings } from '../../../../shared/types';
import { fetchSettings, updateSettings } from '../../api';
import type { Session } from '../../lib/auth';
import { plainError } from '../sheets/util';

export interface UserSettingsState {
  settings: UserSettings | null;
  /** Why the settings could not be read, in plain words. */
  error: string | null;
  /** The session was refused (it ended or was signed out elsewhere). */
  expired: boolean;
  /** Send a partial update; resolves with the saved settings, rejects with the server's reason. */
  save: (patch: unknown) => Promise<UserSettings>;
  reload: () => void;
}

export function useUserSettings(session: Session | null): UserSettingsState {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [n, setN] = useState(0);
  const token = session?.token ?? null;

  useEffect(() => {
    setSettings(null);
    setError(null);
    setExpired(false);
    if (!token) return;
    let alive = true;
    fetchSettings()
      .then((s) => alive && setSettings(s))
      .catch((e: unknown) => {
        if (!alive) return;
        const msg = e instanceof Error ? e.message : String(e);
        setExpired(/sign in first|HTTP 401/i.test(msg));
        setError(plainError(e, 'Your settings could not be read right now.'));
      });
    return () => {
      alive = false;
    };
  }, [token, n]);

  const save = useCallback(async (patch: unknown) => {
    const s = await updateSettings(patch);
    setSettings(s);
    return s;
  }, []);
  const reload = useCallback(() => setN((x) => x + 1), []);

  return { settings, error, expired, save, reload };
}
