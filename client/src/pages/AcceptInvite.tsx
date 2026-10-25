import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import fyxLogo from '../assets/fyx-logo.svg';
import { useWording } from '../lib/wording';

interface InviteInfo {
  email: string;
  role: string;
  name: string;
}

export default function AcceptInvite() {
  const t = useWording();
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ password: '', confirmPassword: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api.get<InviteInfo>(`/accept-invite/${token}`)
      .then(setInfo)
      .catch((e) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const data = await api.post<{ token: string; user?: unknown }>(`/accept-invite/${token}`, form);
      localStorage.setItem('crm_token', data.token);
      if (data.user) localStorage.setItem('crm_user', JSON.stringify(data.user));
      navigate('/dashboard');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const ROLE_LABELS: Record<string, string> = {
    DESIGNER: 'Designer',
    CRE: 'CRE',
    BL: 'Business Lead',
    BRANCH_HEAD: 'Branch Head',
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-brand-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm animate-pulse">Validating invite…</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-brand-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full text-center">
          <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <span className="text-red-500 text-2xl">!</span>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Invite Invalid</h2>
          <p className="text-sm text-gray-500">{loadError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-brand-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full">
        {/* Logo */}
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-full bg-brand-500 flex items-center justify-center mx-auto mb-3">
            <img src={fyxLogo} alt="FYX" className="w-10" />
          </div>
          <h1 className="text-xl font-bold text-gray-900">{t('app.fullName', 'FYX — For Your Xperience')}</h1>
          <p className="text-sm text-gray-400">CRM Platform</p>
        </div>

        {/* Invite info */}
        {info && (
          <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-6 text-sm">
            <p className="font-medium text-gray-900">{info.name}</p>
            <p className="text-gray-500">{info.email}</p>
            <p className="text-xs text-brand-600 mt-1 font-medium">{ROLE_LABELS[info.role] ?? info.role}</p>
          </div>
        )}

        <h2 className="text-base font-semibold text-gray-900 mb-4">Set your password</h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Password <span className="text-red-500">*</span>
            </label>
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              minLength={8}
              placeholder="Minimum 8 characters"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Confirm password <span className="text-red-500">*</span>
            </label>
            <input
              type="password"
              value={form.confirmPassword}
              onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
              required
              placeholder="Re-enter password"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          </div>

          {error && (
            <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-brand-500 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Setting up account…' : 'Activate Account'}
          </button>
        </form>
      </div>
    </div>
  );
}
