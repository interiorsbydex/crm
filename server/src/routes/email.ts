import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { previewEmail, saveDraft, getDraft, sendDraft } from '../lib/emailService.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import multer from 'multer';
import { isAuthorizedForLead } from '../lib/leadAuth.js';
import { addExtra, clearExtras, listExtras, removeExtra } from '../lib/draftExtras.js';
import { istDateTimeLabel } from '../lib/istTime.js';

export const emailRouter = Router();

// ── GET /api/email/preview/:type/:leadId ──────────────────────────────────────
emailRouter.get('/preview/:type/:leadId', verifyToken, async (req, res) => {
  const { type, leadId } = req.params;
  const user = req.user!;

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      meetings: { where: { status: 'COMPLETED' }, orderBy: { scheduledAt: 'desc' }, take: 1 },
      assignedDesigner: { select: { name: true } },
    },
  });
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
  if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

  const latestMeeting = lead.meetings[0];

  const vars: Record<string, string> = {
    clientName: lead.name,
    clientEmail: lead.email ?? '',
    designerName: lead.assignedDesigner?.name ?? 'Your Designer',
    meetingType: latestMeeting?.type ?? '',
    ppNumber: latestMeeting?.ppNumber ? `PP${latestMeeting.ppNumber}` : '',
    scheduledAt: latestMeeting
      ? istDateTimeLabel(latestMeeting.scheduledAt, { weekday: true })
      : '',
    mom: (latestMeeting as any)?.mom ?? '',
    rescheduledReason: (latestMeeting as any)?.rescheduledReason ?? '',
    feedbackLink: '',
  };

  const html = previewEmail(type, vars);

  // Log that this user previewed the email
  await prisma.emailLog.create({
    data: {
      leadId,
      type: `PREVIEW_${type}`,
      sentTo: lead.email ?? '',
      subject: `Preview by ${user.name}`,
      previewedById: user.id,
    },
  }).catch(() => {});

  res.json({ html, vars });
});

// ── PATCH /api/email/draft/:type/:leadId ──────────────────────────────────────
emailRouter.patch('/draft/:type/:leadId', verifyToken, async (req, res) => {
  const { type, leadId } = req.params;
  const { html, subject } = req.body as { html?: string; subject?: string };

  if (!html) { res.status(400).json({ error: 'html is required' }); return; }

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, email: true, name: true, status: true },
  });
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
  if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

  const draftKey = `${leadId}::${type}`;
  await saveDraft(draftKey, subject ?? `${type} — Interiors by DeX`, html, { leadId, type });

  res.json({ message: 'Draft saved', draftKey });
});

// ── POST /api/email/send-draft ────────────────────────────────────────────────
emailRouter.post('/send-draft', verifyToken, async (req, res) => {
  const { draftKey, to, subject, html } = req.body as { draftKey?: string; to?: string; subject?: string; html?: string };
  const user = req.user!;

  if (!draftKey || !to) { res.status(400).json({ error: 'draftKey and to are required' }); return; }

  const draft = await getDraft(draftKey);
  if (!draft) { res.status(404).json({ error: 'Draft not found or expired' }); return; }

  const leadId = draftKey.split('::')[0];
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { status: true } });
  // Marking a lead Inactive locks normal lead edits, but the client-facing
  // inactivation notification is intentionally drafted after that status
  // change and still needs to be reviewed and sent. Keep the exception narrow:
  // only the draft created by the inactivation flow may be sent while locked.
  const isInactivationNotification = draft.meta?.type === 'INACTIVATION_FEEDBACK';
  if (lead && isLeadLocked(lead.status) && !isInactivationNotification) {
    sendLeadLockedError(res);
    return;
  }

  // Some review modals (call summary, task follow-up, on-hold/inactive/
  // reactivate, meeting confirmation) send the possibly-edited subject/html
  // straight through here instead of a separate PATCH /draft/:type/:leadId
  // step, since their draftKey carries a per-record suffix that endpoint
  // can't reconstruct. Apply any edits to the stored draft before sending so
  // they aren't silently discarded.
  if (subject !== undefined || html !== undefined) {
    await saveDraft(draftKey, subject ?? draft.subject, html ?? draft.html, draft.meta, draft.attachments);
  }

  // The sending user's id is passed through so any registered onSentAction
  // (e.g. PD→OB / OB→OBM stage-advance) attributes activity log entries to
  // whoever actually clicked send, not a placeholder system user.
  try {
    await sendDraft(draftKey, to, user.id);
  } catch (err: any) {
    // A rejected send (e.g. provider 422 for an invalid recipient) must not
    // crash the API process. The draft is kept so the user can fix the
    // address and retry.
    console.error('[email:send-draft] send failed:', err?.message);
    res.status(502).json({ error: `Email could not be sent: ${err?.message ?? 'unknown error'}` });
    return;
  }

  res.json({ message: `Email sent to ${to}` });
});

// ── Files added to a mail on its review screen (lib/draftExtras.ts) ──────────
// They go out with the next mail this person sends for the lead.
const extrasUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

async function extrasLead(req: any, res: any) {
  const lead = await prisma.lead.findUnique({
    where: { id: req.params.leadId },
    select: { id: true, assignedDesignerId: true, assignedBLId: true, status: true },
  });
  if (!lead) { res.status(404).json({ error: 'Lead not found' }); return null; }
  if (!(await isAuthorizedForLead(lead, req.user!))) { res.status(403).json({ error: 'Not authorised for this lead' }); return null; }
  return lead;
}

emailRouter.get('/extras/:leadId', verifyToken, async (req, res) => {
  try {
    if (!(await extrasLead(req, res))) return;
    res.json({ files: await listExtras(req.params.leadId, req.user!.id) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

emailRouter.post('/extras/:leadId', verifyToken, (req, res, next) => {
  (extrasUpload.single('file') as any)(req, res, (error: any) => {
    if (error) { res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Each document must be 4 MB or less' : error.message }); return; }
    next();
  });
}, async (req, res) => {
  try {
    const lead = await extrasLead(req, res);
    if (!lead) return;
    if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }
    if (!req.file) { res.status(400).json({ error: 'A document is required' }); return; }
    res.json({ files: await addExtra(req.params.leadId, req.user!.id, req.file) });
  } catch (err: any) { res.status(400).json({ error: err.message }); }
});

// DELETE /extras/:leadId?filename=… removes one file; without filename it clears them all (review screen closed).
emailRouter.delete('/extras/:leadId', verifyToken, async (req, res) => {
  try {
    if (!(await extrasLead(req, res))) return;
    const filename = typeof req.query.filename === 'string' ? req.query.filename : '';
    if (filename) res.json({ files: await removeExtra(req.params.leadId, req.user!.id, filename) });
    else { await clearExtras(req.params.leadId, req.user!.id); res.json({ files: [] }); }
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
