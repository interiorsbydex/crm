/**
 * OB→OBM transition checklist (Task #54)
 *
 * GET   /api/leads/:leadId/ob-obm-checklist                 — get checklist state
 * PATCH /api/leads/:leadId/ob-obm-checklist                 — update timeline dates /
 *                                                               welcome-document items
 * POST  /api/leads/:leadId/ob-obm-checklist/send-obm-mail   — validate, send OBM mail,
 *                                                               mark complete, and advance
 *                                                               the lead to
 *                                                               ONBOARDING_MEETING.
 *
 * The checklist is auto-created when a lead enters ONBOARDING (either via
 * PD→OB's send-welcome-mail action, or as a safety net in routes/leads.ts).
 * Its `completedAt` gates ONBOARDING → ONBOARDING_MEETING
 * (config/stageRequirements.ts, type 'obObmChecklist'). NPS triggering itself
 * happens via the shared POST /api/leads/:id/nps-trigger endpoint.
 *
 * send-obm-mail requires all 8 timeline dates to be filled in, all 7
 * welcome-document items marked done, NPS triggered, and the ONBOARDING-stage
 * Generated Quote file uploaded — see the `missing` checks below.
 */
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { createNotification } from '../lib/notifications.js';
import { isAuthorizedForLead } from '../lib/leadAuth.js';
import { renderMailTemplate, getWelcomeMailAttachments } from '../lib/mailTemplates.js';
import { downloadMasterMailAttachments } from '../lib/mailTemplateAttachments.js';
import { saveDraft, registerOnSentHandler } from '../lib/emailService.js';
import { getNpsSendState } from '../lib/npsHelper.js';
import { DESIGN_PHASES, DESIGN_PHASE_DEFAULT_DAYS, MS_PER_DAY } from '../config/slaConfig.js';
import { isLenientForStage, logGateBypass } from '../lib/lenientMode.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import { getCommercialContextForLead } from '../lib/stageTimeline.js';

export const obObmChecklistRouter = Router({ mergeParams: true });

const DOC_ITEMS = [
  'dexMaterial', 'creditSystem', 'deepCleaning', 'paymentProcess',
  'warrantyClaim', 'continuity', 'cancellation',
] as const;
type DocItem = typeof DOC_ITEMS[number];

const DOC_ITEM_LABELS: Record<DocItem, string> = {
  dexMaterial: 'Dex material / specification',
  creditSystem: 'Credit system',
  deepCleaning: 'Deep cleaning',
  paymentProcess: 'Payment process',
  warrantyClaim: 'Warranty claim',
  continuity: 'Project continuity / team transition',
  cancellation: 'Cancellation policy',
};

const TIMELINE_FIELDS = [
  'siteDocumentationAt', 'initialSiteDiscussionAt', 'layoutFinalisationAt',
  'designDiscussionAt', 'preSignOffAt', 'maskingAt', 'signOffAt',
  'tentativeInteriorHandoverAt',
] as const;
type TimelineField = typeof TIMELINE_FIELDS[number];

const TIMELINE_LABELS: Record<TimelineField, string> = {
  siteDocumentationAt: 'Site documentation date',
  initialSiteDiscussionAt: 'Initial site discussion date',
  layoutFinalisationAt: 'Layout finalisation date',
  designDiscussionAt: 'Design discussion date',
  preSignOffAt: 'Pre sign-off date',
  maskingAt: 'Masking date',
  signOffAt: 'Sign off date',
  tentativeInteriorHandoverAt: 'Tentative interior handover date',
};

/** Admin-configurable default (see lib/mailTemplates.ts, code OB_OBM_WELCOME). */
export async function obmMailTemplate(clientName: string, timelineHtml: string = ''): Promise<{ subject: string; html: string }> {
  return renderMailTemplate('OB_OBM_WELCOME', { clientName, timeline: timelineHtml });
}

async function loadLeadForChecklist(leadId: string, user: { id: string; role: string }) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true, leadId: true, name: true, email: true, stage: true,
      assignedDesignerId: true, assignedBLId: true, createdAt: true, status: true,
    },
  });
  if (!lead) return { lead: null, authorized: false };
  const authorized = await isAuthorizedForLead(lead, user);
  return { lead, authorized };
}

function allDocsDone(c: Record<string, any>): boolean {
  return DOC_ITEMS.every((item) => c[`${item}Done`]);
}

/**
 * Task #84 — project the remaining (not-yet-recorded) Design Pipeline phase
 * dates from whichever of the 7 manual timeline dates ARE filled in, so the
 * OBM welcome mail can show the client an estimated schedule rather than
 * just the phases already booked. Each unrecorded phase's projected date is
 * the previous phase's date (actual or projected) plus that previous
 * phase's default day budget (config/slaConfig.ts) — mirrors the allocation
 * model already used for SLA status on the Design Pipeline view. EIP has no
 * date field of its own and simply starts when Sign Off does.
 */
function projectDesignPhaseDates(
  checklist: Record<string, any> | null | undefined,
  fallbackStart: Date,
): { label: string; date: Date; isProjected: boolean }[] {
  const results: { label: string; date: Date; isProjected: boolean }[] = [];
  let prevDate: Date | null = null;
  let prevKey: string | null = null;

  for (const phase of DESIGN_PHASES) {
    const actual = phase.dateField ? (checklist?.[phase.dateField] as Date | null | undefined) : null;
    let date: Date;
    if (actual) {
      date = actual;
    } else if (phase.dateField === null) {
      // EIP starts the moment the previous phase (Sign Off) is recorded/projected.
      date = prevDate ?? fallbackStart;
    } else {
      const base = prevDate ?? fallbackStart;
      const addDays = prevKey ? (DESIGN_PHASE_DEFAULT_DAYS[prevKey] ?? 0) : 0;
      date = new Date(base.getTime() + addDays * MS_PER_DAY);
    }
    results.push({ label: phase.label, date, isProjected: !actual });
    prevDate = date;
    prevKey = phase.key;
  }
  return results;
}

function fmtTimelineDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderTimelineHtml(
  entries: { label: string; date: Date; isProjected: boolean }[],
  tentativeInteriorHandoverAt?: Date | null,
): string {
  const rows = entries
    .map((e) => `<tr><td style="border:1px solid #ddd;padding:8px">${e.label}</td><td style="border:1px solid #ddd;padding:8px">${fmtTimelineDate(e.date)}${e.isProjected ? ' (estimated)' : ''}</td></tr>`)
    .join('');
  const handoverRow = tentativeInteriorHandoverAt
    ? `<tr><td style="border:1px solid #ddd;padding:8px">Tentative interior handover</td><td style="border:1px solid #ddd;padding:8px">${fmtTimelineDate(tentativeInteriorHandoverAt)}</td></tr>`
    : '';
  return `<table style="width:100%;border-collapse:collapse;text-align:left"><thead><tr><th style="border:1px solid #ddd;padding:8px">Milestone</th><th style="border:1px solid #ddd;padding:8px">Date</th></tr></thead><tbody>${rows}${handoverRow}</tbody></table>`;
}

// ── GET /api/leads/:leadId/ob-obm-checklist ───────────────────────────────────
obObmChecklistRouter.get('/', verifyToken, async (req, res) => {
  try {
    const { leadId } = req.params as { leadId: string };
    const { lead, authorized } = await loadLeadForChecklist(leadId, req.user!);
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!authorized) { res.status(403).json({ error: 'Not authorised for this lead' }); return; }

    const checklist = await prisma.oBOBMChecklist.findUnique({ where: { leadId } });
    const nps = await getNpsSendState(leadId, 'ONBOARDING');
    const timelineHtml = renderTimelineHtml(
      projectDesignPhaseDates(checklist, lead.createdAt),
      checklist?.tentativeInteriorHandoverAt,
    );
    res.json({
      checklist: checklist ? { ...checklist, npsTriggered: nps.status !== 'NOT_SENT', npsTriggeredAt: nps.sentAt } : null,
      docItems: DOC_ITEMS.map((key) => ({ key, label: DOC_ITEM_LABELS[key] })),
      timelineFields: TIMELINE_FIELDS,
      obmMailTemplate: {
        ...await obmMailTemplate(lead.name, timelineHtml),
        attachmentNames: (await getWelcomeMailAttachments()).map((file) => file.name),
      },
    });
  } catch (err: any) {
    console.error('[ob-obm-checklist:get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/leads/:leadId/ob-obm-checklist ─────────────────────────────────
obObmChecklistRouter.patch('/', verifyToken, async (req, res) => {
  try {
    const { leadId } = req.params as { leadId: string };
    const { lead, authorized } = await loadLeadForChecklist(leadId, req.user!);
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!authorized) { res.status(403).json({ error: 'Not authorised for this lead' }); return; }
    if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

    const current = await prisma.oBOBMChecklist.findUnique({ where: { leadId } });
    if (!current) {
      res.status(404).json({ error: 'OB→OBM checklist not found. Lead may not be in Onboarding stage yet.' });
      return;
    }
    if (current.completedAt) {
      res.status(400).json({ error: 'Checklist already completed — the OBM mail has been sent and the lead has moved to Onboarding Meeting.' });
      return;
    }

    const body = req.body as Record<string, any>;
    const data: Record<string, any> = {};

    for (const field of TIMELINE_FIELDS) {
      if (body[field] !== undefined) {
        data[field] = body[field] ? new Date(body[field]) : null;
      }
    }
    for (const item of DOC_ITEMS) {
      const doneKey = `${item}Done`;
      const confirmedKey = `${item}Confirmed`;
      if (body[doneKey] !== undefined) data[doneKey] = !!body[doneKey];
      if (body[confirmedKey] !== undefined) data[confirmedKey] = !!body[confirmedKey];
    }
    if (body.clientConfirmed !== undefined) data.clientConfirmed = !!body.clientConfirmed;
    const checklist = await prisma.oBOBMChecklist.update({ where: { leadId }, data });
    await logActivity(req.user!.id, 'OB_OBM_CHECKLIST_UPDATED', leadId, data);

    const nps = await getNpsSendState(leadId, 'ONBOARDING');
    res.json({ checklist: { ...checklist, npsTriggered: nps.status !== 'NOT_SENT', npsTriggeredAt: nps.sentAt } });
  } catch (err: any) {
    console.error('[ob-obm-checklist:patch]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads/:leadId/ob-obm-checklist/send-obm-mail ───────────────────
obObmChecklistRouter.post('/send-obm-mail', verifyToken, async (req, res) => {
  try {
    const { leadId } = req.params as { leadId: string };
    const user = req.user!;
    const { lead, authorized } = await loadLeadForChecklist(leadId, user);
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!authorized) { res.status(403).json({ error: 'Not authorised for this lead' }); return; }
    if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

    if (lead.stage !== 'ONBOARDING') {
      res.status(400).json({ error: `Lead must be in Onboarding stage (currently ${lead.stage}).` });
      return;
    }

    const checklist = await prisma.oBOBMChecklist.findUnique({ where: { leadId } });
    if (!checklist) { res.status(404).json({ error: 'OB→OBM checklist not found.' }); return; }
    if (checklist.completedAt) { res.status(400).json({ error: 'OBM mail already sent.' }); return; }

    // Fix 2: Generated Quote is already required to enter OB (PD→OB gate requires
    // a quote uploaded at PROPOSAL_DISCUSSION or PROPOSAL_PRESENTED). Requiring it
    // again here with stage:'ONBOARDING' caused a false block because the file's
    // stage tag is PD/PP, never OB. Removed — the earlier gate covers this.
    const missing: string[] = [];
    if (!allDocsDone(checklist)) {
      for (const item of DOC_ITEMS) {
        if (!(checklist as any)[`${item}Done`]) missing.push(DOC_ITEM_LABELS[item]);
      }
    }
    for (const f of TIMELINE_FIELDS) {
      if (!(checklist as any)[f]) missing.push(TIMELINE_LABELS[f]);
    }
    if ((await getNpsSendState(leadId, 'ONBOARDING')).status === 'NOT_SENT') missing.push('NPS survey email sent or customer response received');
    if (!checklist.clientConfirmed) missing.push('Client confirmed');
    // The client's email can never be waived — there is nobody to send to.
    if (!lead.email) {
      res.status(400).json({ error: 'Cannot send OBM mail — missing requirements', missing: ["Client's email address", ...missing] });
      return;
    }
    if (missing.length && isLenientForStage('ONBOARDING')) {
      await logGateBypass(user.id, leadId, 'OB_OBM_CHECKLIST', missing);
    } else if (missing.length) {
      res.status(400).json({ error: 'Cannot send OBM mail — missing requirements', missing });
      return;
    }

    const { subject, html } = req.body as { subject?: string; html?: string };
    const timelineHtml = renderTimelineHtml(
      projectDesignPhaseDates(checklist, lead.createdAt),
      checklist.tentativeInteriorHandoverAt,
    );
    const template = await obmMailTemplate(lead.name, timelineHtml);
    const emailPayload = { to: lead.email!, subject: subject?.trim() || template.subject, html: html?.trim() || template.html };

    // Batch 12c: save a persisted, editable draft instead of auto-sending —
    // the stage-advance + DIP-checklist-upsert side effects now only run
    // once the draft is actually delivered, via completeObObmMailSent()
    // below (registered as the onSentAction), never at draft-creation time.
    const draftKey = `${leadId}::OB_OBM_WELCOME`;
    const attachments = await downloadMasterMailAttachments(await getWelcomeMailAttachments());
    saveDraft(draftKey, emailPayload.subject, emailPayload.html, {
      leadId, type: 'OB_OBM_WELCOME', onSentAction: 'OB_OBM_WELCOME',
    }, attachments);

    res.json({
      pendingMail: { draftKey, type: 'OB_OBM_WELCOME', to: emailPayload.to, subject: emailPayload.subject, html: emailPayload.html },
    });
  } catch (err: any) {
    console.error('[ob-obm-checklist:send-obm-mail]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Runs once the OB→OBM mail draft above is actually delivered — registered
 * as the 'OB_OBM_WELCOME' onSentAction (lib/emailService.ts). Moved out of
 * the request handler so the stage-advance to ONBOARDING_MEETING never
 * happens before the mail is truly sent, not merely drafted.
 */
export async function completeObObmMailSent(leadId: string, userId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return;
  const fromCommercialContext = await getCommercialContextForLead(leadId);

  const now = new Date();
  await prisma.$transaction([
    prisma.oBOBMChecklist.update({
      where: { leadId },
      data: { obmMailSent: true, obmMailSentAt: now, completedAt: now },
    }),
    prisma.lead.update({ where: { id: leadId }, data: { stage: 'ONBOARDING_MEETING' } }),
    prisma.dIPChecklist.upsert({ where: { leadId }, create: { leadId }, update: {} }),
  ]);

  await logActivity(userId, 'STAGE_CHANGED', leadId, {
    from: 'ONBOARDING',
    to: 'ONBOARDING_MEETING',
    isBackward: false,
    fromCommercialContext,
    toCommercialContext: await getCommercialContextForLead(leadId),
  });
  await logActivity(userId, 'OB_OBM_MAIL_SENT', leadId, {});

  const notifyId = lead.assignedBLId ?? lead.assignedDesignerId;
  if (notifyId) {
    await createNotification(
      notifyId,
      'ONBOARDING_DIP_REQUIRED',
      `Lead ${lead.leadId} reached Onboarding Meeting — complete DIP checklist to move to Design in Progress`,
      leadId,
    ).catch(() => {});
  }
}

registerOnSentHandler('OB_OBM_WELCOME', completeObObmMailSent);
