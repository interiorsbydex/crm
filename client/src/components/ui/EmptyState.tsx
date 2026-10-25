import { type LucideIcon, ClipboardList } from 'lucide-react';

interface Props {
  Icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export default function EmptyState({ Icon = ClipboardList, title, description, action }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-14 h-14 rounded-2xl bg-stone-100 flex items-center justify-center mb-4">
        <Icon size={26} strokeWidth={1.5} className="text-stone-400" />
      </div>
      <h3 className="text-base font-semibold text-gray-900 mb-1">{title}</h3>
      {description && <p className="text-sm text-gray-400 max-w-xs">{description}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="mt-4 bg-brand-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
