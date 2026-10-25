import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Megaphone, Sparkles, Pencil, Trash2, Plus, RefreshCw } from 'lucide-react';
import { dashboardContentApi, type DashboardContentDraft, type DashboardContentItem, type DashboardContentKind } from '../../lib/dashboardContent';
import { isSafeHttpsUrl } from '../dashboard/DashboardContent';

type Form = { kind: DashboardContentKind; title: string; body: string; imageUrl: string; linkUrl: string };
type Editing = { mode: 'create' } | { mode: 'edit'; item: DashboardContentItem };
const blank = (kind: DashboardContentKind = 'ANNOUNCEMENT'): Form => ({ kind, title: '', body: '', imageUrl: '', linkUrl: '' });
const KIND_LABEL: Record<DashboardContentKind, string> = { ANNOUNCEMENT: 'Announcement', INSPIRATION: 'Design Inspiration of the Week' };
const isConflict = (msg: string) => /409|conflict|revision|edited elsewhere|deleted elsewhere|modified/i.test(msg);
const CONFLICT_MSG = 'This item was edited or deleted elsewhere. Refresh the list and reopen it — your text is kept below so you can copy it.';

function validate(f: Form): Record<string, string> {
  const e: Record<string, string> = {};
  const t = f.title.trim();
  if (!t) e.title = 'Title is required';
  else if (t.length > 160) e.title = 'Title must be 160 characters or fewer';
  if (!f.body.trim()) e.body = 'Text is required';
  else if (f.body.length > 5000) e.body = 'Text must be 5000 characters or fewer';
  for (const k of ['imageUrl', 'linkUrl'] as const) {
    if (f[k].trim() && !isSafeHttpsUrl(f[k].trim())) e[k] = 'Use a full https:// address without a username or password';
  }
  return e;
}

const input = 'mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400';

export default function DashboardContentAdmin() {
  const [items, setItems] = useState<DashboardContentItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [form, setForm] = useState<Form>(blank());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await dashboardContentApi.adminList();
      if (my !== seq.current) return;
      setItems(r.items); setLoadError(null);
    } catch (e: any) {
      if (my === seq.current) setLoadError(e?.message ?? 'Could not load content');
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openCreate = (kind: DashboardContentKind) => { setEditing({ mode: 'create' }); setForm(blank(kind)); setErrors({}); setFormError(null); };
  const openEdit = (item: DashboardContentItem) => {
    setEditing({ mode: 'edit', item });
    setForm({ kind: item.kind, title: item.title, body: item.body, imageUrl: item.imageUrl ?? '', linkUrl: item.linkUrl ?? '' });
    setErrors({}); setFormError(null); setConfirmId(null);
  };
  const cancel = () => { if (saving) return; setEditing(null); setForm(blank()); setErrors({}); setFormError(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !editing) return;
    const v = validate(form);
    setErrors(v);
    if (Object.keys(v).length) { setFormError('Fix the highlighted fields'); return; }
    const draft: DashboardContentDraft = {
      kind: form.kind, title: form.title.trim(), body: form.body,
      imageUrl: form.imageUrl.trim() || null, linkUrl: form.linkUrl.trim() || null,
    };
    setSaving(true); setFormError(null);
    try {
      if (editing.mode === 'create') await dashboardContentApi.create(draft);
      else await dashboardContentApi.update(editing.item, draft);
      toast.success(editing.mode === 'create' ? 'Content published' : 'Changes saved');
      setEditing(null); setForm(blank());
      await load();
    } catch (err: any) {
      const msg = err?.message ?? 'Could not save';
      const m = isConflict(msg) ? CONFLICT_MSG : msg;
      setFormError(m); toast.error(m);
    } finally { setSaving(false); }
  };

  const doDelete = async (item: DashboardContentItem) => {
    if (deletingId) return;
    setDeletingId(item.id);
    try {
      await dashboardContentApi.remove(item);
      toast.success('Deleted');
      setConfirmId(null);
      await load();
    } catch (err: any) {
      const msg = err?.message ?? 'Could not delete';
      toast.error(isConflict(msg) ? 'This item was edited or deleted elsewhere. Refresh the list and try again.' : msg);
    } finally { setDeletingId(null); }
  };

  const field = (k: keyof Form) => ({
    value: form[k], disabled: saving,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value })),
    'aria-invalid': !!errors[k], 'aria-describedby': errors[k] ? `dc-${k}-err` : undefined,
  });
  const err = (k: string) => errors[k] && <span id={`dc-${k}-err`} className="mt-1 block text-[11px] text-red-500">{errors[k]}</span>;

  return (
    <div className="space-y-6" data-testid="admin-dashboard-content">
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-gray-900">Dashboard Content</h2>
            <p className="mt-1 text-xs text-gray-500">Announcements and Design Inspiration of the Week shown on Business Lead dashboards. Plain text; images and references are optional https links.</p>
          </div>
          {!editing && (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => openCreate('ANNOUNCEMENT')} data-testid="button-new-announcement"
                className="inline-flex items-center gap-1 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600">
                <Plus size={14} /> New announcement
              </button>
              <button type="button" onClick={() => openCreate('INSPIRATION')} data-testid="button-new-inspiration"
                className="inline-flex items-center gap-1 rounded-lg border border-brand-500 px-3 py-2 text-sm font-medium text-brand-600 hover:bg-brand-50">
                <Plus size={14} /> New inspiration
              </button>
            </div>
          )}
        </div>

        {editing && (
          <form onSubmit={submit} noValidate className="mt-5 space-y-4" data-testid="form-dashboard-content">
            <h3 className="text-sm font-semibold text-gray-800">{editing.mode === 'create' ? 'New content' : 'Edit content'}</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-medium text-gray-800">Type
                <select {...field('kind')} className={input} data-testid="input-content-kind">
                  <option value="ANNOUNCEMENT">{KIND_LABEL.ANNOUNCEMENT}</option>
                  <option value="INSPIRATION">{KIND_LABEL.INSPIRATION}</option>
                </select>
              </label>
              <label className="block text-xs font-medium text-gray-800">Title
                <input {...field('title')} maxLength={160} className={input} data-testid="input-content-title" />
                <span className="mt-1 block text-[11px] text-gray-400">{form.title.trim().length}/160</span>
                {err('title')}
              </label>
            </div>
            <label className="block text-xs font-medium text-gray-800">Text (required)
              <textarea {...field('body')} rows={6} className={`${input} resize-y`} data-testid="input-content-body" />
              <span className="mt-1 block text-[11px] text-gray-400">{form.body.length}/5000</span>
              {err('body')}
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-medium text-gray-800">Image URL (optional)
                <input {...field('imageUrl')} type="url" inputMode="url" placeholder="https://" className={input} data-testid="input-content-image-url" />
                {err('imageUrl')}
              </label>
              <label className="block text-xs font-medium text-gray-800">Reference link (optional)
                <input {...field('linkUrl')} type="url" inputMode="url" placeholder="https://" className={input} data-testid="input-content-link-url" />
                {err('linkUrl')}
              </label>
            </div>
            {formError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600" data-testid="text-content-form-error">{formError}</p>}
            <div className="flex gap-3">
              <button type="submit" disabled={saving} data-testid="button-save-content"
                className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40">
                {saving ? 'Saving…' : editing.mode === 'create' ? 'Publish' : 'Save changes'}
              </button>
              <button type="button" onClick={cancel} disabled={saving} data-testid="button-cancel-content"
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">Cancel</button>
            </div>
          </form>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-900">Published content{items ? ` (${items.length})` : ''}</h2>
          <button type="button" onClick={load} disabled={loading} data-testid="button-refresh-content"
            className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-40">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
        {loading && !items ? (
          <div className="p-5 space-y-3">{[0, 1].map((i) => <div key={i} className="h-14 rounded-lg bg-gray-100 animate-pulse" />)}</div>
        ) : loadError && !items ? (
          <div className="p-5 text-sm text-red-600 flex items-center justify-between gap-3" role="alert" data-testid="admin-content-error">
            <span>Could not load content: {loadError}</span>
            <button type="button" onClick={load} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs" data-testid="button-retry-content">Retry</button>
          </div>
        ) : items && items.length === 0 ? (
          <p className="p-8 text-center text-sm text-gray-400" data-testid="admin-content-empty">Nothing published yet. Create an announcement or inspiration above.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {items?.map((it) => {
              const Icon = it.kind === 'INSPIRATION' ? Sparkles : Megaphone;
              const confirming = confirmId === it.id;
              return (
                <li key={it.id} className="px-5 py-4" data-testid="admin-content-item" data-content-id={it.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 inline-flex items-center gap-1"><Icon size={12} />{KIND_LABEL[it.kind]}</p>
                      <p className="font-medium text-gray-900 break-words">{it.title}</p>
                      <p className="text-xs text-gray-500 line-clamp-2 whitespace-pre-wrap break-words">{it.body}</p>
                      <p className="mt-1 text-[11px] text-gray-400">Updated {new Date(it.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
                    </div>
                    {confirming ? (
                      <div className="flex items-center gap-2 text-xs" role="group" aria-label={`Confirm delete ${it.title}`}>
                        <span className="text-red-600">Delete this item?</span>
                        <button type="button" onClick={() => doDelete(it)} disabled={!!deletingId} data-testid="button-confirm-delete-content"
                          className="rounded-lg bg-red-500 px-3 py-1.5 font-medium text-white hover:bg-red-600 disabled:opacity-40">
                          {deletingId === it.id ? 'Deleting…' : 'Confirm delete'}
                        </button>
                        <button type="button" onClick={() => setConfirmId(null)} disabled={deletingId === it.id} data-testid="button-cancel-delete-content"
                          className="rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700">Cancel</button>
                      </div>
                    ) : (
                      <div className="flex gap-2 text-xs">
                        <button type="button" onClick={() => openEdit(it)} disabled={saving} data-testid="button-edit-content" aria-label={`Edit ${it.title}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-40"><Pencil size={12} /> Edit</button>
                        <button type="button" onClick={() => setConfirmId(it.id)} disabled={!!deletingId} data-testid="button-delete-content" aria-label={`Delete ${it.title}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-3 py-1.5 text-red-600 hover:bg-red-50 disabled:opacity-40"><Trash2 size={12} /> Delete</button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {loadError && items && <p className="px-5 pb-3 text-xs text-red-500">Refresh failed: {loadError}</p>}
      </div>
    </div>
  );
}
