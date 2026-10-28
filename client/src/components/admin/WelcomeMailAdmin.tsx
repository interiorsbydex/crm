import SettingsScreen, { Choice } from './SettingsScreen';

// Admin → Welcome Mail: which of the lead's own files go out with the PD→OB
// welcome mail, and what happens when one is missing (server: lib/welcomeMailFiles.ts).

type Key = 'payment' | 'obQuote' | 'pitch';
interface Value { attach: Record<Key, boolean>; extraTypes: string[]; whenMissing: 'skip' | 'block' }
interface Catalog { kinds: { key: Key; label: string }[]; documentTypes: { key: string; label: string }[] }

export default function WelcomeMailAdmin() {
  return (
    <SettingsScreen<Value, Catalog>
      path="/welcome-mail-files"
      title="Welcome Mail"
      testId="welcome-mail-admin"
      intro={<>Choose which files from the lead's Files tab are attached to the welcome mail (the mail that moves a lead from Pitch Discussion to Onboarding). The newest file of each kind is attached. The person sending sees the list of attachments on the review screen before the mail goes. The words of the mail itself are edited under Settings → Mail templates. Files can be up to 20 MB in all.</>}
    >
      {(draft, setDraft, data) => {
        const core = new Set(['PAYMENT_SCREENSHOT', 'OB_QUOTE', 'PITCH_PRESENTATION', 'FINAL_PITCH_PRESENTATION', 'QUOTATION', 'PR_QUOTATION', 'PP_QUOTATION', 'GENERATED_QUOTE']);
        const others = (data.catalog?.documentTypes ?? []).filter((t) => !core.has(t.key));
        return (
          <>
            <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
              <h3 className="text-sm font-semibold text-gray-800">Always-useful files</h3>
              {(data.catalog?.kinds ?? []).map((k) => (
                <label key={k.key} className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={draft.attach[k.key]} onChange={(e) => setDraft({ ...draft, attach: { ...draft.attach, [k.key]: e.target.checked } })} />
                  {k.label}
                </label>
              ))}
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
              <h3 className="text-sm font-semibold text-gray-800">Any other kind of file</h3>
              <p className="text-xs text-gray-500">Tick any other document type to attach the newest file of that type too. Your own types from Admin → Document Types are listed here as well.</p>
              {others.length === 0 && <p className="text-xs text-gray-400">No other document types are in use.</p>}
              <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                {others.map((t) => (
                  <label key={t.key} className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={draft.extraTypes.includes(t.key)}
                      onChange={(e) => setDraft({ ...draft, extraTypes: e.target.checked ? [...draft.extraTypes, t.key] : draft.extraTypes.filter((x) => x !== t.key) })} />
                    {t.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <Choice name="whenMissing" label="If a ticked kind of file has not been uploaded for the lead" value={draft.whenMissing}
                onChange={(v) => setDraft({ ...draft, whenMissing: v })}
                options={[
                  { value: 'skip', label: 'Leave it out and send the mail with the files that exist', help: 'The review screen shows exactly what is attached.' },
                  { value: 'block', label: 'Stop, and tell the sender which file to upload first' },
                ]} />
            </div>
          </>
        );
      }}
    </SettingsScreen>
  );
}
