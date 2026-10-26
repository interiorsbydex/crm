// Designer Client Health drill-down: Healthy / At Risk / Critical, each a clickable list.
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Heart } from 'lucide-react';
import { api } from '../lib/api';
import EmptyState from '../components/ui/EmptyState';
import { formulas } from '../lib/formulas';

type Health = 'HEALTHY' | 'AT_RISK' | 'CRITICAL';
type ContactStatus = 'RECENT' | 'WARNING' | 'HIGH_RISK' | 'UNKNOWN';
const CONTACT_LABELS: Record<ContactStatus, string> = { RECENT: 'Recent contact', WARNING: 'Warning', HIGH_RISK: 'High Risk', UNKNOWN: 'Unknown' };
interface Item {
  kind: 'LEAD' | 'PROJECT'; id: string; leadDbId: string; leadId: string; clientName: string;
  stage: string; projectCode?: string; health: Health; attentionCount: number; reason: string | null; detailsPct: number;
  informationStatus?: 'COMPLETE' | 'DATA_INCOMPLETE';
  contactHealth?: { status: ContactStatus; lastContactAt: string | null; daysSinceContact: number | null; reason: string | null };
}
interface Resp {
  counts: { total: number; healthy: number; atRisk: number; critical: number }; items: Item[];
  contactCounts?: { recent: number; warning: number; highRisk: number; unknown: number };
}

const SECTIONS: { key: Health; label: string; dot: string; bg: string; ring: string; count: keyof Resp['counts'] }[] = [
  { key: 'HEALTHY', label: 'Healthy', dot: 'bg-green-500', bg: 'bg-green-50', ring: 'ring-green-400', count: 'healthy' },
  { key: 'AT_RISK', label: 'At Risk', dot: 'bg-amber-500', bg: 'bg-amber-50', ring: 'ring-amber-400', count: 'atRisk' },
  { key: 'CRITICAL', label: 'Critical', dot: 'bg-red-500', bg: 'bg-red-50', ring: 'ring-red-400', count: 'critical' },
];
const stageLabel = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export default function ClientHealth() {
  const [params, setParams] = useSearchParams();
  const active = (params.get('health') as Health | null) ?? null;
  const contactFilter = params.get('contact') as ContactStatus | null;
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Resp>('/client-health').then(setData).catch((e) => setError(e.message));
  }, []);

  const shown = SECTIONS.filter((s) => !active || s.key === active);

  return (
    <div className="min-h-screen">
      <div className="bg-white px-6 py-4" style={{ borderBottom: '1px solid #EDE8E3' }}>
        <div className="flex items-center gap-3">
          <Heart size={24} fill="currentColor" className="text-brand-600" />
          <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Client Health</h1>
        </div>
        <p className="text-sm text-stone-400 mt-0.5">Information completeness and completed-contact health are separate indicators.</p>
      </div>
      <div className="p-6 space-y-5 max-w-5xl">
        {error && <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm">{error}</div>}
        {!data && !error && <p className="text-sm text-stone-400">Loading…</p>}
        {data && (
          <>
            {data.contactCounts && (
              <section className="space-y-3" data-testid="contact-health-summary">
                <h2 className="text-sm font-bold text-stone-800">Client contact</h2>
                <p className="text-xs text-stone-500">Dated answered calls and completed meetings only. Warning at {formulas().contactHealth.warningDays} IST calendar days; High Risk at {formulas().contactHealth.highRiskDays}. Unanswered calls, planned meetings and messages do not reset contact health. Missing dates remain Unknown. Automatic alerts are not activated.</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {([
                    ['RECENT', data.contactCounts.recent], ['WARNING', data.contactCounts.warning],
                    ['HIGH_RISK', data.contactCounts.highRisk], ['UNKNOWN', data.contactCounts.unknown],
                  ] as [ContactStatus, number][]).map(([key, count]) => (
                    <button key={key} onClick={() => setParams(contactFilter === key ? {} : { contact: key })}
                      className={`rounded-xl border bg-white p-4 text-left ${contactFilter === key ? 'ring-2 ring-brand-400' : 'border-stone-100'}`}
                      data-testid={`contact-filter-${key}`}>
                      <p className="text-2xl font-bold">{count}</p><p className="text-sm text-stone-600">{CONTACT_LABELS[key]}</p>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <h2 className="text-sm font-bold text-stone-800">Information completeness</h2>
            <p className="text-xs text-stone-500">Completeness bands: {formulas().completeness.healthyFrom}%+ Healthy, {formulas().completeness.atRiskFrom}–{formulas().completeness.healthyFrom - 1}% At Risk, under {formulas().completeness.atRiskFrom}% Critical. Any missing required detail is still marked Data incomplete.</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <button
                onClick={() => setParams({})}
                className={`rounded-xl border border-stone-100 bg-white p-4 text-left ${!active ? 'ring-2 ring-brand-400' : ''}`}
              >
                <p className="text-3xl font-extrabold text-stone-900">{data.counts.total}</p>
                <p className="mt-1 text-sm text-stone-500">All active clients</p>
              </button>
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setParams({ health: s.key })}
                  className={`rounded-xl p-4 text-left ${s.bg} ${active === s.key ? `ring-2 ${s.ring}` : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-3.5 w-3.5 rounded-full ${s.dot}`} />
                    <p className="text-2xl font-extrabold text-stone-900">{data.counts[s.count]}</p>
                  </div>
                  <p className="mt-1 text-sm font-medium text-stone-700">{s.label}</p>
                </button>
              ))}
            </div>

            {shown.map((s) => {
              const rows = data.items.filter((i) => i.health === s.key && (!contactFilter || i.contactHealth?.status === contactFilter));
              return (
                <section key={s.key} data-testid={`health-${s.key}`}>
                  <h2 className="flex items-center gap-2 text-sm font-bold text-stone-800 mb-2">
                    <span className={`h-3 w-3 rounded-full ${s.dot}`} /> {s.label} ({rows.length})
                  </h2>
                  {rows.length === 0 ? (
                    <EmptyState title={`No ${s.label.toLowerCase()} clients`} description="Nothing to show in this group right now." />
                  ) : (
                    <div className="bg-white rounded-2xl overflow-x-auto" style={{ border: '1px solid #EDE8E3' }}>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-stone-400 uppercase tracking-wide">
                            <th className="px-4 py-3">Client</th><th className="px-4 py-3">Stage / Phase</th>
                            <th className="px-4 py-3">Details filled</th><th className="px-4 py-3">Missing</th>
                            <th className="px-4 py-3">Contact health</th><th className="px-4 py-3">Latest verified contact (IST)</th><th className="px-4 py-3">Calendar days</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r) => (
                            <tr key={`${r.kind}:${r.id}`} style={{ borderTop: '1px solid #F3EEE9' }}>
                              <td className="px-4 py-2.5">
                                <Link to={`/leads/${r.leadDbId}`} className="text-brand-600 hover:underline">
                                  {r.projectCode ?? r.leadId} · {r.clientName}
                                </Link>
                              </td>
                              <td className="px-4 py-2.5 text-stone-600">{stageLabel(r.stage)}</td>
                              <td className="px-4 py-2.5 text-stone-700 font-semibold">{r.detailsPct}%<span className="block text-xs font-normal">{r.informationStatus === 'COMPLETE' || r.detailsPct === 100 ? 'Complete' : 'Data incomplete'}</span></td>
                              <td className="px-4 py-2.5 text-stone-600">
                                {r.reason ?? 'None'}
                              </td>
                              <td className="px-4 py-2.5 text-stone-700" data-testid={`contact-${r.leadDbId}`}>
                                <span className="font-semibold">{CONTACT_LABELS[r.contactHealth?.status ?? 'UNKNOWN']}</span>
                                {r.contactHealth?.reason && <p className="mt-1 min-w-48 text-xs text-stone-500">{r.contactHealth.reason}</p>}
                              </td>
                              <td className="px-4 py-2.5 whitespace-nowrap">{r.contactHealth?.lastContactAt
                                ? new Date(r.contactHealth.lastContactAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded'}</td>
                              <td className="px-4 py-2.5">{r.contactHealth?.daysSinceContact ?? 'N/A'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
