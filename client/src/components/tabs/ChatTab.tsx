import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { formatISTTime } from '../../lib/dateFormat';

interface ChatMessage {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string; role: string } | null;
}

interface Props {
  leadId: string;
  onMessagesRead?: () => void;
}

// Internal team chat for this lead — separate from the client-facing
// WhatsApp thread and from the audit-trail Activity Log. Posting here never
// creates an ActivityLog row, so it doesn't affect the Activity feed's
// ordering/content — it's just a place for the team to leave notes/discuss.
export default function ChatTab({ leadId, onMessagesRead }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadMessages = async () => {
    try {
      const data = await api.get<{ messages: ChatMessage[] }>(`/leads/${leadId}/chat`);
      setMessages(data.messages);
      onMessagesRead?.();
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

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api.post(`/leads/${leadId}/chat`, { body });
      setBody('');
      await loadMessages();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-100 bg-gray-50">
        <h3 className="text-sm font-semibold text-gray-700">Team Chat</h3>
        <p className="text-xs text-gray-400">Internal notes — not visible to the client, not part of the activity log</p>
      </div>

      <div className="flex flex-col h-72">
        <div className="flex-1 overflow-y-auto space-y-2 p-3">
          {loading ? (
            <p className="text-center text-xs text-gray-400 animate-pulse pt-8">Loading…</p>
          ) : messages.length === 0 ? (
            <p className="text-center text-xs text-gray-400 pt-8">No messages yet — start the conversation</p>
          ) : (
            messages.map((m) => (
              <div key={m.id} className="flex items-start gap-2">
                <div className="w-6 h-6 rounded-full bg-brand-100 text-brand-600 text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                  {(m.user?.name ?? '?').charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0 bg-gray-50 rounded-lg px-3 py-1.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-medium text-gray-700">{m.user?.name ?? 'Unknown'}</span>
                    <span className="text-[10px] text-gray-400">{formatISTTime(m.createdAt)}</span>
                  </div>
                  <p className="text-xs text-gray-600 whitespace-pre-wrap">{m.body}</p>
                </div>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <form onSubmit={handleSend} className="border-t border-gray-100 p-2 flex gap-2">
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Message the team…"
            className="flex-1 text-xs border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-brand-300"
          />
          <button
            type="submit"
            disabled={sending || !body.trim()}
            className="bg-brand-500 text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </form>
        {error && <p className="text-xs text-red-500 px-2 pb-2">{error}</p>}
      </div>
    </div>
  );
}
