// NPS response list — drill-through target for the dashboard's "NPS Score"
// KPI. Defaults to the current calendar month, mirroring the exact
// respondedAt/score predicate the dashboard's avgNPS calculation uses
// (task #113).
import { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import EmptyState from '../components/ui/EmptyState';

interface NpsRow {
  id: string;
  stage: string;
  score: number;
  respondedAt: string;
  leadId: string;
  clientName: string;
}

export default function NpsList() {
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<NpsRow[]>([]);
  const [average, setAverage] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const from = searchParams.get('from') ?? '';
  const to = searchParams.get('to') ?? '';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const data = await api.get<{ responses: NpsRow[]; total: number; average: number | null }>(`/nps?${params}`);
      setRows(data.responses);
      setAverage(data.average);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-h-screen">
      <div className="bg-white px-6 py-4" style={{ borderBottom: '1px solid #EDE8E3' }}>
        <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">NPS Responses</h1>
        <p className="text-sm text-stone-400 mt-0.5">
          This calendar month · Avg {average != null ? average.toFixed(1) : '—'}
        </p>
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
        ) : rows.length === 0 ? (
          <EmptyState title="No NPS responses match this view" description="No clients have responded this month yet." />
        ) : (
          <div className="bg-white rounded-2xl overflow-hidden shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-stone-400 uppercase" style={{ borderBottom: '1px solid #EDE8E3' }}>
                  <th className="py-3 px-4">Client</th>
                  <th className="py-3 px-4">Stage</th>
                  <th className="py-3 px-4">Score</th>
                  <th className="py-3 px-4">Responded On</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-stone-50">
                    <td className="py-3 px-4">
                      <Link to={`/leads/${r.leadId}`} className="text-brand-600 hover:text-brand-700 font-medium">
                        {r.clientName}
                      </Link>
                    </td>
                    <td className="py-3 px-4 text-stone-600">{r.stage.replace(/_/g, ' ')}</td>
                    <td className="py-3 px-4 font-medium text-stone-900">{r.score}</td>
                    <td className="py-3 px-4 text-stone-600">
                      {new Date(r.respondedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
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
