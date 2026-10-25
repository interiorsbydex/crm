import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Gift, MessageCircle } from 'lucide-react';
import { api } from '../lib/api';
import MailTemplateAttachmentEditor, { type MailTemplateAttachment } from '../components/MailTemplateAttachmentEditor';
import { getStoredUser } from '../lib/auth';

interface SLAConfig {
  rule: string;
  thresholdHours: number;
  updatedAt?: string;
}

interface StageSlaConfig {
  stage: string;
  label: string;
  warningDays: number;
  breachDays: number;
  isDefault: boolean;
}

interface Offer {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  startDate?: string;
  endDate?: string;
}

interface WATemplate {
  id: string;
  label: string;
  body: string;
  note?: string;
}

interface MailTemplate {
  code: string;
  label: string;
  description: string;
  placeholders: string[];
  subject: string;
  html: string;
  attachments?: MailTemplateAttachment[];
}

const SLA_ROWS: { rule: string; label: string }[] = [
  { rule: 'FIRST_CONTACT_24H',  label: 'First contact within N hours of creation' },
  { rule: 'LEAD_TO_MQL_5D',    label: 'Reach MQL within N hours (legacy Effective Lead cleanup)' },
  { rule: 'MQL_TO_DQL_5D',     label: 'DQL meeting scheduled within N hours of MQL' },
  { rule: 'PROPOSAL_TO_PP_2D', label: 'PP meeting scheduled within N hours of Proposal Ready' },
];

export default function Settings() {
  const navigate = useNavigate();
  const user = getStoredUser();

  useEffect(() => {
    if (!user) { navigate('/login', { replace: true }); return; }
    if (user.role !== 'BRANCH_HEAD') {
      toast.error("You don't have access to Settings.");
      navigate('/dashboard', { replace: true });
    }
  }, []);

  const [slaMap, setSlaMap]           = useState<Record<string, number>>({});
  const [editHours, setEditHours]     = useState<Record<string, string>>({});
  const [savingSLA, setSavingSLA]     = useState<string | null>(null);
  const [savedSLA, setSavedSLA]       = useState<Record<string, boolean>>({});

  const [stageSla, setStageSla]           = useState<StageSlaConfig[]>([]);
  const [stageSlaEdit, setStageSlaEdit]   = useState<Record<string, { warningDays: string; breachDays: string }>>({});
  const [savingStage, setSavingStage]     = useState<string | null>(null);
  const [savedStage, setSavedStage]       = useState<Record<string, boolean>>({});

  const [offers, setOffers]           = useState<Offer[]>([]);
  const [toggling, setToggling]       = useState<string | null>(null);
  const [newOfferName, setNewOfferName] = useState('');
  const [addingOffer, setAddingOffer] = useState(false);

  const [templates, setTemplates]     = useState<WATemplate[]>([]);
  const [loading, setLoading]         = useState(true);

  const [mailTemplates, setMailTemplates] = useState<MailTemplate[]>([]);
  const [mailEdit, setMailEdit]           = useState<Record<string, { subject: string; html: string; attachments?: MailTemplateAttachment[] }>>({});
  const [uploadingMailFiles, setUploadingMailFiles] = useState<Record<string, boolean>>({});
  const [savingMail, setSavingMail]       = useState<string | null>(null);
  const [savedMail, setSavedMail]         = useState<Record<string, boolean>>({});

  const [notifyConfig, setNotifyConfig]   = useState<Record<string, boolean>>({});
  const [savingNotify, setSavingNotify]   = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== 'BRANCH_HEAD') return;
    Promise.all([
      api.get<{ configs: SLAConfig[] }>('/admin/sla-config'),
      api.get<{ offers: Offer[] }>('/offers'),
      api.get<{ templates: WATemplate[] }>('/admin/whatsapp-templates'),
      api.get<{ configs: StageSlaConfig[] }>('/admin/stage-sla-config'),
      api.get<{ templates: MailTemplate[] }>('/admin/mail-templates'),
      api.get<{ config: Record<string, boolean> }>('/admin/notify-config'),
    ]).then(([sla, off, wa, stageSlaRes, mailRes, notifyRes]) => {
      setNotifyConfig(notifyRes.config ?? {});
      const m: Record<string, number> = {};
      const e: Record<string, string> = {};
      for (const c of (sla.configs ?? [])) {
        m[c.rule] = c.thresholdHours;
        e[c.rule] = String(c.thresholdHours);
      }
      setSlaMap(m);
      setEditHours(e);
      setOffers(off.offers ?? []);
      setTemplates(wa.templates ?? []);

      const rows = stageSlaRes.configs ?? [];
      setStageSla(rows);
      const se: Record<string, { warningDays: string; breachDays: string }> = {};
      for (const r of rows) se[r.stage] = { warningDays: String(r.warningDays), breachDays: String(r.breachDays) };
      setStageSlaEdit(se);

      const mt = mailRes.templates ?? [];
      setMailTemplates(mt);
      const me: Record<string, { subject: string; html: string }> = {};
      for (const t of mt) me[t.code] = { subject: t.subject, html: t.html };
      setMailEdit(me);
    }).catch((err) => toast.error(err.message))
      .finally(() => setLoading(false));
  }, []);

  const saveMailTemplate = async (code: string) => {
    const edit = mailEdit[code];
    if (!edit?.subject.trim() || !edit?.html.trim()) {
      toast.error('Subject and body cannot be empty'); return;
    }
    setSavingMail(code);
    try {
      await api.put(`/admin/mail-templates/${code}`, { subject: edit.subject, html: edit.html, ...(edit.attachments !== undefined ? { attachments: edit.attachments } : {}) });
      setMailTemplates((rows) => rows.map((t) => t.code === code ? { ...t, subject: edit.subject, html: edit.html, ...(edit.attachments !== undefined ? { attachments: edit.attachments } : {}) } : t));
      setSavedMail((s) => ({ ...s, [code]: true }));
      setTimeout(() => setSavedMail((s) => ({ ...s, [code]: false })), 2000);
    } catch (err: any) {
      toast.error(err.message ?? 'Save failed');
    } finally {
      setSavingMail(null);
    }
  };

  const resetMailTemplate = async (code: string) => {
    setSavingMail(code);
    try {
      const data = await api.delete<{ ok: true }>(`/admin/mail-templates/${code}`).catch(() => ({ ok: true }));
      void data;
      // Re-fetch this template's default from the server-computed effective value
      const res = await api.get<{ templates: MailTemplate[] }>('/admin/mail-templates');
      const mt = res.templates ?? [];
      setMailTemplates(mt);
      const t = mt.find((x) => x.code === code);
      if (t) setMailEdit((e) => ({ ...e, [code]: { subject: t.subject, html: t.html } }));
      toast.success('Reset to default');
    } catch (err: any) {
      toast.error(err.message ?? 'Reset failed');
    } finally {
      setSavingMail(null);
    }
  };

  const saveSLA = async (rule: string) => {
    const val = parseInt(editHours[rule] ?? '', 10);
    if (!val || val < 1) { toast.error('Enter a valid number of hours (≥ 1)'); return; }
    setSavingSLA(rule);
    try {
      const data = await api.patch<{ config: SLAConfig }>(`/admin/sla-config/${rule}`, { thresholdHours: val });
      const updated = data.config.thresholdHours;
      setSlaMap((m) => ({ ...m, [rule]: updated }));
      setEditHours((h) => ({ ...h, [rule]: String(updated) }));
      setSavedSLA((s) => ({ ...s, [rule]: true }));
      setTimeout(() => setSavedSLA((s) => ({ ...s, [rule]: false })), 2000);
    } catch (err: any) {
      toast.error(err.message ?? 'Save failed');
    } finally {
      setSavingSLA(null);
    }
  };

  const saveStageSla = async (stage: string) => {
    const edit = stageSlaEdit[stage];
    const warningDays = parseInt(edit?.warningDays ?? '', 10);
    const breachDays = parseInt(edit?.breachDays ?? '', 10);
    if (!warningDays || !breachDays || warningDays < 1 || breachDays < 1) {
      toast.error('Enter valid day counts (≥ 1)'); return;
    }
    if (warningDays > breachDays) {
      toast.error('Warning days cannot exceed breach days'); return;
    }
    setSavingStage(stage);
    try {
      const data = await api.patch<{ config: StageSlaConfig }>(`/admin/stage-sla-config/${stage}`, { warningDays, breachDays });
      setStageSla((rows) => rows.map((r) => r.stage === stage ? { ...r, ...data.config, isDefault: false } : r));
      setStageSlaEdit((e) => ({ ...e, [stage]: { warningDays: String(data.config.warningDays), breachDays: String(data.config.breachDays) } }));
      setSavedStage((s) => ({ ...s, [stage]: true }));
      setTimeout(() => setSavedStage((s) => ({ ...s, [stage]: false })), 2000);
    } catch (err: any) {
      toast.error(err.message ?? 'Save failed');
    } finally {
      setSavingStage(null);
    }
  };

  const toggleOffer = async (id: string, current: boolean) => {
    setToggling(id);
    setOffers((prev) => prev.map((o) => o.id === id ? { ...o, isActive: !current } : o));
    try {
      const data = await api.patch<{ offer: Offer }>(`/offers/${id}/toggle`, { isActive: !current });
      setOffers((prev) => prev.map((o) => o.id === id ? { ...o, isActive: data.offer.isActive } : o));
    } catch (err: any) {
      setOffers((prev) => prev.map((o) => o.id === id ? { ...o, isActive: current } : o));
      toast.error(err.message ?? 'Toggle failed');
    } finally {
      setToggling(null);
    }
  };

  const addOffer = async () => {
    const name = newOfferName.trim();
    if (!name) { toast.error('Offer name cannot be empty'); return; }
    setAddingOffer(true);
    try {
      const data = await api.post<{ offer: Offer }>('/offers', { name, isActive: true });
      setOffers((prev) => [...prev, data.offer]);
      setNewOfferName('');
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to add offer');
    } finally {
      setAddingOffer(false);
    }
  };

  const saveNotifyMandatory = async (key: string, value: boolean) => {
    setSavingNotify(key);
    const prev = notifyConfig[key] ?? false;
    setNotifyConfig((c) => ({ ...c, [key]: value }));
    try {
      const data = await api.put<{ config: Record<string, boolean> }>('/admin/notify-config', { [key]: value });
      setNotifyConfig(data.config ?? {});
    } catch (err: any) {
      setNotifyConfig((c) => ({ ...c, [key]: prev }));
      toast.error(err.message ?? 'Save failed');
    } finally {
      setSavingNotify(null);
    }
  };

  if (!user || user.role !== 'BRANCH_HEAD') return null;

  if (loading) {
    return (
      <div className="p-6 space-y-4 max-w-5xl mx-auto">
        <div className="h-8 w-48 bg-gray-200 rounded animate-pulse" />
        <div className="h-64 bg-gray-100 rounded-xl animate-pulse" />
        <div className="h-40 bg-gray-100 rounded-xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="px-6 py-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
        <p className="text-sm text-gray-500 mt-0.5">SLA rules, offers &amp; message templates</p>
      </div>

      {/* Section — Mandatory client notifications on status changes */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <span className="text-base">🔒</span>
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Mandatory client notifications</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                When on, the "notify client" checkbox is locked on for that flow, and the action is blocked if the lead is missing an email or phone.
              </p>
            </div>
          </div>
        </div>
        <div className="divide-y divide-gray-50">
          {[
            // On Hold and Inactive are now unconditionally mandatory (hardcoded in the UI) — no toggle needed.
            { key: 'notify_mandatory_reactivate', label: 'Reactivating a lead' },
          ].map(({ key, label }) => {
            const enabled = !!notifyConfig[key];
            const saving = savingNotify === key;
            return (
              <div key={key} className="px-5 py-3.5 flex items-center justify-between gap-4">
                <p className="text-sm text-gray-800">{label}</p>
                <button
                  onClick={() => saveNotifyMandatory(key, !enabled)}
                  disabled={saving}
                  role="switch"
                  aria-checked={enabled}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-brand-500' : 'bg-gray-200'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Section — Stage SLA Configuration (new stage-transition system, task #14) */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <span className="text-base">📈</span>
            <div>
              <h2 className="text-sm font-semibold text-gray-900">SLA Configuration — stage transitions</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Drives the SLA badges shown on the lead list, pipeline and lead detail roadmap.
                <span className="inline-flex items-center gap-1 ml-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-green-500" /> on track
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-400 ml-2" /> warning
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500 ml-2" /> breached
                </span>
              </p>
            </div>
          </div>
        </div>
        <div className="divide-y divide-gray-50">
          {stageSla.map((row) => {
            const edit = stageSlaEdit[row.stage] ?? { warningDays: String(row.warningDays), breachDays: String(row.breachDays) };
            const dirty = edit.warningDays !== String(row.warningDays) || edit.breachDays !== String(row.breachDays);
            const saving = savingStage === row.stage;
            const saved = savedStage[row.stage];
            return (
              <div key={row.stage} className="px-5 py-3.5 flex items-center gap-4 flex-wrap">
                <div className="min-w-[220px] flex-1">
                  <p className="text-sm text-gray-800 font-medium">{row.label}</p>
                  <p className="text-[10px] text-gray-400 mt-0.5 font-mono">{row.stage}{row.isDefault ? '' : ' · custom'}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-gray-400">Warning</label>
                  <input
                    type="number" min={1}
                    value={edit.warningDays}
                    onChange={(e) => setStageSlaEdit((s) => ({ ...s, [row.stage]: { ...edit, warningDays: e.target.value } }))}
                    className="w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-amber-300"
                  />
                  <span className="text-xs text-gray-400">d</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-xs text-gray-400">Breach</label>
                  <input
                    type="number" min={1}
                    value={edit.breachDays}
                    onChange={(e) => setStageSlaEdit((s) => ({ ...s, [row.stage]: { ...edit, breachDays: e.target.value } }))}
                    className="w-16 border border-gray-200 rounded-lg px-2 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-red-300"
                  />
                  <span className="text-xs text-gray-400">d</span>
                </div>
                <div className="ml-auto">
                  {saved ? (
                    <span className="text-green-600 font-medium text-sm">✓ Saved</span>
                  ) : (
                    <button
                      onClick={() => saveStageSla(row.stage)}
                      disabled={saving || !dirty}
                      className="text-xs font-medium px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white rounded-lg transition-colors flex items-center gap-1"
                    >
                      {saving ? (
                        <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : '💾'}
                      <span>{saving ? 'Saving…' : 'Save'}</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* A + B side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">

        {/* Section A — SLA Rules */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <span className="text-base">🕐</span>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">SLA rules</h2>
                <p className="text-xs text-gray-400 mt-0.5">Response-time thresholds (IST). The clock pauses while a lead is On Hold.</p>
              </div>
            </div>
          </div>
          <div className="divide-y divide-gray-50">
            {SLA_ROWS.map(({ rule, label }) => {
              const stored = slaMap[rule] ?? 0;
              const editing = editHours[rule] ?? String(stored);
              const dirty = editing !== String(stored);
              const saving = savingSLA === rule;
              const saved  = savedSLA[rule];
              return (
                <div key={rule} className="px-5 py-3.5">
                  <p className="text-xs text-gray-700 mb-2 leading-snug">{label}</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      value={editing}
                      onChange={(e) => setEditHours((h) => ({ ...h, [rule]: e.target.value }))}
                      className="w-20 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 text-center"
                    />
                    <span className="text-xs text-gray-400">hours</span>
                    <div className="ml-auto flex items-center gap-1.5">
                      {saved ? (
                        <span className="text-green-600 font-medium text-sm">✓ Saved</span>
                      ) : (
                        <button
                          onClick={() => saveSLA(rule)}
                          disabled={saving || !dirty}
                          className="text-xs font-medium px-3 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white rounded-lg transition-colors flex items-center gap-1"
                        >
                          {saving ? (
                            <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          ) : '💾'}
                          <span>{saving ? 'Saving…' : 'Save'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Section B — Offers & Schemes */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Gift size={16} strokeWidth={1.8} className="text-stone-500" />
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Offers &amp; schemes</h2>
                <p className="text-xs text-gray-400 mt-0.5">Seasonal offers that can be tagged on a lead or quote.</p>
              </div>
            </div>
          </div>
          <div className="px-5 py-4">
            {offers.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">No offers yet — add one below.</p>
            ) : (
              <div className="flex flex-wrap gap-2 mb-4">
                {offers.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => toggleOffer(o.id, o.isActive)}
                    disabled={toggling === o.id}
                    title={o.isActive ? 'Click to deactivate' : 'Click to activate'}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all border ${
                      o.isActive
                        ? 'bg-brand-500 border-brand-500 text-white hover:bg-brand-600'
                        : 'bg-gray-100 border-gray-200 text-gray-500 hover:bg-gray-200'
                    } disabled:opacity-50`}
                  >
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${o.isActive ? 'bg-white' : 'bg-gray-400'}`}
                    />
                    {o.name}
                    <span className={`text-[10px] ml-0.5 ${o.isActive ? 'text-white/70' : 'text-gray-400'}`}>
                      {o.isActive ? 'ON' : 'OFF'}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* Add new offer */}
            <div className="flex gap-2 pt-2 border-t border-gray-100">
              <input
                value={newOfferName}
                onChange={(e) => setNewOfferName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addOffer()}
                placeholder="e.g. Summer Special"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
              />
              <button
                onClick={addOffer}
                disabled={addingOffer || !newOfferName.trim()}
                className="px-3 py-1.5 text-sm font-medium bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white rounded-lg transition-colors whitespace-nowrap"
              >
                {addingOffer ? '…' : '+ Add'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Section C — WhatsApp Templates (full width) */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <MessageCircle size={16} strokeWidth={1.8} className="text-stone-500" />
            <div>
              <h2 className="text-sm font-semibold text-gray-900">WhatsApp templates</h2>
              <p className="text-xs text-gray-400 mt-0.5">Pre-approved with Meta/Twilio for the WhatsApp Business API — wording can't be changed without re-approval, so this list is read-only.</p>
            </div>
          </div>
        </div>
        <div className="divide-y divide-gray-50">
          {templates.map((t) => (
            <div key={t.id} className="px-5 py-4">
              <div className="flex items-center gap-2 mb-1.5">
                <p className="text-sm font-semibold text-gray-900">{t.label}</p>
                <span className="text-[10px] font-mono bg-gray-50 border border-gray-100 text-gray-400 px-1.5 py-0.5 rounded">
                  {t.id}
                </span>
              </div>
              <div className="bg-gray-50 rounded-lg px-3 py-2.5 text-xs text-gray-600 leading-relaxed whitespace-pre-wrap select-text cursor-text">
                {t.body}
              </div>
              {t.note && (
                <p className="text-[10px] text-gray-400 mt-1.5 italic">{t.note}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Section D — Mail Templates (Task #66, full width, editable) */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <MessageCircle size={16} strokeWidth={1.8} className="text-brand-500" />
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Mail templates</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                Default subject &amp; body for every system-triggered email. Editable per-send in the modal too — this sets what shows up pre-filled.
              </p>
            </div>
          </div>
        </div>
        <div className="divide-y divide-gray-50">
          {mailTemplates.map((t) => {
            const edit = mailEdit[t.code] ?? { subject: t.subject, html: t.html };
            const dirty = edit.subject !== t.subject || edit.html !== t.html
              || JSON.stringify(edit.attachments ?? t.attachments ?? []) !== JSON.stringify(t.attachments ?? []);
            return (
              <div key={t.code} className="px-5 py-4 space-y-2.5">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-gray-900">{t.label}</p>
                    <span className="text-[10px] font-mono bg-gray-50 border border-gray-100 text-gray-400 px-1.5 py-0.5 rounded">
                      {t.code}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5">{t.description}</p>
                  <p className="text-[10px] text-gray-400 mt-1">
                    Placeholders: {t.placeholders.map((p) => `{{${p}}}`).join(', ')}
                  </p>
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-gray-500 mb-1">Subject</label>
                  <input
                    value={edit.subject}
                    onChange={(e) => setMailEdit((m) => ({ ...m, [t.code]: { ...edit, subject: e.target.value } }))}
                    className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-gray-500 mb-1">Body (HTML)</label>
                  <textarea
                    value={edit.html}
                    onChange={(e) => setMailEdit((m) => ({ ...m, [t.code]: { ...edit, html: e.target.value } }))}
                    rows={5}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-300"
                  />
                </div>
                {t.code === 'OB_OBM_WELCOME' && (
                  <MailTemplateAttachmentEditor
                    attachments={edit.attachments ?? t.attachments ?? []}
                    disabled={savingMail === t.code}
                    onBusyChange={(busy) => setUploadingMailFiles((files) => ({ ...files, [t.code]: busy }))}
                    onChange={(attachments) => setMailEdit((edits) => ({ ...edits, [t.code]: { ...(edits[t.code] ?? edit), attachments } }))}
                  />
                )}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => saveMailTemplate(t.code)}
                    disabled={savingMail === t.code || uploadingMailFiles[t.code] || !dirty}
                    className="px-3 py-1.5 text-xs font-medium bg-brand-500 hover:bg-brand-600 disabled:opacity-40 text-white rounded-lg transition-colors"
                  >
                    {savingMail === t.code ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => resetMailTemplate(t.code)}
                    disabled={savingMail === t.code || uploadingMailFiles[t.code]}
                    className="px-3 py-1.5 text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 rounded-lg transition-colors"
                  >
                    Reset text to default
                  </button>
                  {savedMail[t.code] && <span className="text-xs text-green-600">Saved</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
