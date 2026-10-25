import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { api } from './lib/api';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ErrorBoundary from './components/ui/ErrorBoundary';
import Layout from './components/Layout';
import LeadDetail from './pages/LeadDetail';
import LeadList from './pages/LeadList';
import Inbox from './pages/Inbox';
import Meetings from './pages/Meetings';
import Calls from './pages/Calls';
import Discounts from './pages/Discounts';
import Dashboard from './pages/Dashboard';
import Pipeline from './pages/Pipeline';
import Reports from './pages/Reports';
import Admin from './pages/Admin';
import Login from './pages/Login';
import Tasks from './pages/Tasks';
import Settings from './pages/Settings';
import Calendar from './pages/Calendar';
import Notifications from './pages/Notifications';
import FeedbackForm from './pages/FeedbackForm';
import NpsForm from './pages/NpsForm';
import AcceptInvite from './pages/AcceptInvite';
import ProjectList from './pages/ProjectList';
import CollectionList from './pages/CollectionList';
import NpsList from './pages/NpsList';
import ClientHealth from './pages/ClientHealth';
import DataQuality from './pages/DataQuality';
import ClientFeedback from './pages/ClientFeedback';
import { formatISTTime } from './lib/dateFormat';

// ── Auth Guard ────────────────────────────────────────────────────────────────

function RequireAuth({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem('crm_token');
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

// Task #90 — admin-only pages (WORKSPACE nav group) were reachable by typing
// the URL directly even though the sidebar hid them; only BRANCH_HEAD has any
// server-side access to /api/admin/*, so gate the client routes the same way.
function RequireNotRole({ role, children }: { role: string; children: React.ReactNode }) {
  let userRole = '';
  try { userRole = JSON.parse(localStorage.getItem('crm_user') ?? '{}')?.role ?? ''; } catch { /* ignore */ }
  if (userRole === role) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function RequireRole({ role, children }: { role: string; children: React.ReactNode }) {
  let userRole = '';
  try { userRole = JSON.parse(localStorage.getItem('crm_user') ?? '{}')?.role ?? ''; } catch { /* ignore */ }
  if (userRole !== role) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

// ── Home redirect ─────────────────────────────────────────────────────────────

function Home() {
  const [health, setHealth] = useState<{ status: string; timestamp: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ status: string; timestamp: string }>('/health')
      .then(setHealth)
      .catch(() => setError('Server not reachable'));
  }, []);

  return (
    <div className="flex items-center justify-center p-8 min-h-[60vh]">
      <div className="bg-white rounded-2xl shadow p-8 max-w-sm w-full text-center">
        <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 text-sm font-mono mb-6">
          {error ? (
            <p className="text-red-500">{error}</p>
          ) : health ? (
            <div className="flex items-center justify-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-green-600 font-medium">online</span>
              <span className="text-gray-300">·</span>
              <span className="text-gray-500 text-xs">{formatISTTime(health.timestamp)}</span>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2">
              <span className="w-2 h-2 rounded-full bg-gray-300 animate-pulse" />
              <span className="text-gray-400">Connecting…</span>
            </div>
          )}
        </div>
        <Link to="/dashboard" className="block w-full bg-brand-500 hover:bg-brand-600 text-white font-medium py-2.5 rounded-xl text-sm transition-colors">
          Go to Dashboard →
        </Link>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Toaster
          position="top-center"
          toastOptions={{
            duration: 5000,
            style: { background: '#1f2937', color: '#f9fafb', fontSize: '14px', borderRadius: '10px' },
            success: { iconTheme: { primary: '#22c55e', secondary: '#f9fafb' } },
            error: { duration: 7000, iconTheme: { primary: '#ef4444', secondary: '#f9fafb' } },
          }}
        />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/feedback/:token" element={<FeedbackForm />} />
          <Route path="/nps/:token" element={<NpsForm />} />
          <Route path="/accept-invite/:token" element={<AcceptInvite />} />
          <Route
            path="/*"
            element={
              <RequireAuth>
                <Layout>
                  <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/cre-portal" element={<Dashboard />} />
                    <Route path="/pipeline" element={<Pipeline />} />
                    <Route path="/leads" element={<LeadList />} />
                    <Route path="/leads/:leadId" element={<LeadDetail />} />
                    <Route path="/inbox" element={<Inbox />} />
                    <Route path="/whatsapp" element={<Inbox />} />
                    <Route path="/meetings" element={<Meetings />} />
                    <Route path="/calls" element={<Calls />} />
                    <Route path="/discounts" element={<Discounts />} />
                    <Route path="/tasks" element={<Tasks />} />
                    <Route path="/reports" element={<Reports />} />
                    <Route path="/client-health" element={<RequireRole role="DESIGNER"><ClientHealth /></RequireRole>} />
                    <Route path="/data-quality" element={<DataQuality />} />
                    <Route path="/admin" element={<RequireRole role="BRANCH_HEAD"><Admin /></RequireRole>} />
                    <Route path="/settings" element={<RequireRole role="BRANCH_HEAD"><Settings /></RequireRole>} />
                    <Route path="/calendar" element={<Calendar />} />
                    <Route path="/notifications" element={<Notifications />} />
                    <Route path="/projects" element={<RequireNotRole role="CRE"><ProjectList /></RequireNotRole>} />
                    <Route path="/collections" element={<CollectionList />} />
                    <Route path="/nps" element={<NpsList />} />
                    <Route path="/client-feedback" element={<RequireRole role="BRANCH_HEAD"><ClientFeedback /></RequireRole>} />
                    <Route path="*" element={<Navigate to="/dashboard" replace />} />
                  </Routes>
                </Layout>
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
