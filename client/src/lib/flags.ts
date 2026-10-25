import { useEffect, useState } from 'react';
import { api } from './api';

interface Flags { lenientLaunch: boolean }

let cached: Flags | null = null;
let inflight: Promise<Flags> | null = null;

function loadFlags(): Promise<Flags> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = api.get<Flags>('/config/flags')
      .then((f) => { cached = f; return f; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * Mirrors the server's LENIENT_LAUNCH switch. Defaults to strict (false) until
 * the flag loads, so a lenient-only code path never opens by accident.
 */
export function useLenientLaunch(): boolean {
  const [lenient, setLenient] = useState(cached?.lenientLaunch ?? false);
  useEffect(() => {
    let live = true;
    loadFlags().then((f) => { if (live) setLenient(f.lenientLaunch); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return lenient;
}
