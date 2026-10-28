import { useRef, useState } from 'react';

// The subject and message boxes of one mail template (Settings → Mail templates),
// with a plain-English list of the blanks the CRM fills in and buttons to put
// them in, so nobody has to type {{curly brackets}} or read the HTML.

export interface PlaceholderHelp { name: string; meaning: string; example: string }
type Field = 'subject' | 'html';

/** The message with each {{blank}} swapped for its example, for the preview. */
export function previewHtml(html: string, help: PlaceholderHelp[]): string {
  const examples = Object.fromEntries(help.map((h) => [h.name, h.example || `[${h.name}]`]));
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => examples[key] ?? `[${key}]`);
}

export default function MailTemplateEditor({ subject, html, help, disabled, onChange }: {
  subject: string;
  html: string;
  help: PlaceholderHelp[];
  disabled?: boolean;
  onChange: (next: { subject: string; html: string }) => void;
}) {
  const subjectRef = useRef<HTMLInputElement>(null);
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const [last, setLast] = useState<Field>('html');
  const [showHelp, setShowHelp] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const unknown = [...new Set([...(subject + html).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].filter((n) => !help.some((h) => h.name === n));

  /** Put `text` at the cursor of the box last clicked in (or around the selected words, for `wrap`). */
  const insert = (text: string, wrap?: [string, string]) => {
    const field = last;
    const el = field === 'subject' ? subjectRef.current : htmlRef.current;
    const value = field === 'subject' ? subject : html;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = wrap
      ? value.slice(0, start) + wrap[0] + (value.slice(start, end) || 'your text') + wrap[1] + value.slice(end)
      : value.slice(0, start) + text + value.slice(end);
    onChange(field === 'subject' ? { subject: next, html } : { subject, html: next });
    const caret = start + (wrap ? wrap[0].length : text.length);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(caret, caret); });
  };

  return (
    <div className="space-y-2.5">
      <div>
        <label className="block text-[11px] font-medium text-gray-500 mb-1">Subject (the title of the email)</label>
        <input
          ref={subjectRef}
          value={subject}
          disabled={disabled}
          onFocus={() => setLast('subject')}
          onChange={(e) => onChange({ subject: e.target.value, html })}
          className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
        />
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <label className="block text-[11px] font-medium text-gray-500">Message (the body of the email)</label>
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" disabled={disabled} onClick={() => insert('', ['<strong>', '</strong>'])} className="px-2 py-0.5 text-[11px] font-semibold border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40" title="Make the selected words bold">Bold</button>
            <button type="button" disabled={disabled} onClick={() => insert('\n<p>Your new paragraph.</p>')} className="px-2 py-0.5 text-[11px] border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40" title="Add a new paragraph at the cursor">+ Paragraph</button>
            <button type="button" disabled={disabled} onClick={() => insert('<br/>')} className="px-2 py-0.5 text-[11px] border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-40" title="Start a new line at the cursor">New line</button>
          </div>
        </div>
        <textarea
          ref={htmlRef}
          value={html}
          disabled={disabled}
          onFocus={() => setLast('html')}
          onChange={(e) => onChange({ subject, html: e.target.value })}
          rows={9}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand-300"
        />
        {unknown.length > 0 && (
          <p className="mt-1 text-[11px] text-amber-700">
            {unknown.map((n) => `{{${n}}}`).join(', ')} {unknown.length === 1 ? "is not a blank this email knows" : "are not blanks this email knows"}, so {unknown.length === 1 ? 'it' : 'they'} will be empty in the email. Check the spelling against the list below.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button type="button" onClick={() => setShowHelp((v) => !v)} className="text-brand-600 hover:underline">{showHelp ? 'Hide' : 'Show'} the blanks you can use ({help.length})</button>
        <button type="button" onClick={() => setShowPreview((v) => !v)} className="text-brand-600 hover:underline">{showPreview ? 'Hide' : 'Show'} a preview with examples</button>
      </div>

      {showHelp && (
        <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 space-y-2">
          <p className="text-[11px] text-gray-600">
            A <strong>blank</strong> is a word inside double curly brackets, like <code>{'{{clientName}}'}</code>. When the email is sent, the CRM swaps it for the real detail for that client.
            Click inside the Subject or the Message to choose where it goes, then press <strong>Add</strong>. You can move a blank, delete it, or use it more than once. Do not change the spelling or the brackets.
          </p>
          <ul className="divide-y divide-gray-100">
            {help.map((h) => (
              <li key={h.name} className="py-1.5 flex flex-wrap items-start gap-x-3 gap-y-1">
                <code className="text-[11px] bg-white border border-gray-200 rounded px-1.5 py-0.5 shrink-0">{`{{${h.name}}}`}</code>
                <span className="flex-1 min-w-[220px] text-[11px] text-gray-700">
                  {h.meaning}{h.example && <span className="text-gray-400"> Example: {h.example}</span>}
                </span>
                <button type="button" disabled={disabled} onClick={() => insert(`{{${h.name}}}`)} className="px-2 py-0.5 text-[11px] font-medium border border-brand-300 text-brand-700 rounded hover:bg-brand-50 disabled:opacity-40">Add</button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-gray-500">The little tags in the Message are formatting: <code>{'<p>…</p>'}</code> is one paragraph, <code>{'<strong>…</strong>'}</code> is bold text, and <code>{'<br/>'}</code> starts a new line. The Bold, + Paragraph and New line buttons add them for you.</p>
        </div>
      )}

      {showPreview && (
        <div>
          <p className="text-[11px] text-gray-500 mb-1">Preview with example details. Subject: <strong>{previewHtml(subject, help)}</strong></p>
          <iframe title="Mail preview" sandbox="" srcDoc={previewHtml(html, help)} className="w-full h-56 border border-gray-200 rounded-lg bg-white" />
        </div>
      )}
    </div>
  );
}
