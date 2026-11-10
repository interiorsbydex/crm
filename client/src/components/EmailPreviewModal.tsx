import { useState, useEffect } from 'react';
import { X, Send } from 'lucide-react';
import { prepareEmailDraft, renderEditedEmail } from '../lib/emailDraftFormatting';
import MailAttachments from './MailAttachments';

interface Props {
  title: string;
  /** The lead the mail is about; with it the screen offers "Attach files". */
  leadId?: string;
  defaultSubject: string;
  defaultHtml: string;
  attachmentNames?: string[];
  recipientLabel: string;
  sending: boolean;
  onSend: (subject: string, html: string) => void;
  onClose: () => void;
  requireSend?: boolean;
  /**
   * Read-only preview (NPS survey mail): the text can be read but not changed,
   * and the client's rating links are hidden so nobody else can rate for them.
   */
  readOnly?: boolean;
}

/** The survey's rating links, as they appear in the plain-text body: "7 (https://…/nps/<token>?score=7)". */
const NPS_LINK = /\s*\(https?:\/\/[^)\s]*\/nps\/[^)\s]*\)/g;

/**
 * Editable, pre-populated email preview modal shared by the PD→OB "Share
 * welcome mail" and OB→OBM "Share OBM mail" actions. The body is edited as
 * plain text (line breaks become <p> tags) to keep the editor simple; the
 * HTML template itself supplies the default styling.
 */
export default function EmailPreviewModal({
  title, leadId, defaultSubject, defaultHtml, attachmentNames, recipientLabel, sending, onSend, onClose, requireSend = false, readOnly = false,
}: Props) {
  const [subject, setSubject] = useState(defaultSubject);
  const prepared = prepareEmailDraft(defaultHtml);
  const [body, setBody] = useState(() => prepareEmailDraft(defaultHtml).body);

  useEffect(() => {
    setSubject(defaultSubject);
    setBody(prepareEmailDraft(defaultHtml).body);
  }, [defaultSubject, defaultHtml]);

  const handleSend = () => {
    if (readOnly) { onSend(defaultSubject.trim(), defaultHtml); return; }
    const html = renderEditedEmail(defaultHtml, body);
    onSend(subject.trim(), html);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-900 text-sm">{title}</h3>
          {!requireSend && (
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X size={18} strokeWidth={2} />
            </button>
          )}
        </div>
        <div className="p-5 space-y-3">
          {attachmentNames !== undefined && (
            <div className="text-xs text-gray-600">
              <span className="font-semibold">Attachments: </span>
              {attachmentNames.length ? attachmentNames.join(', ') : 'No standard documents for this mail (tick checklist items that have documents, or set them in Admin → Checklist Documents).'}
            </div>
          )}
          {leadId && !readOnly && <MailAttachments leadId={leadId} />}
          <p className="text-xs text-gray-500">To: {recipientLabel}</p>
          {readOnly ? (
            <div data-testid="email-readonly">
              <p className="text-xs font-medium text-gray-600 mb-1">Subject</p>
              <p className="text-sm text-gray-900 mb-3">{defaultSubject}</p>
              <p className="text-xs font-medium text-gray-600 mb-1">Message</p>
              <div className="whitespace-pre-wrap rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-800 max-h-80 overflow-y-auto">
                {prepared.body.replace(NPS_LINK, '')}
              </div>
              <p className="mt-2 text-xs text-gray-500">The rating links are hidden here, so only the client can give the score.</p>
            </div>
          ) : (<>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Subject</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 font-mono"
            />
            {prepared.tables.length > 0 && (
              <div className="mt-3">
                <p className="mb-2 text-xs text-gray-500">The table below is included automatically. Update project dates in the checklist.</p>
                <iframe
                  title="Tables included in this email"
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={`<!doctype html><html><body style="margin:8px;font-family:Arial,sans-serif;font-size:13px">${prepared.tables.map((table) => table.html).join('')}</body></html>`}
                  className="h-72 w-full rounded border border-gray-200 bg-white"
                />
              </div>
            )}
          </div>
          </>)}
        </div>
        <div className="flex gap-2 px-5 py-4 border-t border-gray-100">
          <button
            onClick={onClose}
            disabled={sending || requireSend}
            className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            {requireSend ? 'Send required' : 'Cancel'}
          </button>
          <button
            onClick={handleSend}
            disabled={sending || (!readOnly && (!subject.trim() || !body.trim()))}
            className="flex-1 flex items-center justify-center gap-1.5 bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            <Send size={13} strokeWidth={2.5} />
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
