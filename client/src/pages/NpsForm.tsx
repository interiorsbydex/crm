import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, AlertCircle, Heart } from 'lucide-react';

const STAGE_LABELS: Record<string, string> = {
  SALE: 'Sales',
  ONBOARDING: 'Onboarding',
  DESIGN_FREEZE: 'Design Freeze',
  SIGN_OFF: 'Sign Off',
};

export default function NpsForm() {
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<'loading' | 'form' | 'submitting' | 'submitted' | 'already_done' | 'error'>('loading');
  const [clientName, setClientName] = useState('');
  const [stage, setStage] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/feedback/nps/${token}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) { setState('error'); return; }
        setClientName(data.clientName ?? '');
        setStage(data.stage ?? '');
        if (data.alreadySubmitted) { setState('already_done'); return; }

        // Auto-submit if ?score=N is in the URL
        const scoreParam = searchParams.get('score');
        const preScore = scoreParam !== null ? parseInt(scoreParam, 10) : null;
        if (preScore !== null && preScore >= 0 && preScore <= 10) {
          setSelected(preScore);
          setState('form');
          // Small delay so user sees their selection before submitting
          setTimeout(() => submitScore(preScore), 600);
        } else {
          setState('form');
        }
      })
      .catch(() => setState('error'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const submitScore = async (score: number) => {
    setState('submitting');
    setError(null);
    try {
      const res = await fetch(`/api/feedback/nps/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ score }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Submission failed');
      setState('submitted');
    } catch (e: any) {
      setError(e.message);
      setState('form');
    }
  };

  const scoreColor = (i: number, sel: number | null) => {
    const active = sel === i;
    if (active) {
      if (i <= 6) return 'bg-red-500 text-white scale-110';
      if (i <= 8) return 'bg-amber-400 text-white scale-110';
      return 'bg-green-500 text-white scale-110';
    }
    if (i <= 6) return 'bg-red-50 text-red-700 hover:bg-red-100';
    if (i <= 8) return 'bg-amber-50 text-amber-700 hover:bg-amber-100';
    return 'bg-green-50 text-green-700 hover:bg-green-100';
  };

  const stageLabel = STAGE_LABELS[stage] ?? stage;

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
            <p className="text-sm text-gray-500">This survey link may have expired or is invalid.</p>
          </div>
        )}

        {state === 'already_done' && (
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 size={28} strokeWidth={1.5} className="text-green-500" />
            </div>
            <p className="font-semibold text-gray-900 mb-2">Already submitted</p>
            <p className="text-sm text-gray-500">
              Thank you{clientName ? `, ${clientName}` : ''}! We've already received your rating.
            </p>
          </div>
        )}

        {state === 'submitted' && (
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
              <Heart size={28} strokeWidth={1.5} className="text-green-500" />
            </div>
            <p className="font-semibold text-gray-900 mb-2">Thank you, {clientName}!</p>
            <p className="text-sm text-gray-500">
              Your rating has been recorded. We really appreciate your feedback — it helps us serve you better.
            </p>
          </div>
        )}

        {(state === 'form' || state === 'submitting') && (
          <>
            <div className="mb-6">
              <h1 className="text-xl font-bold text-gray-900 mb-2">
                Hi {clientName}! 👋
              </h1>
              {stageLabel && (
                <p className="text-xs font-semibold text-brand-600 uppercase tracking-wider mb-2">
                  {stageLabel} Review
                </p>
              )}
              <p className="text-sm text-gray-600 leading-relaxed">
                How likely are you to recommend <strong>Interiors by DeX</strong> to a friend or family member?
              </p>
            </div>

            <div>
              <div className="flex justify-between mb-2">
                {Array.from({ length: 11 }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => { setSelected(i); submitScore(i); }}
                    disabled={state === 'submitting'}
                    className={`w-9 h-9 rounded-xl text-sm font-bold transition-all duration-150 ${scoreColor(i, selected)} ${state === 'submitting' ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
                  >
                    {i}
                  </button>
                ))}
              </div>
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>Not likely</span>
                <span>Very likely</span>
              </div>
            </div>

            {state === 'submitting' && (
              <p className="text-center text-sm text-gray-400 mt-4 animate-pulse">Saving your rating…</p>
            )}

            {error && <p className="text-sm text-red-500 mt-3">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
