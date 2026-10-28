import SettingsScreen from './SettingsScreen';

// Admin → Welcome Mail: which of the lead's own files go out with the PD→OB
// welcome mail (server: lib/welcomeMailFiles.ts).

type Key = 'payment' | 'obQuote' | 'pitch';
interface Value { attach: Record<Key, boolean> }
interface Catalog { kinds: { key: Key; label: string }[] }

export default function WelcomeMailAdmin() {
  return (
    <SettingsScreen<Value, Catalog>
      path="/welcome-mail-files"
      title="Welcome Mail"
      testId="welcome-mail-admin"
      intro={<>Choose which files from the lead's Files tab are attached to the welcome mail (the mail that moves a lead from Pitch Discussion to Onboarding). The newest file of each kind is attached. If a lead has no file of a kind, that kind is simply left out. The person sending sees the list of attachments on the review screen before the mail goes. The words of the mail itself are edited under Settings → Mail templates. Files can be up to 20 MB in all.</>}
    >
      {(draft, setDraft, data) => (
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-800">Attach to the welcome mail</h3>
          {(data.catalog?.kinds ?? []).map((k) => (
            <label key={k.key} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={draft.attach[k.key]} onChange={(e) => setDraft({ attach: { ...draft.attach, [k.key]: e.target.checked } })} />
              {k.label}
            </label>
          ))}
        </div>
      )}
    </SettingsScreen>
  );
}
