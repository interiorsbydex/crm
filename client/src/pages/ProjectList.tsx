// Project list — role-scoped view of design/delivery projects backing the
// dashboard's "In Delivery" / "Outstanding" / "Needs Attention" KPI tiles.
// Reuses GET /api/projects (already role-scoped: designer's own + approved
// team projects, BL's team, all projects for BRANCH_HEAD/ADMIN).
import { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import EmptyState from '../components/ui/EmptyState';

interface ProjectRow {
  id: string;
  projectCode: string;
  phase: string;
  health: string;
  contractValue: number | null;
  outstandingAmount: number | null;
  lead: { id: string; leadId: string; name: string; phone: string };
  designer?: { id: string; name: string } | null;
  _count?: { collections: number; attentionFlags: number };
  attentionFlags: Array<{ id: string; category: string; description: string }>;
}

const PHASE_LABELS: Record<string, string> = {
  DESIGN: 'Design Development',
  TECHNICAL: 'Technical',
  PRODUCTION: 'Production',
  SITE_EXECUTION: 'Site Execution',
  HANDOVER: 'Handover',
  COMPLETED: 'Completed',
};

const HEALTH_COLORS: Record<string, string> = {
  ON_TRACK: 'bg-green-100 text-green-700',
  AT_RISK: 'bg-amber-100 text-amber-700',
  DELAYED: 'bg-red-100 text-red-700',
};

const fmt = (n: number | null | undefined) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')}`;

export default function ProjectList() {
  const [searchParams] = useSearchParams();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters are seeded from the URL so dashboard KPI tiles can deep-link in,
  // e.g. /projects?excludePhases=HANDOVER,COMPLETED&hasAttention=true.
  const excludePhases = searchParams.get('excludePhases') ?? '';
  const hasAttention = searchParams.get('hasAttention') ?? '';
  const hasOutstanding = searchParams.get('hasOutstanding') ?? '';
  const phase = searchParams.get('phase') ?? '';
  const dashboardScope = searchParams.get('dashboardScope') ?? '';
  const leadStage = searchParams.get('leadStage') ?? '';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (phase) params.set('phase', phase);
      if (excludePhases) params.set('excludePhases', excludePhases);
      if (hasAttention) params.set('hasAttention', hasAttention);
      if (hasOutstanding) params.set('hasOutstanding', hasOutstanding);
      if (dashboardScope) params.set('dashboardScope', dashboardScope);
      if (leadStage) params.set('leadStage', leadStage);
      const data = await api.get<{ projects: ProjectRow[]; total: number }>(`/projects?${params}`);
      setProjects(data.projects);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [phase, excludePhases, hasAttention, hasOutstanding, dashboardScope, leadStage]);

  useEffect(() => { load(); }, [load]);

  const LEAD_STAGE_LABELS: Record<string, string> = { DESIGN_IN_PROGRESS: 'Design In Progress' };

  const filterLabel =
    hasAttention === 'true' ? 'Projects needing attention' :
    hasOutstanding === 'true' ? 'Projects with outstanding balance' :
    leadStage ? `Active projects — ${LEAD_STAGE_LABELS[leadStage] ?? leadStage}` :
    excludePhases ? 'Projects currently in delivery' :
    phase ? `Projects in ${PHASE_LABELS[phase] ?? phase}` :
    'All projects';

  return (
    <div className="min-h-screen">
      <div className="bg-white px-6 py-4" style={{ borderBottom: '1px solid #EDE8E3' }}>
        <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Projects</h1>
        <p className="text-sm text-stone-400 mt-0.5">{filterLabel}</p>
      </div>

      <div className="p-6">
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm mb-4">{error}</div>
        )}

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 rounded-2xl animate-pulse" style={{ background: '#EDE8E3' }} />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState title="No projects match this view" description="Nothing to show for the selected filter." />
        ) : (
          <div className="bg-white rounded-2xl overflow-hidden shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-stone-400 uppercase" style={{ borderBottom: '1px solid #EDE8E3' }}>
                  <th className="py-3 px-4">Project</th>
                  <th className="py-3 px-4">Client</th>
                  <th className="py-3 px-4">Phase</th>
                  <th className="py-3 px-4">Health</th>
                  <th className="py-3 px-4">Contract Value</th>
                  <th className="py-3 px-4">Outstanding</th>
                  <th className="py-3 px-4">Attention</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {projects.map((p) => (
                  <tr key={p.id} className="hover:bg-stone-50">
                    <td className="py-3 px-4 font-medium text-stone-900">{p.projectCode}</td>
                    <td className="py-3 px-4">
                      <Link to={`/leads/${p.lead.id}`} className="text-brand-600 hover:text-brand-700 font-medium">
                        {p.lead.name}
                      </Link>
                    </td>
                    <td className="py-3 px-4 text-stone-600">{PHASE_LABELS[p.phase] ?? p.phase}</td>
                    <td className="py-3 px-4">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${HEALTH_COLORS[p.health] ?? 'bg-stone-100 text-stone-600'}`}>
                        {p.health.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-stone-700">{fmt(p.contractValue)}</td>
                    <td className="py-3 px-4 text-stone-700">{fmt(p.outstandingAmount)}</td>
                    <td className="py-3 px-4">
                      {p.attentionFlags.length > 0 ? (
                        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-semibold bg-red-100 text-red-700">
                          <AlertTriangle size={11} /> {p.attentionFlags[0].category}
                        </span>
                      ) : (
                        <span className="text-stone-300 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
