import SettingsScreen from './SettingsScreen';

// Admin → In-app Alerts: which roles see each type of in-app alert (server: lib/notifications.ts).

type Role = 'DESIGNER' | 'DESIGN_MANAGER' | 'CRE' | 'BL' | 'BRANCH_HEAD';
interface Value { off: Record<string, Role[]> }
interface Catalog { types: { type: string; label: string }[]; roles: Role[] }

const ROLE_LABELS: Record<Role, string> = {
  DESIGNER: 'Designer', DESIGN_MANAGER: 'Design Manager', CRE: 'CRE', BL: 'Business Lead', BRANCH_HEAD: 'Branch Head',
};

export default function AlertsAdmin() {
  return (
    <SettingsScreen<Value, Catalog>
      path="/alerts"
      title="In-app Alerts"
      testId="alerts-admin"
      intro={<>Choose who sees each kind of alert in the bell and on dashboards. A ticked box means that role gets the alert whenever the CRM would normally send it to them. Unticking stops it appearing; nothing else changes (client emails and SMS are set in Automations).</>}
    >
      {(draft, setDraft, data) => {
        const catalog = data.catalog!;
        const toggle = (type: string, role: Role, show: boolean) => {
          const off = draft.off[type] ?? [];
          const next = show ? off.filter((r) => r !== role) : [...off, role];
          const copy = { ...draft.off };
          if (next.length) copy[type] = next; else delete copy[type];
          setDraft({ off: copy });
        };
        return (
          <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="px-4 py-2.5 font-semibold">Alert</th>
                  {catalog.roles.map((r) => <th key={r} className="px-3 py-2.5 font-semibold text-center whitespace-nowrap">{ROLE_LABELS[r]}</th>)}
                </tr>
              </thead>
              <tbody>
                {catalog.types.map((t) => (
                  <tr key={t.type} className="border-t border-gray-50" data-testid={`alert-${t.type}`}>
                    <td className="px-4 py-2 text-gray-800">{t.label}</td>
                    {catalog.roles.map((r) => (
                      <td key={r} className="px-3 py-2 text-center">
                        <input type="checkbox" aria-label={`${ROLE_LABELS[r]}: ${t.label}`}
                          checked={!(draft.off[t.type] ?? []).includes(r)} onChange={(e) => toggle(t.type, r, e.target.checked)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }}
    </SettingsScreen>
  );
}
