import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  LayoutDashboard, Kanban, Users, CalendarDays, Calendar,
  MessageCircle, Tag, Building2, BarChart2, Users2, Settings, Phone, ClipboardCheck,
  Bell, Search, X, ChevronRight, ChevronDown, Plus, ListChecks,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import NotificationList from './NotificationList';
import { getStoredUser, logout } from '../lib/auth';
import { validateEmail, validatePhoneStrict } from '../lib/validation';
import PhoneInput from './PhoneInput';
import LeadLocationSelector from './LeadLocationSelector';
import { loadCrmSettings, useCrmSettings } from '../lib/crmSettings';
import { loadDashboardLayouts } from '../lib/dashboardLayout';
import { loadMyPermissions } from '../lib/permissions';
import { DateInput } from './ui/DateTimeInputs';
import { todayISTDateString } from '../lib/dateFormat';

interface SearchLead {
  id: string;
  leadId: string;
  name: string;
  phone: string;
  stage: string;
}

interface NotifItem {
  id: string;
  type: string;
  message: string;
  isRead: boolean;
  createdAt: string;
  lead?: { id: string; leadId: string; name: string };
}

interface NavItem { to: string; label: string; Icon: LucideIcon; comingSoon?: boolean }

// Task #90 — "Sales" renamed to "Sales Pipeline" with Sales Pipeline / Design
// Pipeline / Leads / Projects as its first four items. Design Pipeline already
// exists as a tab inside Pipeline.tsx (linked via ?tab=design). Projects (task
// #113) is a real role-scoped list page (ProjectList.tsx, GET /api/projects).
// Meetings/Calendar/WhatsApp/Discounts keep their existing nav access underneath.
interface NavItemDef extends NavItem { rolesOnly?: string[]; rolesExclude?: string[] }
interface NavGroupDef { label: string; items: NavItemDef[] }

const NAV_GROUPS: NavGroupDef[] = [
  {
    label: 'OVERVIEW',
    items: [
      // "Dashboard" is hidden for CRE — they have a dedicated CRE Portal instead.
      { to: '/dashboard', label: 'Dashboard', Icon: LayoutDashboard, rolesExclude: ['CRE'] },
      // CRE module Stage 3: dedicated portal at /cre-portal (routed from App.tsx).
      { to: '/cre-portal', label: 'CRE Portal', Icon: LayoutDashboard, rolesOnly: ['CRE'] },
    ],
  },
  {
    label: 'SALES PIPELINE',
    items: [
      { to: '/pipeline', label: 'Sales Pipeline', Icon: Kanban },
      // Design Pipeline is available to Designers, but is not part of the CRE portal.
      { to: '/pipeline?tab=design', label: 'Design Pipeline', Icon: Building2, rolesOnly: ['DESIGNER'] },
      { to: '/leads', label: 'Leads', Icon: Users },
      { to: '/projects', label: 'Projects', Icon: Building2, rolesExclude: ['CRE'] },
      { to: '/whatsapp', label: 'WhatsApp', Icon: MessageCircle },
      { to: '/discounts', label: 'Discounts', Icon: Tag },
    ],
  },
  {
    // Tasks, Calls, and Meetings share one navigation group.
    label: 'TASKS, CALLS & MEETINGS',
    items: [
      { to: '/tasks', label: 'Tasks', Icon: ListChecks },
      { to: '/calls', label: 'Calls', Icon: Phone },
      { to: '/meetings', label: 'Meetings', Icon: CalendarDays },
      { to: '/calendar', label: 'Calendar', Icon: Calendar },
    ],
  },
  {
    label: 'INSIGHTS',
    items: [
      { to: '/reports', label: 'Reports', Icon: BarChart2 },
      { to: '/data-quality', label: 'Data Quality', Icon: ClipboardCheck },
    ],
  },
  {
    label: 'WORKSPACE',
    items: [
      { to: '/admin', label: 'Team & Roles', Icon: Users2 },
      { to: '/settings', label: 'Settings', Icon: Settings },
    ],
  },
];

const ROLE_COLORS: Record<string, string> = {
  CRE: 'bg-amber-100 text-amber-700',
  BL: 'bg-brand-100 text-brand-700',
  DESIGNER: 'bg-orange-100 text-orange-700',
  BRANCH_HEAD: 'bg-stone-100 text-stone-700',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const user = getStoredUser();
  // Pages read their dropdown lists and stage names from CRM Settings, so
  // wait for them (or for the load to fail, falling back to built-in values).
  const [settingsReady, setSettingsReady] = useState(false);
  useEffect(() => {
    Promise.allSettled([loadCrmSettings(), loadDashboardLayouts(), loadMyPermissions()]).finally(() => setSettingsReady(true));
  }, []);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<SearchLead[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  const [notifs, setNotifs] = useState<NotifItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unopenedLeadCount, setUnopenedLeadCount] = useState(0);
  const [notifsOpen, setNotifsOpen] = useState(false);
  const notifsRef = useRef<HTMLDivElement>(null);
  const seenNotificationIds = useRef(new Set<string>());
  const hasLoadedNotifications = useRef(false);

  const [showNewLead, setShowNewLead] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newLead, setNewLead] = useState({ name: '', phone: '', email: '', source: '', sourceOther: '', projectType: '', location: '', scope: '', possessionTimeline: '', estimatedValue: '', isTestLead: false });
  const [newLeadErrors, setNewLeadErrors] = useState<Record<string, string>>({});
  const [newLeadPossessionMode, setNewLeadPossessionMode] = useState<'custom' | 'received'>('custom');
  // Name, phone and source are always mandatory; which project details are
  // too comes from Admin → CRM Settings (the server enforces the same list).
  const crm = useCrmSettings();
  const NEW_LEAD_REQUIRED = ['name', 'phone', 'source', ...crm.leadCreateRequired];
  const isRequired = (key: string) => NEW_LEAD_REQUIRED.includes(key);

  // This is the one canonical "New Lead" flow in the app — other pages (e.g. the
  // Leads list) just dispatch this event instead of keeping their own form/state.
  useEffect(() => {
    const openFromEvent = () => { setNewLeadErrors({}); setShowNewLead(true); };
    window.addEventListener('open-new-lead-modal', openFromEvent);
    return () => window.removeEventListener('open-new-lead-modal', openFromEvent);
  }, []);

  const validateNewLeadField = (key: string, value: string) => {
    let error: string | null = null;
    if (key === 'email') error = validateEmail(value);
    else if (key === 'phone') error = validatePhoneStrict(value);
    else if (NEW_LEAD_REQUIRED.includes(key) && !value.trim()) error = 'This field is required';
    setNewLeadErrors((prev) => {
      const next = { ...prev };
      if (error) next[key] = error; else delete next[key];
      return next;
    });
    return error;
  };

  const fetchNotifs = useCallback(async () => {
    try {
      const data = await api.get<{ unreadCount: number; notifications: NotifItem[] }>('/notifications/my');
      const newTeamChatNotifications = (data.notifications ?? []).filter(
        (notification) =>
          notification.type === 'TEAM_CHAT_MESSAGE' &&
          !notification.isRead &&
          !seenNotificationIds.current.has(notification.id),
      );
      if (hasLoadedNotifications.current && newTeamChatNotifications.length > 0) {
        const count = newTeamChatNotifications.length;
        toast(`${count === 1 ? 'New Team Chat message' : `${count} new Team Chat messages`}`, { icon: '💬' });
      }
      (data.notifications ?? []).forEach((notification) => seenNotificationIds.current.add(notification.id));
      hasLoadedNotifications.current = true;
      setUnreadCount(data.unreadCount ?? 0);
      setNotifs(data.notifications ?? []);
    } catch {
      // silent
    }
  }, []);

  const fetchUnopenedLeadCount = useCallback(async () => {
    if (user?.role !== 'DESIGNER') {
      setUnopenedLeadCount(0);
      return;
    }
    try {
      const data = await api.get<{ count: number }>('/leads/meta/unopened-count');
      setUnopenedLeadCount(data.count ?? 0);
    } catch {
      // The navigation remains usable if this optional badge cannot load.
    }
  }, [user?.role]);

  const handleMarkRead = useCallback((id: string) => {
    // Optimistic: flip local state + decrement badge immediately, no refetch delay
    setNotifs((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
    api.patch(`/notifications/${id}/read`).catch(() => {
      // Revert on failure
      setNotifs((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: false } : n)));
      setUnreadCount((c) => c + 1);
    });
  }, []);

  useEffect(() => {
    fetchNotifs();
    const id = setInterval(fetchNotifs, 30000);
    return () => clearInterval(id);
  }, [fetchNotifs]);

  useEffect(() => {
    void fetchUnopenedLeadCount();
    const refresh = () => { void fetchUnopenedLeadCount(); };
    window.addEventListener('lead-opened', refresh);
    window.addEventListener('lead-created', refresh);
    return () => {
      window.removeEventListener('lead-opened', refresh);
      window.removeEventListener('lead-created', refresh);
    };
  }, [fetchUnopenedLeadCount]);

  useEffect(() => {
    if (!search.trim()) { setSearchResults([]); setSearchOpen(false); return; }
    const t = setTimeout(async () => {
      try {
        const data = await api.get<{ leads: SearchLead[] }>(`/leads?search=${encodeURIComponent(search)}&limit=6`);
        setSearchResults(data.leads ?? []);
        setSearchOpen(true);
      } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false);
      if (notifsRef.current && !notifsRef.current.contains(e.target as Node)) setNotifsOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const missing = NEW_LEAD_REQUIRED.filter((k) => !String((newLead as Record<string, unknown>)[k] ?? '').trim());
    if (missing.length) {
      setNewLeadErrors((prev) => ({ ...prev, ...Object.fromEntries(missing.map((k) => [k, 'This field is required'])) }));
      toast.error('Please fill in the required fields'); return;
    }
    if (newLead.source === 'OTHER' && !newLead.sourceOther.trim()) {
      setNewLeadErrors((prev) => ({ ...prev, sourceOther: 'Enter a lead source' }));
      toast.error('Enter a lead source');
      return;
    }
    const phoneError = validatePhoneStrict(newLead.phone);
    const emailError = validateEmail(newLead.email);
    if (phoneError || emailError) {
      setNewLeadErrors((prev) => ({ ...prev, ...(phoneError ? { phone: phoneError } : {}), ...(emailError ? { email: emailError } : {}) }));
      toast.error(phoneError ?? emailError ?? 'Please fix the highlighted fields');
      return;
    }
    setCreating(true);
    try {
      const { sourceOther, ...rest } = newLead;
      const payload = { ...rest, source: newLead.source === 'OTHER' ? sourceOther.trim() : newLead.source };
      const data = await api.post<{ lead: { leadId: string; assignedBLId?: string | null; assignedCREId?: string | null } }>('/leads', payload);
      window.dispatchEvent(new CustomEvent('lead-created'));
      toast.success(`Lead ${data.lead.leadId} created`);
      if (data.lead.assignedCREId && !data.lead.assignedBLId) {
        toast.error('No active Business Lead is available. The lead remains unassigned; contact an admin.');
      }
      setNewLead({ name: '', phone: '', email: '', source: '', sourceOther: '', projectType: '', location: '', scope: '', possessionTimeline: '', estimatedValue: '', isTestLead: false });
      setNewLeadPossessionMode('custom');
      setNewLeadErrors({});
      setShowNewLead(false);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setCreating(false);
    }
  };

  const toggleSection = (label: string) =>
    setCollapsed((c) => ({ ...c, [label]: !c[label] }));

  // Task #90 review fix: Sales Pipeline (/pipeline) and Design Pipeline
  // (/pipeline?tab=design) share a path, so matching on pathname alone lit up
  // both links at once. Compare the `tab` query param too when the nav item
  // specifies one.
  const isActive = (to: string) => {
    const [path, query] = to.split('?');
    const pathMatches = location.pathname === path || (path !== '/' && location.pathname.startsWith(path));
    if (!pathMatches) return false;
    const wantedTab = new URLSearchParams(query).get('tab');
    const currentTab = new URLSearchParams(location.search).get('tab');
    if (wantedTab) return currentTab === wantedTab;
    // Item has no tab param (e.g. plain /pipeline) — only active when the
    // current URL doesn't have one either, so it doesn't also light up for
    // /pipeline?tab=design.
    return path !== '/pipeline' || !currentTab;
  };

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#F5F0EB' }}>
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-white flex flex-col h-full overflow-y-auto" style={{ borderRight: '1px solid #EDE8E3' }}>
        {/* Logo */}
        <div className="px-4 py-4 shrink-0" style={{ borderBottom: '1px solid #EDE8E3' }}>
          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-brand-500 flex items-center justify-center shrink-0">
              <span className="text-white text-sm font-bold">D</span>
            </div>
            <div>
              <p className="text-sm font-bold text-stone-900 leading-tight">FYX</p>
              <p className="text-[10px] text-stone-400 font-medium tracking-widest uppercase">CRM</p>
            </div>
          </Link>
        </div>

        {/* Nav groups — WORKSPACE (admin) is hidden from everyone except
            BRANCH_HEAD, since the server already restricts those routes to
            that role (task #90). */}
        <nav className="flex-1 py-3 px-2">
          {NAV_GROUPS.filter((group) => group.label !== 'WORKSPACE' || user?.role === 'BRANCH_HEAD').map((group) => (
            <div key={group.label} className="mb-1">
              <button
                onClick={() => toggleSection(group.label)}
                className="w-full flex items-center justify-between px-2 py-1 mb-0.5"
              >
                <span className="text-[10px] font-semibold text-stone-400 tracking-widest">{group.label}</span>
                {collapsed[group.label]
                  ? <ChevronRight size={12} className="text-stone-300" />
                  : <ChevronDown size={12} className="text-stone-300" />
                }
              </button>
              {!collapsed[group.label] && (
                <div className="space-y-0.5">
                  {group.items.filter((item) =>
                    (!item.rolesOnly || item.rolesOnly.includes(user?.role ?? '')) &&
                    (!item.rolesExclude || !item.rolesExclude.includes(user?.role ?? ''))
                  ).map((item) => {
                    if (item.comingSoon) {
                      return (
                        <div
                          key={item.to}
                          title="Coming soon"
                          className="flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm text-stone-300 cursor-not-allowed select-none"
                        >
                          <item.Icon size={15} strokeWidth={1.8} className="shrink-0" />
                          <span>{item.label}</span>
                          <span className="ml-auto text-[9px] font-bold uppercase tracking-wide bg-stone-100 text-stone-400 px-1.5 py-0.5 rounded-full">Soon</span>
                        </div>
                      );
                    }
                    const active = isActive(item.to);
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        className={`flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-sm transition-all ${
                          active
                            ? 'bg-brand-50 text-brand-600 font-semibold'
                            : 'text-stone-500 hover:text-stone-800 hover:bg-cream-200'
                        }`}
                        style={active ? { background: '#FEF0E8' } : undefined}
                      >
                        <item.Icon size={15} strokeWidth={1.8} className="shrink-0" />
                        <span>{item.label}</span>
                        {item.to === '/leads' && unopenedLeadCount > 0 ? (
                          <span className="ml-auto min-w-5 h-5 px-1 rounded-full bg-brand-500 text-white text-[10px] font-bold flex items-center justify-center">
                            {unopenedLeadCount > 99 ? '99+' : unopenedLeadCount}
                          </span>
                        ) : active && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-brand-500" />}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </nav>

        {/* User / logout */}
        {user && (
          <div className="shrink-0 px-3 py-3" style={{ borderTop: '1px solid #EDE8E3' }}>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center shrink-0">
                <span className="text-brand-700 text-xs font-bold">{user.name[0]?.toUpperCase()}</span>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-stone-800 truncate">{user.name}</p>
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${ROLE_COLORS[user.role] ?? 'bg-stone-100 text-stone-600'}`}>
                  {user.role}
                </span>
              </div>
            </div>
            <button
              onClick={logout}
              className="w-full text-xs text-stone-400 hover:text-red-500 hover:bg-red-50 px-2 py-1.5 rounded-lg transition-colors text-left"
            >
              Sign out
            </button>
          </div>
        )}
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="bg-white px-4 py-2.5 flex items-center gap-3 shrink-0" style={{ borderBottom: '1px solid #EDE8E3' }}>
          {/* Search */}
          <div className="relative flex-1 max-w-md" ref={searchRef}>
            <div className="flex items-center rounded-xl overflow-hidden bg-white transition-all" style={{ border: '1px solid #EDE8E3' }}>
              <Search size={14} strokeWidth={1.8} className="ml-3 text-stone-400 shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onFocus={() => searchResults.length > 0 && setSearchOpen(true)}
                placeholder="Search name, phone, Lead ID…"
                className="flex-1 bg-transparent px-2 py-2 text-sm text-stone-800 placeholder-stone-400 focus:outline-none"
              />
              {search && (
                <button onClick={() => { setSearch(''); setSearchResults([]); setSearchOpen(false); }}
                  className="pr-2 text-stone-400 hover:text-stone-600 flex items-center">
                  <X size={14} strokeWidth={2} />
                </button>
              )}
            </div>
            {searchOpen && searchResults.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-2xl shadow-warm-lg z-50 overflow-hidden" style={{ border: '1px solid #EDE8E3' }}>
                {searchResults.map((lead) => (
                  <button
                    key={lead.id}
                    onClick={() => { navigate(`/leads/${lead.id}`); setSearch(''); setSearchOpen(false); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-cream-100 text-left last:border-0"
                    style={{ borderBottom: '1px solid #F5F0EB' }}
                  >
                    <div className="w-7 h-7 rounded-full bg-stone-100 flex items-center justify-center shrink-0">
                      <span className="text-stone-500 text-xs font-bold">{lead.name[0]?.toUpperCase()}</span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-stone-900 truncate">{lead.name}</p>
                      <p className="text-xs text-stone-400">{lead.leadId} · {lead.stage.replace(/_/g, ' ')}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 ml-auto">
            {/* Notifications bell */}
            <div className="relative" ref={notifsRef}>
              <button
                onClick={() => setNotifsOpen((o) => !o)}
                className="relative w-9 h-9 flex items-center justify-center rounded-xl text-stone-500 hover:text-stone-800 transition-colors"
                style={{ background: 'transparent' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F0EB')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <Bell size={17} strokeWidth={1.8} />
                {unreadCount > 0 && (
                  <span className="absolute top-1 right-1 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-brand-500 text-white text-[10px] font-bold px-0.5">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>
              {notifsOpen && (
                <div className="absolute right-0 top-full mt-1 w-96 bg-white rounded-2xl shadow-warm-lg z-50 overflow-hidden" style={{ border: '1px solid #EDE8E3' }}>
                  <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid #EDE8E3' }}>
                    <p className="text-sm font-semibold text-stone-900">Notifications</p>
                    {unreadCount > 0 && (
                      <span className="text-xs text-brand-600 font-medium">{unreadCount} unread</span>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto">
                    <NotificationList notifications={notifs.slice(0, 20)} onMarkRead={handleMarkRead} variant="compact" />
                  </div>
                  <Link
                    to="/notifications"
                    onClick={() => setNotifsOpen(false)}
                    className="block text-center text-xs font-medium text-brand-600 hover:text-brand-700 py-2.5"
                    style={{ borderTop: '1px solid #EDE8E3' }}
                  >
                    View all notifications
                  </Link>
                </div>
              )}
            </div>

            {/* New Lead */}
            <button
              onClick={() => setShowNewLead(true)}
              className="bg-brand-500 hover:bg-brand-600 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors flex items-center gap-1.5 shrink-0"
            >
              <Plus size={15} strokeWidth={2.5} />
              New Lead
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          {settingsReady ? children : null}
        </main>
      </div>

      {/* New Lead Modal */}
      {showNewLead && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-stone-900/50 backdrop-blur-sm" onClick={() => { setShowNewLead(false); setNewLeadErrors({}); }} />
          <div className="relative bg-white rounded-3xl shadow-warm-lg w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-stone-900">New Lead</h2>
              <button onClick={() => { setShowNewLead(false); setNewLeadErrors({}); }} className="text-stone-400 hover:text-stone-600 w-8 h-8 flex items-center justify-center rounded-xl hover:bg-stone-100 transition-colors"><X size={16} strokeWidth={2} /></button>
            </div>
            <form onSubmit={handleCreate} className="grid grid-cols-2 gap-4">
              {[
                { key: 'name', label: 'Full Name', required: true, placeholder: 'Priya Sharma', span: 2 },
                { key: 'phone', label: 'Phone', required: true, placeholder: '+91 98765 43210' },
                { key: 'email', label: 'Email', required: isRequired('email'), placeholder: 'priya@example.com' },
                { key: 'projectType', label: 'Project Type', required: isRequired('projectType'), placeholder: '2BHK / Villa' },
                { key: 'scope', label: 'Scope of Work', required: isRequired('scope'), placeholder: 'FHD / Modulars / Kitchen' },
                { key: 'location', label: 'Location', required: isRequired('location'), placeholder: 'Whitefield, Bangalore' },
              ].map((f) => (
                <div key={f.key} className={(f as any).span === 2 ? 'col-span-2' : ''}>
                  <label className="block text-xs font-semibold text-stone-600 mb-1.5">
                    {f.label}{f.required && <span className="text-brand-500 ml-0.5">*</span>}
                  </label>
                  {f.key === 'phone' ? (
                    <PhoneInput
                      value={newLead.phone}
                      onChange={(v) => setNewLead({ ...newLead, phone: v })}
                      onBlur={() => validateNewLeadField('phone', newLead.phone)}
                      required={f.required}
                      hasError={!!newLeadErrors[f.key]}
                    />
                  ) : f.key === 'location' ? (
                    <LeadLocationSelector
                      value={newLead.location}
                      onChange={(location) => setNewLead({ ...newLead, location })}
                      onBlur={() => validateNewLeadField('location', newLead.location)}
                      required={isRequired('location')}
                      hasError={!!newLeadErrors.location}
                    />
                  ) : (
                    <input
                      value={(newLead as any)[f.key]}
                      onChange={(e) => setNewLead({ ...newLead, [f.key]: e.target.value })}
                      onBlur={(e) => { validateNewLeadField(f.key, e.target.value); e.currentTarget.style.background = '#FDFAF7'; }}
                      required={f.required}
                      placeholder={f.placeholder}
                      className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all"
                      style={{ border: newLeadErrors[f.key] ? '1px solid #EF4444' : '1px solid #EDE8E3', background: '#FDFAF7' }}
                      onFocus={(e) => e.currentTarget.style.background = '#fff'}
                    />
                  )}
                  {newLeadErrors[f.key] && (
                    <p className="text-[11px] text-red-500 mt-1">{newLeadErrors[f.key]}</p>
                  )}
                </div>
              ))}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5">
                  Possession{isRequired('possessionTimeline') && <span className="text-brand-500 ml-0.5">*</span>}
                </label>
                <select
                  value={newLeadPossessionMode === 'received' ? 'Possession Received' : 'Custom date'}
                  onChange={(e) => {
                    if (e.target.value === 'Possession Received') {
                      setNewLeadPossessionMode('received');
                      setNewLead({ ...newLead, possessionTimeline: 'Possession Received' });
                    } else {
                      setNewLeadPossessionMode('custom');
                      setNewLead({ ...newLead, possessionTimeline: '' });
                    }
                  }}
                  required
                  className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
                >
                  <option>Custom date</option>
                  <option>Possession Received</option>
                </select>
                {newLeadPossessionMode === 'custom' && <DateInput
                  value={newLead.possessionTimeline}
                  min={todayISTDateString()}
                  onChange={(v) => {
                    setNewLead({ ...newLead, possessionTimeline: v });
                    validateNewLeadField('possessionTimeline', v);
                  }}
                  required={isRequired('possessionTimeline')}
                  className={`w-full rounded-xl px-3 py-2.5 text-sm mt-2 bg-[#FDFAF7] focus:outline-none focus:ring-2 transition-all ${newLeadErrors.possessionTimeline ? 'border-red-500' : 'border-[#EDE8E3]'}`}
                />}
                {newLeadErrors.possessionTimeline && (
                  <p className="text-[11px] text-red-500 mt-1">{newLeadErrors.possessionTimeline}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5">Client Budget (₹){isRequired('estimatedValue') && <span className="text-brand-500 ml-0.5">*</span>}</label>
                <input
                  type="number"
                  value={newLead.estimatedValue}
                  onChange={(e) => setNewLead({ ...newLead, estimatedValue: e.target.value })}
                  placeholder="1500000"
                  className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 transition-all"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
                />
              </div>
              {['CRE', 'BRANCH_HEAD'].includes(user?.role ?? '') && (
                <label className="col-span-2 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newLead.isTestLead}
                    onChange={(e) => setNewLead({ ...newLead, isTestLead: e.target.checked })}
                    className="mt-0.5 h-4 w-4 accent-brand-500"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-amber-900">Mark as Test Lead</span>
                    <span className="block text-xs text-amber-700 mt-0.5">Excluded from dashboard received and funnel totals.</span>
                  </span>
                </label>
              )}
              <div>
                <label className="block text-xs font-semibold text-stone-600 mb-1.5">
                  Source<span className="text-brand-500 ml-0.5">*</span>
                </label>
                <select
                  value={newLead.source}
                  onChange={(e) => setNewLead({ ...newLead, source: e.target.value })}
                  onBlur={(e) => validateNewLeadField('source', e.target.value)}
                  required
                  className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                  style={{ border: newLeadErrors.source ? '1px solid #EF4444' : '1px solid #EDE8E3', background: '#FDFAF7' }}
                >
                  <option value="">Select source</option>
                  {crm.leadSources.filter((s) => s.active).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                {newLeadErrors.source && (
                  <p className="text-[11px] text-red-500 mt-1">{newLeadErrors.source}</p>
                )}
                {newLead.source === 'OTHER' && (
                  <>
                    <input
                      type="text"
                      value={newLead.sourceOther}
                      onChange={(e) => setNewLead({ ...newLead, sourceOther: e.target.value })}
                      onBlur={(e) => {
                        setNewLeadErrors((prev) => {
                          const next = { ...prev };
                          if (!e.target.value.trim()) next.sourceOther = 'Enter a lead source';
                          else delete next.sourceOther;
                          return next;
                        });
                      }}
                      placeholder="Enter lead source"
                      className="w-full rounded-xl px-3 py-2.5 text-sm mt-2 focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                      style={{
                        border: newLeadErrors.sourceOther ? '1px solid #EF4444' : '1px solid #EDE8E3',
                        background: '#FDFAF7',
                      }}
                    />
                    {newLeadErrors.sourceOther && (
                      <p className="text-[11px] text-red-500 mt-1">{newLeadErrors.sourceOther}</p>
                    )}
                  </>
                )}
              </div>
              <div className="col-span-2 flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => { setShowNewLead(false); setNewLeadErrors({}); }}
                  className="px-4 py-2.5 text-sm font-medium text-stone-600 rounded-xl hover:bg-stone-50 transition-colors"
                  style={{ border: '1px solid #EDE8E3' }}>
                  Cancel
                </button>
                <button type="submit" disabled={creating}
                  className="px-5 py-2.5 text-sm font-semibold bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white rounded-xl transition-colors">
                  {creating ? 'Creating…' : 'Create Lead'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
