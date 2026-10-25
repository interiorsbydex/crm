// Shared lead/project status badge (task #88 introduced ACTIVE/ON_HOLD/INACTIVE
// as a status independent of stage; task #90 reuses the same color coding for
// project status instead of building a second component).
export type EntityStatus = 'ACTIVE' | 'ON_HOLD' | 'INACTIVE';

export const STATUS_LABELS: Record<EntityStatus, string> = {
  ACTIVE: 'Active',
  ON_HOLD: 'On Hold',
  INACTIVE: 'Inactive',
};

export const STATUS_COLORS: Record<EntityStatus, string> = {
  ACTIVE: 'bg-green-100 text-green-700',
  ON_HOLD: 'bg-amber-100 text-amber-700',
  INACTIVE: 'bg-red-100 text-red-700',
};

export default function StatusBadge({
  status,
  className = '',
  title,
}: {
  status: EntityStatus | string;
  className?: string;
  title?: string;
}) {
  const key = (status as EntityStatus) in STATUS_COLORS ? (status as EntityStatus) : 'ACTIVE';
  return (
    <span
      title={title}
      className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ${STATUS_COLORS[key]} ${className}`}
    >
      {STATUS_LABELS[key] ?? status}
    </span>
  );
}
