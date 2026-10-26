import { useCallback, useEffect, useState } from 'react';
import { useReportTabs } from '../../lib/dashboardLayout';
import { reportTabId, REPORT_BLOCK_IDS } from '../../lib/dashboardTiles';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { stageLabel } from '../../lib/crmSettings';

type DrillLead = { id: string; leadId: string; name: string; [k: string]: unknown };
export type TableData = {
  title: string;
  columns: { key: string; label: string }[];
  rows: { cells: Record<string, unknown>; drill?: Record<string, DrillLead[]>; na?: Record<string, string> }[];
};
type ReportData = { notes: string[]; summary?: Record<string, unknown>; tables: TableData[] };

const BL_TABS = [
  { key: 'bl-performance', label: 'BL Performance' },
  { key: 'bl-pipeline', label: 'BL Pipeline' },
  { key: 'bl-conversion', label: 'BL Conversion' },
  { key: 'discount-metrics', label: 'Discount Metrics' },
  { key: 'team-meetings', label: 'Team Meetings' },
];
const ADMIN_TABS = [
  { key: 'company-lead-summary', label: 'Company Lead Summary' },
  { key: 'company-pipeline', label: 'Company Pipeline' },
  { key: 'designer-performance-all', label: 'Designer Performance (All)' },
  { key: 'bl-performance-all', label: 'BL Performance (All)' },
  { key: 'source-campaign', label: 'Source & Campaign' },
  { key: 'inactive-leads', label: 'Inactive Leads' },
  { key: 'lead-aging', label: 'Lead Aging' },
  { key: 'trend', label: 'Trend' },
  { key: 'offer-performance', label: 'Offer Performance' },
];

// LeadStage enum values (prisma/schema.prisma) — the server rejects anything else with HTTP 400.
const STAGE_OPTIONS = [
  { value: 'EFFECTIVE_LEAD', label: 'Effective Lead (legacy)' },
  { value: 'MQL', label: 'MQL' },
  { value: 'DQL', label: 'DQL' },
  { value: 'PROPOSAL_READY', label: 'Proposal Ready' },
  { value: 'PROPOSAL_PRESENTED', label: 'Proposal Presented' },
  { value: 'PROPOSAL_DISCUSSION', label: 'Proposal Discussion' },
  { value: 'ONBOARDING', label: 'Onboarding' },
  { value: 'ONBOARDING_MEETING', label: 'Onboarding Meeting' },
  { value: 'DESIGN_IN_PROGRESS', label: 'Design in Progress' },
  { value: 'HANDED_OVER', label: 'Handed Over (legacy)' },
  { value: 'INACTIVE', label: 'Inactive (legacy)' },
  { value: 'ON_HOLD', label: 'On Hold (legacy)' },
];

const isFullDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 2000 && !Number.isNaN(Date.parse(v));
const isUserId = (v: string) => /^c[a-z0-9]{24}$/.test(v);
/** Returns why the filters cannot be sent yet (null = complete and valid). Nothing is requested while this is non-null. */
function filterIssue(f: { from: string; to: string; designerId: string; blId: string }): string | null {
  if (f.from && !isFullDate(f.from)) return 'Enter a complete From date (year 2000 or later) to apply the filter.';
  if (f.to && !isFullDate(f.to)) return 'Enter a complete To date (year 2000 or later) to apply the filter.';
  if (f.from && f.to && f.to < f.from) return '"To" date is before "From" date.';
  if (f.designerId && !isUserId(f.designerId)) return 'Designer ID is not a complete ID yet.';
  if (f.blId && !isUserId(f.blId)) return 'BL ID is not a complete ID yet.';
  return null;
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
const exportTable = (tab: string, t: TableData) =>
  download(
    `${tab}-${t.title.replace(/[^a-z0-9]+/gi, '_')}.csv`,
    [t.columns.map((c) => csvCell(c.label)).join(','), ...t.rows.map((r) => t.columns.map((c) => csvCell(r.cells[c.key])).join(','))].join('\n'),
  );

export function Table({ tab, t }: { tab: string; t: TableData }) {
  const [open, setOpen] = useState<{ r: number; k: string } | null>(null);
  const leads = open ? t.rows[open.r]?.drill?.[open.k] ?? [] : [];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-800">{t.title}</p>
        <button onClick={() => exportTable(tab, t)} className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50">Export CSV</button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-100 text-left text-gray-400">
              {t.columns.map((c) => <th key={c.key} className="py-1.5 pr-3 font-medium">{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {t.rows.map((r, i) => (
              <tr key={i} className="border-b border-gray-50">
                {t.columns.map((c) => {
                  const v = r.cells[c.key];
                  const d = r.drill?.[c.key];
                  const txt = typeof v === 'number' ? v.toLocaleString('en-IN') : String(v ?? '—');
                  const why = r.na?.[c.key];
                  return (
                    <td key={c.key} className="py-1.5 pr-3">
                      {d ? (
                        <button className="text-brand-600 hover:underline" onClick={() => setOpen(open?.r === i && open.k === c.key ? null : { r: i, k: c.key })}>{txt}</button>
                      ) : txt}
                      {why && <span className="ml-1 text-[10px] text-gray-400" title={why} data-testid="na-reason">({why})</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <div className="rounded-lg border border-gray-100 bg-gray-50 p-3" data-testid="drill-panel">
          <p className="mb-1 text-xs font-medium text-gray-600">Leads ({leads.length})</p>
          {leads.length === 0 ? <p className="text-xs text-gray-400">No leads.</p> : (
            <ul className="space-y-0.5 text-xs">
              {leads.map((l, i) => (
                <li key={`${l.id}-${i}`}><Link className="text-brand-600 hover:underline" to={`/leads/${l.id}`}>{l.name}</Link> <span className="text-gray-500">{l.leadId}</span></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function BlAdminReports({ role }: { role: string }) {
  // BL: no separate Team Meetings tab (meeting performance is not wanted for BL).
  const { visible: tabs, blockHidden, heading } = useReportTabs(
    REPORT_BLOCK_IDS.ba, (k) => reportTabId('ba', k),
    role === 'BRANCH_HEAD' ? [...BL_TABS, ...ADMIN_TABS] : BL_TABS.filter((t) => t.key !== 'team-meetings'),
    role === 'BRANCH_HEAD' ? 'BL & Admin Reports' : 'BL Reports',
  );
  const [tabSel, setTab] = useState(BL_TABS[0].key);
  // If the tab last opened was hidden, fall back to the first one still shown.
  const tab = tabs.find((t) => t.key === tabSel)?.key ?? tabs[0]?.key ?? tabSel;
  const [f, setF] = useState({ from: '', to: '', designerId: '', blId: '', source: '', stage: '', projectType: '', location: '' });
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inputs are applied after a short pause and only when complete/valid, so partial typing never reaches the server.
  const [applied, setApplied] = useState(f);
  useEffect(() => {
    const t = setTimeout(() => setApplied(f), 400);
    return () => clearTimeout(t);
  }, [f]);
  const issue = filterIssue(f);
  const appliedIssue = filterIssue(applied);

  const load = useCallback(async () => {
    if (blockHidden) return;
    if (appliedIssue) { setData(null); setError(null); return; }
    const p = new URLSearchParams();
    Object.entries(applied).forEach(([k, v]) => { if (v.trim()) p.set(k, v.trim()); });
    setLoading(true); setError(null);
    try {
      const res = await api.get<{ data: ReportData }>(`/bl-admin-reports/${tab}?${p.toString()}`);
      setData(res.data);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : 'Failed to load report');
    } finally { setLoading(false); }
  }, [tab, applied, appliedIssue, blockHidden]);
  useEffect(() => { void load(); }, [load]);

  const field = (k: keyof typeof f, label: string, type = 'text') => (
    <label className="text-xs text-gray-500">{label}
      <input type={type} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}
        className="mt-1 block w-32 rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
    </label>
  );

  if (blockHidden) return null;

  return (
    <div className="space-y-3" data-testid="bl-admin-reports">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">{heading}</p>
      <div className="space-y-4 rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-1.5" role="tablist">
          {tabs.map((t) => (
            <button key={t.key} role="tab" data-testid={`bl-tab-${t.key}`} aria-selected={tab === t.key}
              onClick={() => { setTab(t.key); setData(null); }}
              className={`rounded-full px-3 py-1 text-xs font-medium ${tab === t.key ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{t.label}</button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {field('from', 'From', 'date')}{field('to', 'To', 'date')}
          {field('designerId', 'Designer ID')}
          {role === 'BRANCH_HEAD' && field('blId', 'BL ID')}
          {field('source', 'Source')}
          <label className="text-xs text-gray-500">Stage
            <select data-testid="bl-stage-select" value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}
              className="mt-1 block w-44 rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
              <option value="">All</option>
              {STAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{['EFFECTIVE_LEAD', 'HANDED_OVER', 'INACTIVE', 'ON_HOLD'].includes(o.value) ? o.label : stageLabel(o.value)}</option>)}
            </select>
          </label>
          {field('projectType', 'Project type')}{field('location', 'Location')}
        </div>
        {issue && <p className="text-xs text-amber-700" data-testid="filter-issue">{issue} No request is sent until the value is complete.</p>}
        {loading && <p className="text-xs text-gray-400">Loading…</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
        {data && !loading && (
          <div className="space-y-5" data-testid={`bl-report-${tab}`}>
            <ul className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              {data.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
            {data.tables.map((t, i) => <Table key={`${tab}-${i}`} tab={tab} t={t} />)}
          </div>
        )}
      </div>
    </div>
  );
}
