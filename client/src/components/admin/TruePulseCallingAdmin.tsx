import { useEffect, useState } from 'react';
import SettingsScreen from './SettingsScreen';
import { api } from '../../lib/api';

// Admin → True Pulse Calling (server: lib/truePulseCalling.ts). Each person who
// presses Call in the CRM needs their own True Pulse tracking number: their own
// mobile rings first, then True Pulse connects the client.

type TpNumber = { id: number; phone: string; label?: string };
type Value = { byUser: Record<string, TpNumber> };
type Catalog = { people: { id: string; name: string; role: string }[]; keyConfigured: boolean; resultsConfigured: boolean };

const ROLE: Record<string, string> = { DESIGNER: 'Designer', BL: 'Business Lead', CRE: 'CRE', BRANCH_HEAD: 'Branch Head' };

export default function TruePulseCallingAdmin() {
  const [available, setAvailable] = useState<TpNumber[] | null>(null);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api.get<{ numbers: TpNumber[] }>('/admin/true-pulse/available-numbers')
      .then((d) => setAvailable(d.numbers))
      .catch((e) => setLoadError(e?.message ?? 'Could not get the numbers from True Pulse'));
  }, []);

  return (
    <SettingsScreen<Value, Catalog>
      path="/true-pulse-numbers"
      title="True Pulse Calling"
      testId="true-pulse-calling-admin"
      intro={<>Give each person who calls clients from the CRM their own True Pulse number. When they press <b>Call</b> on a lead, their own mobile rings first; when they answer, True Pulse connects the client. Calls and their results (answered or missed, duration, recording) are then logged on the lead automatically.</>}
    >
      {(v, set, data) => {
        const cat = data.catalog;
        const numberById = new Map((available ?? []).map((n) => [n.id, n]));
        return (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-1 text-sm">
              <p>{cat?.keyConfigured ? '✓ The True Pulse calling key is set up.' : '✗ The True Pulse calling key is not set up yet (TRUEPULSE_OUTBOUND_KEY in Replit → Secrets). Calling will not work until it is.'}</p>
              <p>{cat?.resultsConfigured ? '✓ The link for call results is set up.' : '✗ The link for call results is not set up yet (TRUEPULSE_CALL_TOKEN in Replit → Secrets). Calls will not be logged automatically until it is.'}</p>
            </div>
            {loadError && <p className="text-sm text-red-600">{loadError}</p>}
            <div className="bg-white rounded-xl border border-gray-200 divide-y">
              {(cat?.people ?? []).map((p) => {
                const current = v.byUser[p.id];
                return (
                  <label key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                    <span className="min-w-[220px] font-medium text-gray-800">{p.name} <span className="text-xs font-normal text-gray-400">{ROLE[p.role] ?? p.role}</span></span>
                    <select
                      aria-label={`True Pulse number for ${p.name}`}
                      className="rounded border border-gray-200 px-2 py-1 text-sm"
                      value={current?.id ?? ''}
                      onChange={(e) => {
                        const byUser = { ...v.byUser };
                        const n = numberById.get(Number(e.target.value));
                        if (n) byUser[p.id] = { id: n.id, phone: n.phone, label: n.label };
                        else delete byUser[p.id];
                        set({ ...v, byUser });
                      }}
                    >
                      <option value="">No number (can't call from the CRM)</option>
                      {current && !numberById.has(current.id) && <option value={current.id}>{current.label ?? current.phone}</option>}
                      {(available ?? []).map((n) => <option key={n.id} value={n.id}>{n.label ?? n.phone}</option>)}
                    </select>
                  </label>
                );
              })}
            </div>
          </div>
        );
      }}
    </SettingsScreen>
  );
}
