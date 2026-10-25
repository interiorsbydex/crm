import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * What the signed-in user may do (Admin → Permissions; server: lib/permissions.ts).
 * Loaded once after sign-in by Layout. Screens use it to hide buttons the user
 * can't use; the server enforces the same rules regardless.
 */
let current: Record<string, boolean> = {};
let loaded = false;
let inflight: Promise<Record<string, boolean>> | null = null;
const listeners = new Set<(p: Record<string, boolean>) => void>();

export function loadMyPermissions(force = false): Promise<Record<string, boolean>> {
  if (loaded && !force) return Promise.resolve(current);
  if (!inflight) {
    inflight = api.get<{ permissions: Record<string, boolean> }>('/config/my-permissions')
      .then(({ permissions }) => {
        current = permissions;
        loaded = true;
        listeners.forEach((fn) => fn(permissions));
        return permissions;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Hook: can(key) is true while permissions are still loading, so nothing flickers away. */
export function usePermissions() {
  const [p, setP] = useState(current);
  useEffect(() => {
    listeners.add(setP);
    if (!loaded) loadMyPermissions().catch(() => {});
    else setP(current);
    return () => { listeners.delete(setP); };
  }, []);
  return { can: (key: string) => (loaded ? p[key] === true : true) };
}
