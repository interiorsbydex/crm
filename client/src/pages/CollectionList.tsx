// Collections (payments) list — drill-through target for the dashboard's
// "Collected This Month" KPI. Defaults to the current calendar month, the
// same default the dashboard aggregate uses, so the tile and this list
// always agree (task #113).
import { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import EmptyState from '../components/ui/EmptyState';

interface CollectionRow {
  id: string;
  milestone: string;
  amount: number;
  status: string;
  dueDate: string | null;
  collectedAt: string | null;
  projectId: string;
  projectCode: string;
  leadId: string;
  clientName: string;
}

const fmt = (n: number | null | undefined) =>
  n == null ? '—' : `₹${Number(n).toLocaleString('en-IN')}`;

export default function CollectionList() {
  const [searchParams] = useSearchParams();
  const [rows, setRows] = useState<CollectionRow[]>([]);
  const [sum, setSum] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const status = searchParams.get('status') ?? '';
  const from = searchParams.get('from') ?? '';
  const to = searchParams.get('to') ?? '';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const data = await api.get<{ collections: CollectionRow[]; total: number; sum: number }>(`/collections?${params}`);
      setRows(data.collections);
      setSum(data.sum);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [status, from, to]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="min-h-screen">
      <div className="bg-white px-6 py-4" style={{ borderBottom: '1px solid #EDE8E3' }}>
        <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Collections</h1>
        <p className="text-sm text-stone-400 mt-0.5">
          {status === 'COLLECTED' ? 'Collected this calendar month' : 'Payments this calendar month'} · {fmt(sum)}
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
          <EmptyState title="No payments match this view" description="Nothing collected in the selected period yet." />
        ) : (
          <div className="bg-white rounded-2xl overflow-hidden shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs font-semibold text-stone-400 uppercase" style={{ borderBottom: '1px solid #EDE8E3' }}>
                  <th className="py-3 px-4">Project</th>
                  <th className="py-3 px-4">Client</th>
                  <th className="py-3 px-4">Milestone</th>
                  <th className="py-3 px-4">Amount</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Collected On</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-stone-50">
                    <td className="py-3 px-4 font-medium text-stone-900">{r.projectCode}</td>
                    <td className="py-3 px-4">
                      <Link to={`/leads/${r.leadId}`} className="text-brand-600 hover:text-brand-700 font-medium">
                        {r.clientName}
                      </Link>
                    </td>
                    <td className="py-3 px-4 text-stone-600">{r.milestone}</td>
                    <td className="py-3 px-4 text-stone-700">{fmt(r.amount)}</td>
                    <td className="py-3 px-4 text-stone-600">{r.status}</td>
                    <td className="py-3 px-4 text-stone-600">
                      {r.collectedAt ? new Date(r.collectedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'}
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
