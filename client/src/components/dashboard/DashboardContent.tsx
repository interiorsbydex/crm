/**
 * DashboardContent — read-only Announcements and Design Inspiration of the Week,
 * managed by admins. Plain-text rendering only; optional HTTPS image and link.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Megaphone, Sparkles, ExternalLink, ImageOff, RefreshCw } from 'lucide-react';
import { dashboardContentApi, type DashboardContentItem } from '../../lib/dashboardContent';

const POLL_MS = 60_000;
const PREVIEW_CHARS = 280;

export function isSafeHttpsUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch { return false; }
}

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
};

function ContentImage({ src, alt }: { src: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (broken) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-stone-50 px-3 py-4 text-xs text-stone-400" data-testid="content-image-broken" style={{ border: '1px dashed #E5DED6' }}>
        <ImageOff size={14} strokeWidth={1.8} /> Image could not be loaded
      </div>
    );
  }
  return (
    <img src={src} alt={alt} referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)}
      className="w-full max-h-64 object-cover rounded-xl bg-stone-100" data-testid="content-image" />
  );
}

function ContentCard({ item }: { item: DashboardContentItem }) {
  const [expanded, setExpanded] = useState(false);
  const isInspo = item.kind === 'INSPIRATION';
  const long = item.body.length > PREVIEW_CHARS;
  const shown = long && !expanded ? `${item.body.slice(0, PREVIEW_CHARS).trimEnd()}…` : item.body;
  const Icon = isInspo ? Sparkles : Megaphone;
  return (
    <article data-testid="dashboard-content-item" data-content-id={item.id} data-content-kind={item.kind}
      className="bg-white rounded-2xl p-3 sm:p-4 shadow-warm-sm flex flex-col gap-3 min-w-0" style={{ border: '1px solid #EDE8E3' }}>
      <div className="flex flex-wrap min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-wide">
        <span className={`inline-flex min-w-0 max-w-full items-start gap-1 rounded-full px-2 py-0.5 ${isInspo ? 'bg-amber-50 text-amber-700' : 'bg-brand-50 text-brand-600'}`}>
          <Icon size={12} strokeWidth={2} className="shrink-0 mt-0.5" /><span className="min-w-0 [overflow-wrap:anywhere]">{isInspo ? 'Design Inspiration of the Week' : 'Announcement'}</span>
        </span>
        <span className="text-stone-400 font-normal normal-case tracking-normal">{fmtDate(item.updatedAt)}</span>
      </div>
      {isSafeHttpsUrl(item.imageUrl) && <ContentImage src={item.imageUrl} alt={item.title} />}
      <h4 className="font-bold text-stone-900 break-words" data-testid="dashboard-content-title">{item.title}</h4>
      <p className="text-sm text-stone-600 whitespace-pre-wrap break-words leading-relaxed" data-testid="dashboard-content-body">{shown}</p>
      <div className="flex flex-wrap items-center gap-4 text-xs font-medium">
        {long && (
          <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}
            className="text-brand-600 hover:underline" data-testid="button-content-toggle">
            {expanded ? 'Show less' : 'Read full text'}
          </button>
        )}
        {isSafeHttpsUrl(item.linkUrl) && (
          <a href={item.linkUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
            className="inline-flex min-w-0 max-w-full items-center gap-1 text-brand-600 hover:underline" data-testid="link-content-reference">
            <span className="min-w-0 [overflow-wrap:anywhere]">Open reference</span><ExternalLink size={12} strokeWidth={2} className="shrink-0" /><span className="sr-only">(opens in new tab)</span>
          </a>
        )}
      </div>
    </article>
  );
}

export default function DashboardContent({ embedded = false, title = 'Announcements and inspiration' }: { embedded?: boolean; title?: string } = {}) {
  const [items, setItems] = useState<DashboardContentItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const r = await dashboardContentApi.list();
      if (!mounted.current || my !== seq.current) return;
      setItems(r.items); setError(null);
    } catch (e: any) {
      if (!mounted.current || my !== seq.current) return;
      setError(e?.message ?? 'Could not load updates');
    } finally {
      if (mounted.current && my === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    const tick = () => { if (document.visibilityState === 'visible') load(); };
    const id = window.setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      mounted.current = false;
      window.clearInterval(id);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  const announcements = items?.filter((i) => i.kind === 'ANNOUNCEMENT') ?? [];
  const inspirations = items?.filter((i) => i.kind === 'INSPIRATION') ?? [];

  return (
    <section className={`${embedded ? '' : 'px-3 sm:px-6 pt-4'} min-w-0 max-w-7xl mx-auto [overflow-wrap:anywhere]`} data-testid="dashboard-content" aria-labelledby="dashboard-content-heading">
      <div className="flex min-w-0 items-end justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h3 id="dashboard-content-heading" className="font-bold text-stone-900">{title}</h3>
          <p className="text-xs text-stone-400 mt-0.5">Shared by the admin team</p>
        </div>
      </div>
      {loading && !items ? (
        <div className="grid gap-3 md:grid-cols-2" aria-busy="true" data-testid="dashboard-content-loading">
          {[0, 1].map((i) => <div key={i} className="h-32 rounded-2xl bg-stone-100 animate-pulse" />)}
        </div>
      ) : error && !items ? (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-600 flex flex-wrap items-center justify-between gap-3" data-testid="dashboard-content-error" role="alert">
          <span>Could not load announcements: {error}</span>
          <button type="button" onClick={() => { setLoading(true); load(); }} data-testid="button-content-retry"
            className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium hover:bg-red-50">
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      ) : items && items.length === 0 ? (
        <div className="bg-white rounded-2xl p-5 text-sm text-stone-400 text-center" style={{ border: '1px dashed #E5DED6' }} data-testid="dashboard-content-empty">
          No announcements or design inspiration have been posted yet.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 items-start">
          {[...announcements, ...inspirations].map((it) => <ContentCard key={it.id} item={it} />)}
        </div>
      )}
      {error && items && (
        <p className="mt-2 text-xs text-red-500" role="status">Latest refresh failed; showing previously loaded content.</p>
      )}
    </section>
  );
}
