// ── Inactive lead/project lock (task #149) ────────────────────────────────────
// Once a lead is marked Inactive, it — and everything scoped to it (tasks,
// meetings, calls, discounts, quotes, files, checklists, WhatsApp, and any
// project that grew out of it) — is fully locked from further edits until
// it's explicitly reactivated via POST /api/leads/:id/reactivate.
//
// `PATCH /api/leads/:id/status` (which is how a lead gets marked Inactive or
// moved to On Hold in the first place) and the reactivate endpoint itself are
// intentionally never gated by this check — every other lead- or
// project-scoped mutation should call `isLeadLocked`/`sendLeadLockedError`
// right after it fetches the lead (or the lead status via a project) and
// before performing any write.
export const LEAD_LOCKED_MESSAGE = 'This lead is Inactive and locked from edits. Reactivate it first.';

export function isLeadLocked(status: string | null | undefined): boolean {
  return status === 'INACTIVE';
}

// Sends the standard 423 Locked response. Returns nothing — callers must
// `return` right after calling this so the handler doesn't fall through to
// the mutation.
export function sendLeadLockedError(res: { status: (code: number) => { json: (body: unknown) => void } }): void {
  res.status(423).json({ error: LEAD_LOCKED_MESSAGE });
}
