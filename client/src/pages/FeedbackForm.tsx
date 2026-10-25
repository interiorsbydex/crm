import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Heart } from 'lucide-react';

export default function FeedbackForm() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<'loading' | 'form' | 'submitted' | 'already_done' | 'error'>('loading');
  const [clientName, setClientName] = useState('');
  const [response, setResponse] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/feedback/${token}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setState('error'); return; }
        setClientName(data.clientName ?? '');
        setState(data.alreadySubmitted ? 'already_done' : 'form');
      })
      .catch(() => setState('error'));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!response.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/feedback/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setState('submitted');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f9f7f5] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-full bg-brand-500 flex items-center justify-center mx-auto mb-3">
            <span className="text-white text-xl font-bold">D</span>
          </div>
          <p className="font-semibold text-gray-900">Interiors by DeX</p>
        </div>

        {state === 'loading' && (
          <p className="text-center text-gray-400 animate-pulse">Loading…</p>
        )}

        {state === 'error' && (
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
              <AlertCircle size={28} strokeWidth={1.5} className="text-gray-400" />
            </div>
            <p className="font-semibold text-gray-900 mb-2">Link not found</p>
            <p className="text-sm text-gray-500">This feedback link may have expired or is invalid.</p>
          </div>
        )}

        {state === 'already_done' && (
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 size={28} strokeWidth={1.5} className="text-green-500" />
            </div>
            <p className="font-semibold text-gray-900 mb-2">Already submitted</p>
            <p className="text-sm text-gray-500">
              Thank you{clientName ? `, ${clientName}` : ''}! We have already received your feedback.
            </p>
          </div>
        )}

        {state === 'submitted' && (
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <Heart size={28} strokeWidth={1.5} className="text-green-500" />
            </div>
            <p className="font-semibold text-gray-900 mb-2">Thank you!</p>
            <p className="text-sm text-gray-500">
              Your feedback means a lot to us, {clientName}. We will use it to improve our service.
            </p>
          </div>
        )}

        {state === 'form' && (
          <>
            <div className="mb-6">
              <h1 className="text-xl font-bold text-gray-900 mb-2">
                Hi {clientName}!
              </h1>
              <p className="text-sm text-gray-600 leading-relaxed">
                We noticed we haven't been in touch for a while and would love to hear from you. 
                What's been on your mind regarding your interior design project?
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Your thoughts (anything helps!)
                </label>
                <textarea
                  rows={5}
                  value={response}
                  onChange={(e) => setResponse(e.target.value)}
                  required
                  placeholder="e.g. Budget changed, project on hold, found another designer, still interested but busy…"
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400 resize-none"
                />
              </div>

              {error && <p className="text-sm text-red-500">{error}</p>}

              <button
                type="submit"
                disabled={submitting || !response.trim()}
                className="w-full bg-brand-500 text-white py-3 rounded-xl text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 transition-colors"
              >
                {submitting ? 'Submitting…' : 'Submit Feedback'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
