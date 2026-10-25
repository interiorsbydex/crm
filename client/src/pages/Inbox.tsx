import { useEffect, useRef, useState, useCallback } from 'react';
import { MessageCircle } from 'lucide-react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import { formatISTDate, formatISTTime } from '../lib/dateFormat';

interface InboxRow {
  leadId: string; leadNumber: string; leadName: string; unreadCount: number;
  latestMessage: { direction: 'INBOUND' | 'OUTBOUND'; body: string; createdAt: string; } | null;
}

interface WaMessage {
  id: string; direction: 'INBOUND' | 'OUTBOUND'; body: string;
  templateId?: string | null; createdAt: string;
  sentBy?: { id: string; name: string } | null;
}

interface Template { id: string; label: string; body: string; note?: string; }

function relTime(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d`;
  return formatISTDate(d);
}

function avatarColor(name: string) {
  const colors = ['bg-indigo-100 text-indigo-700', 'bg-fuchsia-100 text-fuchsia-700',
    'bg-amber-100 text-amber-700', 'bg-teal-100 text-teal-700', 'bg-rose-100 text-rose-700'];
  return colors[name.charCodeAt(0) % colors.length];
}

export default function Inbox() {
  const [inbox, setInbox] = useState<InboxRow[]>([]);
  const [filtered, setFiltered] = useState<InboxRow[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<InboxRow | null>(null);
  const [loadingInbox, setLoadingInbox] = useState(true);

  const [messages, setMessages] = useState<WaMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadInbox = useCallback(async () => {
    try {
      const d = await api.get<{ inbox: InboxRow[] }>('/whatsapp/inbox');
      setInbox(d.inbox);
      setFiltered(d.inbox);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoadingInbox(false);
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    try {
      const d = await api.get<{ templates: Template[] }>('/admin/whatsapp-templates');
      setTemplates(d.templates);
    } catch {}
  }, []);

  useEffect(() => { loadInbox(); loadTemplates(); }, [loadInbox, loadTemplates]);

  useEffect(() => {
    const q = search.toLowerCase();
    setFiltered(q ? inbox.filter(r => r.leadName.toLowerCase().includes(q) || r.leadNumber.toLowerCase().includes(q)) : inbox);
  }, [search, inbox]);

  const loadThread = useCallback(async (leadId: string) => {
    setLoadingThread(true);
    setMessages([]);
    try {
      const d = await api.get<{ messages: WaMessage[] }>(`/leads/${leadId}/whatsapp`);
      setMessages(d.messages);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoadingThread(false);
    }
  }, []);

  useEffect(() => {
    if (selected) loadThread(selected.leadId);
  }, [selected, loadThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const selectConversation = (row: InboxRow) => {
    setSelected(row);
    setBody('');
    setSelectedTemplate(null);
    setShowTemplates(false);
  };

  const pickTemplate = (tpl: Template) => {
    setSelectedTemplate(tpl);
    setBody(tpl.body);
    setShowTemplates(false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    if (!body.trim() && !selectedTemplate) return;
    setSending(true);
    try {
      const payload: any = { leadId: selected.leadId };
      if (selectedTemplate) {
        payload.templateId = selectedTemplate.id;
      } else {
        payload.body = body;
      }
      const res = await api.post<{ sent: boolean; warning?: string }>('/whatsapp/send', payload);
      if (res.warning) {
        toast(res.warning.slice(0, 80), { icon: '⚠️', duration: 5000, style: { background: '#78350f', color: '#fef3c7' } });
      }

      const optimistic: WaMessage = {
        id: `opt-${Date.now()}`,
        direction: 'OUTBOUND',
        body: selectedTemplate ? `[Template: ${selectedTemplate.label}]` : body,
        templateId: selectedTemplate?.id ?? null,
        createdAt: new Date().toISOString(),
        sentBy: null,
      };
      setMessages(prev => [...prev, optimistic]);
      setBody('');
      setSelectedTemplate(null);

      await loadThread(selected.leadId);
      await loadInbox();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="h-[calc(100vh-56px)] flex bg-gray-50 overflow-hidden">
      {/* Left panel — conversation list */}
      <div className="w-72 shrink-0 border-r border-gray-200 bg-white flex flex-col">
        <div className="p-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900 mb-2">WhatsApp</h2>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search conversations..."
            className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingInbox ? (
            <div className="py-12 text-center text-gray-400 text-xs animate-pulse">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center">
              <MessageCircle size={28} strokeWidth={1.5} className="text-gray-300 mb-2" />
              <p className="text-gray-400 text-xs">{search ? 'No results' : 'No conversations yet'}</p>
            </div>
          ) : (
            filtered.map(row => {
              const isSelected = selected?.leadId === row.leadId;
              return (
                <button
                  key={row.leadId}
                  onClick={() => selectConversation(row)}
                  className={`w-full flex items-start gap-3 px-3 py-3 text-left border-b border-gray-50 transition-colors ${
                    isSelected ? 'bg-brand-50 border-l-2 border-l-brand-500' : 'hover:bg-gray-50'
                  }`}
                >
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-sm font-bold ${avatarColor(row.leadName)}`}>
                    {row.leadName.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-semibold text-gray-900 truncate">{row.leadName}</span>
                      <span className="text-[10px] text-gray-400 shrink-0">
                        {row.latestMessage ? relTime(row.latestMessage.createdAt) : ''}
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-500 truncate mt-0.5">
                      {row.latestMessage?.direction === 'OUTBOUND' && <span className="text-blue-400 mr-1">You:</span>}
                      {row.latestMessage?.body ?? <span className="italic">No messages yet</span>}
                    </p>
                    <div className="flex items-center justify-between mt-0.5">
                      <span className="text-[10px] text-gray-400">{row.leadNumber}</span>
                      {row.unreadCount > 0 && (
                        <span className="bg-green-500 text-white text-[10px] font-bold min-w-[16px] h-4 flex items-center justify-center rounded-full px-1">
                          {row.unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right panel — thread */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selected ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-stone-100 flex items-center justify-center mb-4">
                <MessageCircle size={30} strokeWidth={1.5} className="text-stone-300" />
              </div>
              <p className="text-gray-500 text-sm font-medium">Select a conversation to start messaging</p>
              <p className="text-gray-400 text-xs mt-1">{inbox.length} conversation{inbox.length !== 1 ? 's' : ''} in your scope</p>
            </div>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="bg-white border-b border-gray-200 px-5 py-3 flex items-center gap-3 shrink-0">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${avatarColor(selected.leadName)}`}>
                {selected.leadName.charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="font-semibold text-gray-900 text-sm">{selected.leadName}</p>
                <p className="text-xs text-gray-400">{selected.leadNumber}</p>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto bg-[#e5ded8] p-4 space-y-2">
              {loadingThread ? (
                <p className="text-center text-xs text-gray-400 animate-pulse pt-10">Loading thread…</p>
              ) : messages.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-gray-400">No messages yet — start the conversation below</p>
                </div>
              ) : (
                messages.map(msg => (
                  <div key={msg.id} className={`flex ${msg.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%] rounded-xl px-3.5 py-2.5 shadow-sm text-sm ${
                      msg.direction === 'OUTBOUND'
                        ? 'bg-[#d9fdd3] text-gray-900 rounded-br-sm'
                        : 'bg-white text-gray-900 rounded-bl-sm'
                    }`}>
                      {msg.templateId && (
                        <p className="text-[10px] font-semibold text-brand-500 mb-1 uppercase tracking-wide">
                          {templates.find(t => t.id === msg.templateId)?.label ?? msg.templateId}
                        </p>
                      )}
                      <p className="whitespace-pre-wrap">{msg.body}</p>
                      <div className={`flex items-center gap-1 mt-1 ${msg.direction === 'OUTBOUND' ? 'justify-end' : ''}`}>
                        <span className="text-[10px] text-gray-400">
                          {formatISTTime(msg.createdAt)}
                        </span>
                        {msg.sentBy && <span className="text-[10px] text-gray-400">· {msg.sentBy.name}</span>}
                      </div>
                    </div>
                  </div>
                ))
              )}
              <div ref={bottomRef} />
            </div>

            {/* Template picker dropdown */}
            {showTemplates && (
              <div className="bg-white border-t border-gray-100 px-4 py-3 space-y-2 max-h-64 overflow-y-auto">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">WhatsApp Templates</p>
                {templates.map(tpl => (
                  <button key={tpl.id} onClick={() => pickTemplate(tpl)}
                    className="w-full text-left p-3 rounded-lg border border-gray-100 hover:border-brand-300 hover:bg-brand-50 transition-colors">
                    <p className="text-xs font-semibold text-gray-800">{tpl.label}</p>
                    <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{tpl.body}</p>
                  </button>
                ))}
              </div>
            )}

            {/* Send bar */}
            <form onSubmit={handleSend} className="bg-white border-t border-gray-200 px-4 py-3 flex items-end gap-2 shrink-0">
              <div className="flex-1">
                {selectedTemplate && (
                  <div className="flex items-center gap-2 mb-2 bg-brand-50 border border-brand-200 rounded-lg px-3 py-1.5">
                    <span className="text-xs font-medium text-brand-700">{selectedTemplate.label}</span>
                    <button type="button" onClick={() => { setSelectedTemplate(null); setBody(''); }}
                      className="ml-auto text-brand-400 hover:text-brand-600 text-xs">✕</button>
                  </div>
                )}
                <textarea
                  ref={textareaRef}
                  rows={2}
                  value={body}
                  onChange={e => setBody(e.target.value)}
                  placeholder="Type a message…"
                  disabled={!!selectedTemplate}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none disabled:bg-gray-50"
                />
              </div>
              <div className="flex items-center gap-1.5 shrink-0 mb-0.5">
                <button type="button" onClick={() => setShowTemplates(v => !v)}
                  className={`px-3 py-2 rounded-xl text-xs font-medium border transition-colors ${
                    showTemplates ? 'bg-brand-100 border-brand-300 text-brand-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                  }`}>
                  Templates
                </button>
                <button type="submit" disabled={sending || (!body.trim() && !selectedTemplate)}
                  className="bg-brand-500 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors whitespace-nowrap">
                  {sending ? 'Sending…' : 'Send →'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
