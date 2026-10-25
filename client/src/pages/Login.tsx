import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Eye, EyeOff } from 'lucide-react';
import fyxLogo from '../assets/fyx-logo.svg';
import { scheduleProactiveRefresh } from '../lib/api';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (localStorage.getItem('crm_token')) navigate('/leads', { replace: true });
  }, [navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Login failed');
      localStorage.setItem('crm_token', data.accessToken);
      if (data.refreshToken) localStorage.setItem('crm_refresh_token', data.refreshToken);
      localStorage.setItem('crm_user', JSON.stringify(data.user));
      scheduleProactiveRefresh(data.accessToken);
      navigate('/leads', { replace: true });
    } catch (err: any) {
      const message = err?.message ?? 'Login failed';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: '#F5F0EB' }}>
      <div className="bg-white rounded-3xl shadow-warm-lg p-8 sm:p-10 max-w-sm w-full">
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-brand-500 flex items-center justify-center mx-auto mb-5 shadow-warm">
            <img src={fyxLogo} alt="FYX" className="w-11" />
          </div>
          <h1 className="text-2xl font-bold text-stone-900 tracking-tight">FYX — For Your Xperience</h1>
          <p className="text-stone-400 text-sm mt-1.5">Sign in to FYX</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div
              role="alert"
              aria-live="assertive"
              className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm leading-5 text-red-700"
            >
              {error}
            </div>
          )}
          <div>
            <label className="block text-sm font-semibold text-stone-700 mb-1.5">Email</label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(null); }}
              autoComplete="email"
              placeholder="you@interiorsbydex.com"
              className="w-full rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
              style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
              onFocus={(e) => e.currentTarget.style.background = '#fff'}
              onBlur={(e) => e.currentTarget.style.background = '#FDFAF7'}
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-stone-700 mb-1.5">Password</label>
            <input
              type={showPassword ? 'text' : 'password'}
              required
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              autoComplete="current-password"
              placeholder="••••••••"
              className="w-full rounded-xl pl-4 pr-11 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
              style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
              onFocus={(e) => e.currentTarget.style.background = '#fff'}
              onBlur={(e) => e.currentTarget.style.background = '#FDFAF7'}
            />
            <button
              type="button"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              onClick={() => setShowPassword((visible) => !visible)}
              className="relative float-right -mt-9 mr-3 text-stone-400 hover:text-stone-600"
            >
              {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-500 hover:bg-brand-600 disabled:opacity-50 text-white font-semibold py-3 rounded-xl text-sm transition-colors mt-2"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
