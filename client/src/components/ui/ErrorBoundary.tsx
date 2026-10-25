import { Component, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props { children: ReactNode }
interface State { hasError: boolean; error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error('[ErrorBoundary]', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-red-50 flex items-center justify-center p-6">
          <div className="bg-white rounded-2xl shadow-lg p-10 max-w-md w-full text-center">
            <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-6">
              <AlertTriangle size={28} strokeWidth={1.8} className="text-red-400" />
            </div>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Something went wrong</h1>
            <p className="text-sm text-gray-500 mb-6 font-mono bg-gray-50 rounded-lg p-3 text-left break-all">
              {this.state.error?.message}
            </p>
            <button
              onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
              className="bg-brand-500 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-brand-600"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
