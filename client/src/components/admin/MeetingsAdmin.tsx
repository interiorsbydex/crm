import SettingsScreen from './SettingsScreen';
import { loadMeetingSettings, type MeetingSettings, type MeetingModeKey } from '../../lib/meetingSettings';

// Admin → Meetings (server: lib/meetingSettings.ts).

const ORDER: MeetingModeKey[] = ['EC_VISIT', 'SITE_VISIT', 'VIRTUAL', 'PUBLIC_PLACE', 'CLIENT_PLACE'];

export default function MeetingsAdmin() {
  return (
    <SettingsScreen<MeetingSettings>
      path="/meetings"
      title="Meetings"
      testId="meetings-admin"
      onSaved={() => { loadMeetingSettings().catch(() => {}); }}
      intro={<>Name each meeting type, choose which can still be picked, and how many intent stars a lead gets when that type of meeting is booked (a designer can still change stars by hand). Then choose which details are mandatory when a meeting is closed. Adding a completely new meeting type needs a developer.</>}
    >
      {(draft, setDraft) => (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="px-4 py-2.5 font-semibold">Meeting type</th>
                  <th className="px-3 py-2.5 font-semibold">Intent stars</th>
                  <th className="px-3 py-2.5 font-semibold text-center">In use</th>
                </tr>
              </thead>
              <tbody>
                {ORDER.map((m) => {
                  const mode = draft.modes[m];
                  const set = (patch: Partial<typeof mode>) => setDraft({ ...draft, modes: { ...draft.modes, [m]: { ...mode, ...patch } } });
                  return (
                    <tr key={m} className="border-t border-gray-50" data-testid={`mode-${m}`}>
                      <td className="px-4 py-2">
                        <input aria-label={`Name for ${mode.label}`} value={mode.label} maxLength={40} onChange={(e) => set({ label: e.target.value })}
                          className="w-full max-w-[220px] rounded border border-gray-200 px-2 py-1 text-sm" />
                      </td>
                      <td className="px-3 py-2">
                        <select aria-label={`Stars for ${mode.label}`} value={mode.stars} onChange={(e) => set({ stars: Number(e.target.value) })}
                          className="rounded border border-gray-200 px-2 py-1 text-sm">
                          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{'★'.repeat(n)} ({n})</option>)}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <input type="checkbox" aria-label={`${mode.label} in use`} checked={mode.active} onChange={(e) => set({ active: e.target.checked })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-2">
            <h3 className="text-sm font-semibold text-gray-800">Mandatory when closing a meeting</h3>
            {([
              ['requireMom', 'Minutes of meeting when marking a meeting completed', 'If optional and left empty, no minutes email or SMS is prepared.'],
              ['requireRescheduleReason', 'A reason when rescheduling', ''],
              ['requireNoShowReason', 'A reason when marking a no-show', ''],
            ] as const).map(([key, label, help]) => (
              <label key={key} className="flex items-start gap-2 text-sm text-gray-700">
                <input type="checkbox" className="mt-1" checked={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })} />
                <span>{label}{help && <span className="block text-xs text-gray-400">{help}</span>}</span>
              </label>
            ))}
            <p className="pt-1 text-xs text-gray-400">The new date, place and type are always needed when rescheduling or replanning, so the meeting can be booked.</p>
          </div>
        </>
      )}
    </SettingsScreen>
  );
}
