import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { formatISTTime } from '../../lib/dateFormat';

interface WaMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  body: string;
  templateId?: string;
  createdAt: string;
  sentBy?: { id: string; name: string } | null;
}

const TEMPLATE_LABELS: Record<string, string> = {
  pre_call_intro: 'Pre-call Intro',
  rnr_followup: 'RNR Follow-up',
  meeting_confirmation: 'Meeting Confirmation',
  mom_sent: 'MOM Sent',
  onboarding_welcome: 'Onboarding Welcome',
  on_hold_notification: 'On Hold Notification',
};

interface WaBreakdown { outbound: number; inboundUnread: number; total: number }
interface Props { leadId: string; isLocked?: boolean; breakdown?: WaBreakdown | null }

function MiniKpi({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="bg-white rounded-xl border border-stone-100 shadow-sm px-3 py-2.5 flex flex-col gap-0.5">
      <span className={`text-lg font-bold leading-none ${color ?? 'text-stone-800'}`}>{value}</span>
      <span className="text-[11px] text-stone-500">{label}</span>
    </div>
  );
}

export default function WhatsAppTab({ leadId, isLocked, breakdown }: Props) {
  const [messages, setMessages] = useState<WaMessage[]>([]);
  const [templates, setTemplates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadMessages = async () => {
    try {
      const data = await api.get<{ messages: WaMessage[]; templates: string[] }>(
        `/leads/${leadId}/whatsapp`,
      );
      setMessages(data.messages);
      setTemplates(data.templates ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMessages(); }, [leadId]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleTemplateSelect = (tplId: string) => {
    setSelectedTemplate(tplId);
    setBody(''); // will be filled server-side
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() && !selectedTemplate) return;
    setSending(true);
    setError(null);
    try {
      await api.post(`/whatsapp/send`, {
        leadId,
        body: selectedTemplate ? undefined : body,
        templateId: selectedTemplate || undefined,
      });
      setBody('');
      setSelectedTemplate('');
      await loadMessages();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-[520px]">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">WhatsApp Thread</h2>
          <p className="text-sm text-gray-500">{messages.length} message{messages.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      {/* KPI sub-row */}
      {breakdown && breakdown.total > 0 && (
        <div className="rounded-2xl border border-stone-100 bg-stone-50 px-4 py-3 mb-1">
          <p className="text-[10px] font-semibold text-stone-400 uppercase tracking-widest mb-1.5">💬 Messages</p>
          <div className="grid grid-cols-3 gap-2">
            <MiniKpi label="Sent"           value={breakdown.outbound}      color="text-brand-600" />
            <MiniKpi label="Inbound Unread" value={breakdown.inboundUnread} color="text-amber-600" />
            <MiniKpi label="Total"          value={breakdown.total}         color="text-stone-600" />
          </div>
        </div>
      )}

      {/* Message thread */}
      <div className="flex-1 overflow-y-auto space-y-2 bg-[#e5ded8] rounded-xl p-4 mb-3">
        {loading ? (
          <p className="text-center text-sm text-gray-400 animate-pulse pt-10">Loading messages…</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-sm text-gray-400 pt-10">No messages yet</p>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[75%] rounded-xl px-4 py-2.5 shadow-sm ${
                  msg.direction === 'OUTBOUND'
                    ? 'bg-[#d9fdd3] text-gray-900 rounded-br-sm'
                    : 'bg-white text-gray-900 rounded-bl-sm'
                }`}
              >
                {msg.templateId && (
                  <p className="text-[10px] font-medium text-brand-500 mb-1 uppercase tracking-wide">
                    {TEMPLATE_LABELS[msg.templateId] ?? msg.templateId}
                  </p>
                )}
                <p className="text-sm whitespace-pre-wrap">{msg.body}</p>
                <div className={`flex items-center gap-1 mt-1 ${msg.direction === 'OUTBOUND' ? 'justify-end' : ''}`}>
                  <span className="text-[10px] text-gray-400">
                    {formatISTTime(msg.createdAt)}
                  </span>
                  {msg.sentBy && (
                    <span className="text-[10px] text-gray-400">· {msg.sentBy.name}</span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Compose form */}
      {isLocked ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700">
          This lead is Inactive — reactivate it to send WhatsApp messages.
        </div>
      ) : (
      <form onSubmit={handleSend} className="bg-white border border-gray-200 rounded-xl p-3 space-y-2">
        {/* Template selector */}
        <div className="flex gap-2 flex-wrap">
          {templates.map((tpl) => (
            <button
              key={tpl}
              type="button"
              onClick={() => handleTemplateSelect(selectedTemplate === tpl ? '' : tpl)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                selectedTemplate === tpl
                  ? 'bg-brand-500 text-white border-brand-500'
                  : 'border-gray-200 text-gray-600 hover:border-brand-300'
              }`}
            >
              {TEMPLATE_LABELS[tpl] ?? tpl}
            </button>
          ))}
        </div>

        {selectedTemplate ? (
          <div className="bg-brand-50 border border-brand-200 rounded-lg px-3 py-2 text-sm text-brand-700">
            Template "<strong>{TEMPLATE_LABELS[selectedTemplate]}</strong>" will be sent with this lead's details.
          </div>
        ) : (
          <textarea
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Type a message…"
            className="w-full border-0 text-sm text-gray-900 focus:outline-none resize-none"
          />
        )}

        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={sending || (!body.trim() && !selectedTemplate)}
            className="bg-brand-500 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
      )}
    </div>
  );
}
