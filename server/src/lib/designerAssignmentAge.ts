export function designerAssignmentDates(
  logs: { leadId: string | null; createdAt: Date; meta: unknown }[],
  designerId: string,
): Map<string, Date> {
  const dates = new Map<string, Date>();
  for (const log of logs) {
    if (!log.leadId) continue;
    const meta = log.meta as { assignedDesignerId?: unknown } | null;
    if (meta?.assignedDesignerId === designerId) dates.set(log.leadId, log.createdAt);
    else dates.delete(log.leadId);
  }
  return dates;
}

export function designerAssignmentAgeDays(
  assignedAt: Date | undefined,
  terminalAt: Date | undefined,
  now = new Date(),
): number | null {
  if (!assignedAt) return null;
  const elapsed = (terminalAt ?? now).getTime() - assignedAt.getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.floor(elapsed / 86_400_000) : null;
}
