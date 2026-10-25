import { AlertTriangle, Trash2 } from 'lucide-react';

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  destructive = false, onConfirm, onCancel,
}: Props) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-full animate-in zoom-in-95">
        <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${destructive ? 'bg-red-100' : 'bg-amber-100'}`}>
          {destructive
            ? <Trash2 size={22} strokeWidth={1.8} className="text-red-500" />
            : <AlertTriangle size={22} strokeWidth={1.8} className="text-amber-500" />}
        </div>
        <h2 className="text-base font-semibold text-gray-900 text-center mb-2">{title}</h2>
        <p className="text-sm text-gray-500 text-center mb-6">{message}</p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 border border-gray-200 text-gray-700 py-2 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 py-2 rounded-xl text-sm font-medium text-white transition-colors ${
              destructive ? 'bg-red-500 hover:bg-red-600' : 'bg-brand-500 hover:bg-brand-600'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
