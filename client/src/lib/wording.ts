import { useEffect, useState } from 'react';

/**
 * Screen labels the client reworded in Admin → Wording (server: lib/wording.ts).
 * Loaded once (also before sign-in, for the app name); a label that wasn't
 * changed shows the screen's own default text.
 */
let current: Record<string, string> = {};
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

export function loadWording(force = false): Promise<void> {
  if (loaded && !force) return Promise.resolve();
  if (!inflight) {
    inflight = fetch('/api/config/wording')
      .then((r) => (r.ok ? r.json() : { wording: {} }))
      .then((d: { wording?: Record<string, string> }) => {
        current = d.wording ?? {};
        loaded = true;
        listeners.forEach((fn) => fn());
        if (current['app.fullName']) document.title = current['app.fullName'];
      })
      .catch(() => {})
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** The label for `key`, or `fallback` when the client hasn't changed it. */
export function wording(key: string, fallback: string): string {
  return current[key] ?? fallback;
}

/** Hook form: re-renders once the wording has loaded. */
export function useWording() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    loadWording().catch(() => {});
    return () => { listeners.delete(fn); };
  }, []);
  return wording;
}
