import { useEffect, useRef } from 'react';

/**
 * Keeps a screen's numbers current, the way a shared spreadsheet feels:
 * - right after any change made in this browser (any tab): every successful
 *   save/move/upload through the api announces itself (notifyDataChanged);
 * - every few seconds while the tab is in front, for changes made by others;
 * - whenever the tab is brought back to the front.
 * Nothing refreshes while the tab is hidden, so open tabs cost the server nothing.
 */
export const LIVE_REFRESH_SECONDS = 15;

const EVENT = 'crm:data-changed';
const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('crm-data-changed') : null;

/** Called by the api after a successful change; other open tabs of this browser hear it too. */
export function notifyDataChanged() {
  window.dispatchEvent(new Event(EVENT));
  try { channel?.postMessage(Date.now()); } catch { /* another tab may be closing */ }
}

export function useLiveRefresh(refresh: () => unknown, seconds = LIVE_REFRESH_SECONDS) {
  const latest = useRef(refresh);
  latest.current = refresh;

  useEffect(() => {
    let pending: number | undefined;
    // Several saves in a row (or a save plus a focus) refresh once, shortly after.
    const soon = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => { if (document.visibilityState === 'visible') latest.current(); }, 400);
    };
    const tick = window.setInterval(() => { if (document.visibilityState === 'visible') latest.current(); }, seconds * 1000);
    const onVisibility = () => { if (document.visibilityState === 'visible') soon(); };
    window.addEventListener(EVENT, soon);
    window.addEventListener('focus', soon);
    document.addEventListener('visibilitychange', onVisibility);
    channel?.addEventListener('message', soon);
    return () => {
      window.clearTimeout(pending);
      window.clearInterval(tick);
      window.removeEventListener(EVENT, soon);
      window.removeEventListener('focus', soon);
      document.removeEventListener('visibilitychange', onVisibility);
      channel?.removeEventListener('message', soon);
    };
  }, [seconds]);
}
