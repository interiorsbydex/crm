/**
 * CREDashboard — role-specific portal for Customer Relationship Executives.
 *
 * Shows a live snapshot of their scoped lead pipeline:
 *   • Four stat tiles  : EL count · MQL awaiting BL · MQL with BL · Pushback leads
 *   • Three lead tables: grouped by stage + BL allocation status
 *
 * All data is fetched from existing CRE-scoped endpoints — no new server
 * endpoint needed.  The /meta/status-summary already applies the CRE OR-clause
 * (assignedCREId | assignedDesignerId | createdById), and /api/leads does the
 * same via leadScope.ts.
 */
import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  RefreshCw, AlertTriangle, ChevronRight, Clock, Users, CheckCircle2,
} from 'lucide-react';
import { api } from '../lib/api';
import { sourceLabel } from '../lib/crmSettings';
import { Tile, TileGroup, useDashboardLayout } from '../lib/dashboardLayout';

// ── Types ─────────────────────────────────────────────────────────────────────
interface CRELead {
  id: string;
  leadId: string;
  name: string;
  phone: string;
  source?: string | null;
  stage: string;
  status: string;
  intentRating?: number | null;
  estimatedValue?: number | null;
  possessionTimeline?: string | null;
  assignedBLId?: string | null;
  assignedBL?: { id: string; name: string } | null;
  assignedCREId?: string | null;
  mqlPushbackCount?: number;
  mqlPushbackReason?: string | null;
  mqlPushbackAt?: string | null;
  leadAgeAtMQL?: number | null;
  createdAt: string;
}

interface StatusSummary {
  overall: Record<string, { count: number; value: number }>;
  perStage: Record<string, Record<string, { count: number; value: number }>>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const SOURCE_SHORT: Record<string, string> = {
  META_ADS: 'Meta', GOOGLE_ADS: 'Google', WALK_IN: 'Walk-in',
  REFERRAL: 'Referral', WEBSITE: 'Website', INSTAGRAM: 'IG',
  WHATSAPP: 'WhatsApp', COLD_CALL: 'Cold Call', EXHIBITION: 'Exhibition',
};

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function StarRating({ rating }: { rating?: number | null }) {
  if (!rating) return <span className="text-gray-300 text-xs">—</span>;
  return (
    <span className="text-xs text-amber-400">
      {'★'.repeat(rating)}
      <span className="text-gray-200">{'★'.repeat(5 - rating)}</span>
    </span>
  );
}

function AgeBadge({ days, warn = 7 }: { days: number; warn?: number }) {
  const hot = days >= warn;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium px-1.5 py-0.5 rounded-full ${
      hot ? 'bg-red-100 text-red-600' : 'bg-sky-50 text-sky-600'}`}>
      <Clock size={9} />
      {days}d
    </span>
  );
}

// ── Stat tile ─────────────────────────────────────────────────────────────────
function StatTile({
  label, value, sub, accent, icon: Icon,
}: {
  label: string; value: number; sub?: string;
  accent: string; icon: React.ComponentType<import('lucide-react').LucideProps>;
}) {
  return (
    <div className="bg-white rounded-2xl px-5 py-4 shadow-warm-sm flex items-start justify-between"
      style={{ border: '1px solid #EDE8E3' }}>
      <div>
        <p className="text-xs text-gray-400 mb-1">{label}</p>
        <p className="text-3xl font-bold text-gray-900">{value}</p>
        {sub && <p className="text-[11px] text-gray-400 mt-0.5">{sub}</p>}
      </div>
      <div className={`rounded-xl p-2.5 ${accent}`}>
        <Icon size={18} />
      </div>
    </div>
  );
}

// ── Lead row ──────────────────────────────────────────────────────────────────
function LeadRow({ lead }: { lead: CRELead }) {
  const ageDays = daysSince(lead.createdAt);
  const hasPushback = (lead.mqlPushbackCount ?? 0) > 0;

  return (
    <tr className="hover:bg-stone-50 transition-colors group">
      <td className="px-4 py-3 text-xs font-mono text-gray-500 whitespace-nowrap">
        {lead.leadId}
      </td>
      <td className="px-4 py-3">
        <div>
          <p className="text-sm font-medium text-gray-900 leading-tight">{lead.name}</p>
          <p className="text-[11px] text-gray-400">{lead.phone}</p>
        </div>
      </td>
      <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
        {SOURCE_SHORT[lead.source ?? ''] ?? (lead.source ? sourceLabel(lead.source) : '—')}
      </td>
      <td className="px-4 py-3">
        <StarRating rating={lead.intentRating} />
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        <AgeBadge days={ageDays} warn={lead.stage === 'MQL' ? 5 : 10} />
      </td>
      <td className="px-4 py-3">
        {hasPushback ? (
          <span className="inline-flex items-center gap-0.5 text-[11px] bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded-full font-medium">
            <AlertTriangle size={9} />
            ↩ ×{lead.mqlPushbackCount}
          </span>
        ) : (
          <span className="text-gray-200 text-xs">—</span>
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        {lead.assignedBL ? (
          <span className="text-xs text-gray-600">{lead.assignedBL.name}</span>
        ) : (
          <span className="text-[11px] text-amber-600 font-medium">Awaiting</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <Link
          to={`/leads/${lead.id}`}
          className="inline-flex items-center gap-1 text-xs text-brand-500 font-medium hover:underline group-hover:opacity-100 opacity-60 transition-opacity"
        >
          View <ChevronRight size={12} />
        </Link>
      </td>
    </tr>
  );
}

// ── Section table ─────────────────────────────────────────────────────────────
function LeadSection({
  title, leads, accent, emptyText,
}: {
  title: string; leads: CRELead[]; accent: string; emptyText: string;
}) {
  return (
    <div className="bg-white rounded-2xl overflow-hidden shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
      <div className={`px-5 py-3 flex items-center justify-between border-b ${accent}`}
        style={{ borderColor: '#EDE8E3' }}>
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="text-xs font-medium bg-white/70 px-2 py-0.5 rounded-full text-gray-600">
          {leads.length} lead{leads.length !== 1 ? 's' : ''}
        </span>
      </div>
      {leads.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-gray-400">{emptyText}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead>
              <tr className="border-b" style={{ borderColor: '#EDE8E3' }}>
                {['ID', 'Client', 'Source', 'Intent', 'Age', 'Pushback', 'BL', ''].map((h) => (
                  <th key={h} className="px-4 py-2 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-50">
              {leads.map((l) => <LeadRow key={l.id} lead={l} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function CREDashboard() {
  const L = useDashboardLayout('cre').label;
  const [summary, setSummary] = useState<StatusSummary | null>(null);
  const [leads, setLeads] = useState<CRELead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (bg = false) => {
    if (!bg) setLoading(true);
    else setRefreshing(true);
    try {
      const [summaryRes, leadsRes] = await Promise.all([
        api.get<StatusSummary>('/leads/meta/status-summary'),
        // Fetch active CRE leads across all stages; the server applies CRE scope
        // automatically via leadScope.ts. Request a generous page size so we
        // can group client-side without a second round-trip.
        api.get<{ leads: CRELead[]; total: number }>('/leads?status=ACTIVE&limit=200&sortBy=createdAt&sortDir=desc'),
      ]);
      setSummary(summaryRes);
      setLeads(leadsRes.leads ?? []);
    } catch {
      /* silent — partial data is still useful */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live refresh on window focus / every 60s
  useEffect(() => {
    const poll = () => load(true);
    const iv = setInterval(poll, 60000);
    const onFocus = () => poll();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(iv); window.removeEventListener('focus', onFocus); };
  }, [load]);

  // ── Derived counts from status-summary ──────────────────────────────────────
  const elActive = summary?.perStage?.EFFECTIVE_LEAD?.ACTIVE?.count ?? 0;

  // ── Derived groups from lead list ───────────────────────────────────────────
  const elLeads = leads.filter((l) => l.stage === 'EFFECTIVE_LEAD');
  const mqlLeads = leads.filter((l) => l.stage === 'MQL');
  const mqlAwaitingBL = mqlLeads.filter((l) => !l.assignedBLId);
  const mqlWithBL = mqlLeads.filter((l) => !!l.assignedBLId);
  const pushbackLeads = leads.filter((l) => (l.mqlPushbackCount ?? 0) > 0);

  // ── Skeleton ────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white rounded-2xl h-24 animate-pulse" style={{ border: '1px solid #EDE8E3' }} />
          ))}
        </div>
        <div className="bg-white rounded-2xl h-48 animate-pulse" style={{ border: '1px solid #EDE8E3' }} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">CRE Portal</h1>
          <p className="text-xs text-gray-400 mt-0.5">Your lead pipeline — qualify, push to MQL, and allocate BLs</p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 border border-gray-200 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* ── Stat tiles ──────────────────────────────────────────────────────── */}
      <TileGroup dashboard="cre" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
<Tile id="cre.atEffectiveLead">
        <StatTile
          label={L('cre.atEffectiveLead', 'At Effective Lead')}
          value={elActive}
          sub="awaiting qualification"
          accent="bg-indigo-50 text-indigo-500"
          icon={Users}
        />
        </Tile>
<Tile id="cre.mqlAwaitingBl">
        <StatTile
          label={L('cre.mqlAwaitingBl', 'MQL — Awaiting BL')}
          value={mqlAwaitingBL.length}
          sub={mqlAwaitingBL.length > 0 ? 'action required' : 'all allocated'}
          accent={mqlAwaitingBL.length > 0 ? 'bg-amber-50 text-amber-500' : 'bg-green-50 text-green-500'}
          icon={AlertTriangle}
        />
        </Tile>
<Tile id="cre.mqlBlAssigned">
        <StatTile
          label={L('cre.mqlBlAssigned', 'MQL — BL Assigned')}
          value={mqlWithBL.length}
          sub="in BL's queue"
          accent="bg-green-50 text-green-500"
          icon={CheckCircle2}
        />
        </Tile>
<Tile id="cre.pushedBack">
        <StatTile
          label={L('cre.pushedBack', 'Pushed Back')}
          value={pushbackLeads.length}
          sub={pushbackLeads.length > 0 ? 'needs re-qualification' : 'none outstanding'}
          accent={pushbackLeads.length > 0 ? 'bg-rose-50 text-rose-500' : 'bg-stone-50 text-stone-400'}
          icon={AlertTriangle}
        />
        </Tile>
      </TileGroup>

      {/* ── Pushback callout ─────────────────────────────────────────────────── */}
      {pushbackLeads.length > 0 && (
        <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 text-xs text-amber-800">
          <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-500" />
          <div>
            <span className="font-semibold">
              {pushbackLeads.length} lead{pushbackLeads.length !== 1 ? 's' : ''} returned by BL for re-qualification.
            </span>{' '}
            Review the pushback reason on each lead, address the gap, then re-qualify to MQL.
          </div>
        </div>
      )}

      <TileGroup dashboard="cre" className="space-y-5">
      {/* ── Effective Lead section ───────────────────────────────────────────── */}
      <Tile id="cre.elSection">
      <LeadSection
        title={L('cre.elSection', 'Effective Lead — Pending Qualification')}
        leads={elLeads}
        accent="border-b bg-indigo-50/50 text-indigo-700"
        emptyText="No leads at Effective Lead stage — nice work! 🎯"
      />
      </Tile>

      {/* ── MQL awaiting BL section ─────────────────────────────────────────── */}
      <Tile id="cre.mqlAwaitingSection">
      <LeadSection
        title={L('cre.mqlAwaitingSection', 'MQL — Awaiting BL Allocation')}
        leads={mqlAwaitingBL}
        accent={mqlAwaitingBL.length > 0 ? 'border-b bg-amber-50/50 text-amber-700' : 'border-b bg-stone-50/50 text-stone-500'}
        emptyText="All MQL leads have been allocated to a BL ✓"
      />
      </Tile>

      {/* ── MQL with BL section ─────────────────────────────────────────────── */}
      <Tile id="cre.mqlAssignedSection">
      <LeadSection
        title={L('cre.mqlAssignedSection', 'MQL — BL Assigned')}
        leads={mqlWithBL}
        accent="border-b bg-green-50/50 text-green-700"
        emptyText="No leads in this state yet."
      />
      </Tile>
      </TileGroup>
    </div>
  );
}
