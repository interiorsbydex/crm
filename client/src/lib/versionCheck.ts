import { useEffect, useState } from 'react';

/**
 * After a Publish, browsers can keep showing the previous version of the CRM because the
 * hosting sends the page without a "don't cache" instruction. Every minute (and whenever
 * the tab comes back to the front) we fetch the page fresh and compare its script file
 * with the one this tab is running; when they differ, a new version is out.
 */
const CHECK_SECONDS = 60;
const SCRIPT_RE = /\/assets\/index-[\w-]+\.js/;

/** The main script file named in a page's HTML, e.g. "/assets/index-NFEyq338.js". */
export function mainScriptIn(html: string): string | null {
  return html.match(SCRIPT_RE)?.[0] ?? null;
}

function runningScript(): string | null {
  const src = Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))
    .map((s) => new URL(s.src, location.href).pathname)
    .find((p) => SCRIPT_RE.test(p));
  return src ?? null;
}

/** Reloads with a throw-away query value so the browser cannot answer from its cache. */
export function reloadToNewVersion() {
  const url = new URL(location.href);
  url.searchParams.set('_v', String(Date.now()));
  location.replace(url.toString());
}

/** Removes the throw-away value from the address bar once the fresh page has loaded. */
function tidyAddress() {
  const url = new URL(location.href);
  if (!url.searchParams.has('_v')) return;
  url.searchParams.delete('_v');
  history.replaceState(history.state, '', url.toString());
}

export function useNewVersionAvailable(): boolean {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    tidyAddress();
    const mine = runningScript();
    // Running from the dev server (no built script file): nothing to compare.
    if (!mine) return;
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/?_v=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const latest = mainScriptIn(await res.text());
        if (latest && latest !== mine) setAvailable(true);
      } catch { /* offline for a moment: try again next time */ }
    };
    const tick = window.setInterval(check, CHECK_SECONDS * 1000);
    const onVisibility = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisibility);
    check();
    return () => {
      stopped = true;
      window.clearInterval(tick);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return available;
}
