/**
 * PD→OB transition checklist (Task #54)
 *
 * GET   /api/leads/:leadId/pd-ob-checklist                     — get checklist state
 * PATCH /api/leads/:leadId/pd-ob-checklist                     — update checklist fields
 * POST  /api/leads/:leadId/pd-ob-checklist/send-welcome-mail   — validate, send welcome
 *                                                                 mail, mark complete, and
 *                                                                 advance the lead to
 *                                                                 ONBOARDING.
 *
 * The checklist is auto-created when a lead enters PROPOSAL_DISCUSSION (see
 * routes/leads.ts). Its `completedAt` gates PROPOSAL_DISCUSSION → ONBOARDING
 * (config/stageRequirements.ts, type 'pdObChecklist').
 */
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { assertOnboardingTargetEditable, parseOnboardingTargetValue } from '../lib/onboardingTargetValue.js';
import { verifyToken } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { createNotification } from '../lib/notifications.js';
import { isAuthorizedForLead } from '../lib/leadAuth.js';
import { renderMailTemplate } from '../lib/mailTemplates.js';
import { saveDraft, registerOnSentHandler } from '../lib/emailService.js';
import { assignLeadToDesigner, incrementAssigned } from '../services/assignmentService.js';
import {
  normalizeMeetingLocation, assertNoActiveMeeting, computeMeetingNumbering,
  createMeetingRecord, runMeetingScheduledSideEffects, type ScheduleMeetingLead,
} from '../lib/meetingScheduler.js';
import { isLenientForStage, logGateBypass } from '../lib/lenientMode.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import { getCommercialContextForLead } from '../lib/stageTimeline.js';

export const pdObChecklistRouter = Router({ mergeParams: true });

/** Admin-configurable default (see lib/mailTemplates.ts, code PD_OB_WELCOME). */
export async function pdObWelcomeMailTemplate(clientName: string): Promise<{ subject: string; html: string }> {
  return renderMailTemplate('PD_OB_WELCOME', { clientName });
}

/**
 * The checklist stores a human-readable location, while Meeting.mode is a
 * fixed enum used by the Meetings tab. Keep the exact location in `location`
 * and derive a valid reporting mode for the synchronized meeting. Custom
 * locations do not carry enough information to infer a more specific mode, so
 * they use PUBLIC_PLACE as the neutral fallback.
 */
function meetingModeForChecklistLocation(location: string): string {
  const modeByLocation: Record<string, string> = {
    Office: 'EC_VISIT',
    "Client's Site": 'SITE_VISIT',
    'Public Place': 'PUBLIC_PLACE',
    "Client's Place": 'CLIENT_PLACE',
    Virtual: 'VIRTUAL',
  };
  return modeByLocation[location] ?? 'PUBLIC_PLACE';
}

/**
 * Task #65: keeps the lead's ONBOARDING-type Meeting in sync with the OB
 * meeting date/location captured on the PD→OB checklist, so it shows up on
 * the shared Meetings tab/page (which only reads from the Meeting table).
 * ONBOARDING-type meetings are only ever created via this path, so "the
 * lead's ONBOARDING meeting" is treated as the canonical link — no new
 * schema column needed. Reuses the shared scheduler helpers so this gets the
 * same activity log / notification / confirmation email+SMS side effects as
 * any other scheduled meeting.
 */
async function syncOBMeetingFromChecklist(
  lead: { id: string; leadId: string; name: string; email: string | null; assignedDesignerId: string | null; assignedBLId: string | null },
  scheduledAt: Date,
  location: string,
  user: { id: string; role: string },
  notifyClient: boolean,
): Promise<void> {
  const existing = await prisma.meeting.findFirst({
    where: { leadId: lead.id, type: 'ONBOARDING' },
    orderBy: { createdAt: 'desc' },
  });

  if (existing && existing.status === 'SCHEDULED') {
    // Already-active ONBOARDING meeting from a prior checklist save — just
    // update it in place rather than creating a duplicate.
    await prisma.meeting.update({
      where: { id: existing.id },
      data: { scheduledAt, location, mode: meetingModeForChecklistLocation(location) as any },
    });
    return;
  }

  // No active ONBOARDING meeting yet — create one. Guard against the
  // one-active-meeting-per-lead invariant so this never silently creates a
  // conflicting second active meeting.
  await assertNoActiveMeeting(lead.id);
  const { ppNumber } = await computeMeetingNumbering(lead.id, 'ONBOARDING');
  const meeting = await createMeetingRecord(prisma, {
    leadId: lead.id,
    type: 'ONBOARDING',
    mode: meetingModeForChecklistLocation(location),
    scheduledAt: scheduledAt.toISOString(),
    location,
    ppNumber,
  });
  const scheduleLead: ScheduleMeetingLead = {
    id: lead.id, leadId: lead.leadId, name: lead.name, email: lead.email,
    phone: null, assignedDesignerId: lead.assignedDesignerId, assignedBLId: lead.assignedBLId,
  };
  await runMeetingScheduledSideEffects({
    meeting, lead: scheduleLead, user, type: 'ONBOARDING', mode: meetingModeForChecklistLocation(location),
    scheduledAt: scheduledAt.toISOString(), ppNumber, notifyClient,
  });
}

async function loadLeadForChecklist(leadId: string, user: { id: string; role: string }) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true, leadId: true, name: true, email: true, stage: true,
      assignedDesignerId: true, assignedBLId: true, estimatedValue: true, status: true,
    },
  });
  if (!lead) return { lead: null, authorized: false };
  const authorized = await isAuthorizedForLead(lead, user);
  return { lead, authorized };
}

// ── GET /api/leads/:leadId/pd-ob-checklist ────────────────────────────────────
pdObChecklistRouter.get('/', verifyToken, async (req, res) => {
  try {
    const { leadId } = req.params as { leadId: string };
    const { lead, authorized } = await loadLeadForChecklist(leadId, req.user!);
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!authorized) { res.status(403).json({ error: 'Not authorised for this lead' }); return; }

    let checklist = await prisma.pDOBChecklist.findUnique({ where: { leadId } });
    // Self-healing safety net: a lead can be sitting in PROPOSAL_DISCUSSION (or
    // later) without a checklist row if it reached that stage before this
    // gate existed, or via any path that bypassed the leads.ts auto-create.
    // Without this, any entry point (Pipeline board or Lead Detail) shows a
    // permanent "not yet created" dead end instead of the actual checklist.
    // PROPOSAL_PRESENTED is included so a lead skipping PD (PP→OB) can start
    // and complete this same mandatory checklist while still in PP — nothing
    // upstream auto-creates the row for that stage, so this first GET does.
    const STAGES_PAST_PD = new Set(['PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER']);
    if (!checklist && STAGES_PAST_PD.has(lead.stage)) {
      checklist = await prisma.pDOBChecklist.upsert({ where: { leadId }, create: { leadId }, update: {} });
    }

    // One upload satisfies every matching item: files are matched at any stage.

    // File status is sourced from LeadFile. Generated-quotation proof can
    // additionally come from a Quote Builder record, matching the generic
    // stage gate's `quote` requirement.
    const [paymentScreenshot, obQuote, welcomeMailScreenshot, finalPitchPresentationFile, generatedQuoteRecord, generatedQuotationFile] = await Promise.all([
      prisma.leadFile.findFirst({ where: { leadId, fileType: 'PAYMENT_SCREENSHOT' }, select: { id: true } }),
      prisma.leadFile.findFirst({ where: { leadId, fileType: { in: ['OB_QUOTE', 'QUOTATION', 'PR_QUOTATION', 'PP_QUOTATION', 'GENERATED_QUOTE'] } }, select: { id: true } }),
      // Task #84 — client approval-of-wording proof now belongs to the PD→OB
      // welcome mail (moved from OBOBMChecklist), scoped to this checklist's
      // own upload stage(s) so it can't be satisfied by an OBM-stage screenshot.
      prisma.leadFile.findFirst({ where: { leadId, fileType: 'WELCOME_MAIL_SCREENSHOT' }, select: { id: true } }),
      // These two mirror the exact checks send-welcome-mail enforces below —
      // previously absent from this GET response, so the "Share welcome mail"
      // button could appear enabled client-side and then fail server-side
      // with "missing: Final Pitch Presentation file" / "Generated Quotation
      // file" even though every visible checkbox/field was filled in.
      prisma.leadFile.findFirst({ where: { leadId, fileType: { in: ['PITCH_PRESENTATION', 'FINAL_PITCH_PRESENTATION'] } }, select: { id: true } }),
      prisma.quote.findFirst({ where: { leadId }, select: { id: true } }),
      prisma.leadFile.findFirst({ where: { leadId, fileType: { in: ['OB_QUOTE', 'QUOTATION', 'PR_QUOTATION', 'PP_QUOTATION', 'GENERATED_QUOTE'] } }, select: { id: true } }),
    ]);

    res.json({
      checklist: checklist ?? null,
      targetValue: lead.estimatedValue,
      hasPaymentScreenshot: !!paymentScreenshot,
      hasObQuote: !!obQuote,
      hasWelcomeMailScreenshot: !!welcomeMailScreenshot,
      hasFinalPitchPresentationFile: !!finalPitchPresentationFile,
      hasGeneratedQuotationFile: !!generatedQuoteRecord || !!generatedQuotationFile,
      welcomeMailTemplate: await pdObWelcomeMailTemplate(lead.name),
    });
  } catch (err: any) {
    console.error('[pd-ob-checklist:get]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/leads/:leadId/pd-ob-checklist ──────────────────────────────────
pdObChecklistRouter.patch('/', verifyToken, async (req, res) => {
  try {
    const { leadId } = req.params as { leadId: string };
    const { lead, authorized } = await loadLeadForChecklist(leadId, req.user!);
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!authorized) { res.status(403).json({ error: 'Not authorised for this lead' }); return; }
    if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

    const current = await prisma.pDOBChecklist.findUnique({ where: { leadId } });
    if (!current) {
      res.status(404).json({ error: 'PD→OB checklist not found. Lead may not be in PD (Pitch Discussion) stage yet.' });
      return;
    }
    if (current.completedAt) {
      res.status(400).json({ error: 'Checklist already completed — the welcome mail has been sent and the lead has moved to Onboarding.' });
      return;
    }

    const {
      paymentValue, projectValue, furnitureValue, obMeetingScheduledAt, obMeetingLocation, notes,
      finalPitchPresentationConfirmed, notifyClient,
    } = req.body as Record<string, any>;

    let targetValue: number | null | undefined;
    try {
      targetValue = parseOnboardingTargetValue(req.body.targetValue);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (targetValue !== undefined && targetValue !== lead.estimatedValue) {
      const booking = await prisma.dIPChecklist.findUnique({
        where: { leadId }, select: { completedAt: true },
      });
      try {
        assertOnboardingTargetEditable(lead.stage, booking?.completedAt ?? null);
      } catch (error: any) {
        res.status(409).json({ error: error.message });
        return;
      }
    }
    const data: Record<string, any> = {};
    if (paymentValue !== undefined) data.paymentValue = paymentValue === '' || paymentValue === null ? null : parseFloat(paymentValue);
    if (projectValue !== undefined) data.projectValue = projectValue === '' || projectValue === null ? null : parseFloat(projectValue);
    if (furnitureValue !== undefined) data.furnitureValue = furnitureValue === '' || furnitureValue === null ? null : parseFloat(furnitureValue);
    if (obMeetingScheduledAt !== undefined) data.obMeetingScheduledAt = obMeetingScheduledAt ? new Date(obMeetingScheduledAt) : null;
    if (obMeetingLocation !== undefined) {
      try {
        data.obMeetingLocation = normalizeMeetingLocation(obMeetingLocation, 'obMeetingLocation') || null;
      } catch (err: any) {
        res.status(400).json({ error: err.message });
        return;
      }
    }
    if (notes !== undefined) data.notes = notes?.trim() || null;
    if (finalPitchPresentationConfirmed !== undefined) data.finalPitchPresentationConfirmed = !!finalPitchPresentationConfirmed;

    const checklist = await prisma.$transaction(async (tx) => {
      if (targetValue !== undefined && targetValue !== lead.estimatedValue) {
        await tx.lead.update({ where: { id: leadId }, data: { estimatedValue: targetValue } });
      }
      return tx.pDOBChecklist.update({ where: { leadId }, data });
    });
    await logActivity(req.user!.id, 'PD_OB_CHECKLIST_UPDATED', leadId, {
      ...data,
      ...(targetValue !== undefined ? { recordedTargetValue: targetValue, previousRecordedTargetValue: lead.estimatedValue } : {}),
    });

    // Task #65: an OB meeting date/location entered here must also show up on
    // the shared Meetings tab/page, which only ever reads from the Meeting
    // table — the checklist fields alone were invisible everywhere else.
    // Only sync once both fields are present (a Meeting row needs both a
    // scheduledAt and a mode/location); this best-effort sync must never
    // fail the checklist save itself (e.g. if the lead already has an
    // unrelated active meeting blocking a new one).
    if ((obMeetingScheduledAt !== undefined || obMeetingLocation !== undefined)
      && checklist.obMeetingScheduledAt && checklist.obMeetingLocation) {
      await syncOBMeetingFromChecklist(
        lead, checklist.obMeetingScheduledAt, checklist.obMeetingLocation, req.user!,
        notifyClient !== false,
      ).catch((e: any) => console.warn('[pd-ob-checklist:meeting-sync]', e.message));
    }

    res.json({ checklist, targetValue: targetValue !== undefined ? targetValue : lead.estimatedValue });
  } catch (err: any) {
    console.error('[pd-ob-checklist:patch]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/leads/:leadId/pd-ob-checklist/send-welcome-mail ────────────────
pdObChecklistRouter.post('/send-welcome-mail', verifyToken, async (req, res) => {
  try {
    const { leadId } = req.params as { leadId: string };
    const user = req.user!;
    const { lead, authorized } = await loadLeadForChecklist(leadId, user);
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!authorized) { res.status(403).json({ error: 'Not authorised for this lead' }); return; }
    if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

    // A lead skipping PD entirely (PP→OB) completes this same mandatory
    // checklist while still in PROPOSAL_PRESENTED — the checklist itself is
    // never bypassed by the skip, only the separate PP→PD leg's own
    // requirements are (see isExcludedWhenSkipping in stageRequirements.ts).
    const isSkipFromPP = lead.stage === 'PROPOSAL_PRESENTED';
    if (lead.stage !== 'PROPOSAL_DISCUSSION' && !isSkipFromPP) {
      res.status(400).json({ error: `Lead must be in PD (Pitch Discussion) or Proposal Presented stage (currently ${lead.stage}).` });
      return;
    }

    const checklist = await prisma.pDOBChecklist.findUnique({ where: { leadId } });
    if (!checklist) { res.status(404).json({ error: 'PD→OB checklist not found.' }); return; }
    if (checklist.completedAt) { res.status(400).json({ error: 'Welcome mail already sent.' }); return; }

    // One upload satisfies every matching item: files are matched at any stage.

    const [paymentScreenshot, obQuote, finalPitchPresentationFile, generatedQuoteRecord, generatedQuotationFile, welcomeMailScreenshot] = await Promise.all([
      prisma.leadFile.findFirst({ where: { leadId, fileType: 'PAYMENT_SCREENSHOT' }, select: { id: true } }),
      prisma.leadFile.findFirst({ where: { leadId, fileType: { in: ['OB_QUOTE', 'QUOTATION', 'PR_QUOTATION', 'PP_QUOTATION', 'GENERATED_QUOTE'] } }, select: { id: true } }),
      // Both the Final Pitch Presentation AND the Generated Quotation are now
      // required together (previously either/or) — mirrors
      // stageRequirements.ts's PROPOSAL_DISCUSSION->ONBOARDING gate. This
      // direct transition (send-welcome-mail bypasses checkStageRequirements
      // entirely) must enforce the same minimum, or a lead could reach
      // Onboarding without both.
      prisma.leadFile.findFirst({
        where: { leadId, fileType: { in: ['PITCH_PRESENTATION', 'FINAL_PITCH_PRESENTATION'] } },
        select: { id: true },
      }),
      prisma.quote.findFirst({ where: { leadId }, select: { id: true } }),
      prisma.leadFile.findFirst({
        where: { leadId, fileType: { in: ['OB_QUOTE', 'QUOTATION', 'PR_QUOTATION', 'PP_QUOTATION', 'GENERATED_QUOTE'] } },
        select: { id: true },
      }),
      // Task #84: client approval-of-wording proof for THIS mail.
      prisma.leadFile.findFirst({ where: { leadId, fileType: 'WELCOME_MAIL_SCREENSHOT' }, select: { id: true } }),
    ]);

    const missing: string[] = [];
    if (!paymentScreenshot) missing.push('Payment screenshot (Files tab)');
    if (!obQuote) missing.push('OB Quote (Files tab)');
    if (!finalPitchPresentationFile) missing.push('Final Pitch Presentation file (Files → PD or PP if skipping PD)');
    if (!generatedQuoteRecord && !generatedQuotationFile) missing.push('Generated Quotation (Quote Builder or Files → PP/PD)');
    if (checklist.paymentValue == null) missing.push('Payment value');
    if (checklist.projectValue == null) missing.push('Project value (excl. furniture)');
    if (checklist.furnitureValue == null) missing.push('Furniture value');
    if (!checklist.obMeetingScheduledAt) missing.push('OB meeting date/time');
    if (!checklist.obMeetingLocation) missing.push('OB meeting location');
    if (!checklist.notes || !checklist.notes.trim()) missing.push('Notes');
    if (!welcomeMailScreenshot) missing.push('Welcome mail approval screenshot (Files tab)');
    // The client's email can never be waived — there is nobody to send to.
    if (!lead.email) {
      res.status(400).json({ error: 'Cannot send welcome mail — missing requirements', missing: ["Client's email address", ...missing] });
      return;
    }
    // Payment proof is mandatory (client decision) and is never waived by lenient mode.
    if (!paymentScreenshot) {
      res.status(400).json({ error: 'Cannot send welcome mail — payment screenshot is mandatory', missing });
      return;
    }
    if (missing.length && isLenientForStage('ONBOARDING')) {
      await logGateBypass(user.id, leadId, 'PD_OB_CHECKLIST', missing);
    } else if (missing.length) {
      res.status(400).json({ error: 'Cannot send welcome mail — missing requirements', missing });
      return;
    }

    const { subject, html } = req.body as { subject?: string; html?: string };
    const template = await pdObWelcomeMailTemplate(lead.name);
    const emailPayload = { to: lead.email!, subject: subject?.trim() || template.subject, html: html?.trim() || template.html };

    // Batch 12c: no more auto-send here — this now only saves a persisted,
    // editable draft (same infra the MOM mail uses) and returns it for the
    // client to review/edit. The actual send happens via a separate
    // POST /api/email/send-draft call, and only THAT triggers the
    // stage-advance + design-manager-assignment side effects, via
    // completePdObWelcomeSent() below (registered as the onSentAction) —
    // never at draft-creation time.
    const draftKey = `${leadId}::PD_OB_WELCOME`;
    saveDraft(draftKey, emailPayload.subject, emailPayload.html, {
      leadId, type: 'PD_OB_WELCOME', onSentAction: 'PD_OB_WELCOME',
    });

    res.json({
      pendingMail: { draftKey, type: 'PD_OB_WELCOME', to: emailPayload.to, subject: emailPayload.subject, html: emailPayload.html },
    });
  } catch (err: any) {
    console.error('[pd-ob-checklist:send-welcome-mail]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Runs once the PD→OB welcome-mail draft above is actually delivered —
 * registered as the 'PD_OB_WELCOME' onSentAction (lib/emailService.ts).
 * Everything here used to run synchronously inside the send-welcome-mail
 * handler; moving it here means the lead's stage never advances until the
 * mail is truly sent, not merely drafted.
 */
export async function completePdObWelcomeSent(leadId: string, userId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return;
  const fromCommercialContext = await getCommercialContextForLead(leadId);

  // A lead skipping PD entirely (PP→OB) completes this same mandatory
  // checklist while still in PROPOSAL_PRESENTED — mirrors the check in the
  // route above.
  const isSkipFromPP = lead.stage === 'PROPOSAL_PRESENTED';

  // Task #83 spec item 6: PD→OB completion must auto-assign a design
  // manager if the lead doesn't already have one. There's no separate
  // "design manager" role in the schema — the assigned designer becomes
  // the design manager once the project reaches Onboarding, so this reuses
  // the existing designer round-robin (assignmentService) rather than
  // introducing a new role/field.
  let assignedDesignManagerId: string | null = null;
  if (!lead.assignedDesignerId && lead.assignedBLId) {
    assignedDesignManagerId = await assignLeadToDesigner(
      lead.estimatedValue != null ? Number(lead.estimatedValue) : null,
      lead.assignedBLId,
    );
  }

  const now = new Date();
  const [updatedChecklist] = await prisma.$transaction([
    prisma.pDOBChecklist.update({
      where: { leadId },
      data: { welcomeMailSent: true, welcomeMailSentAt: now, completedAt: now },
    }),
    prisma.lead.update({
      where: { id: leadId },
      data: {
        stage: 'ONBOARDING',
        // Record the skip the same way a direct PATCH stage-change would
        // (see leads.ts) so downstream views/reports can tell this lead
        // bypassed PD (Pitch Discussion).
        ...(isSkipFromPP && { skippedProposalDiscussion: true }),
        ...(assignedDesignManagerId && { assignedDesignerId: assignedDesignManagerId }),
      },
    }),
    prisma.oBOBMChecklist.upsert({ where: { leadId }, create: { leadId }, update: {} }),
  ]);
  void updatedChecklist;

  if (assignedDesignManagerId) {
    await incrementAssigned(assignedDesignManagerId);
    await logActivity(userId, 'DESIGN_MANAGER_ASSIGNED', leadId, { designManagerId: assignedDesignManagerId });
    await createNotification(
      assignedDesignManagerId,
      'DESIGNER_ASSIGNED',
      `You've been auto-assigned as design manager for lead ${lead.leadId}, now in Onboarding.`,
      leadId,
    ).catch(() => {});
  }

  await logActivity(userId, 'STAGE_CHANGED', leadId, {
    from: lead.stage,
    to: 'ONBOARDING',
    isBackward: false,
    fromCommercialContext,
    toCommercialContext: await getCommercialContextForLead(leadId),
  });
  await logActivity(userId, 'PD_OB_WELCOME_MAIL_SENT', leadId, {});

  const notifyId = lead.assignedBLId ?? lead.assignedDesignerId;
  if (notifyId) {
    await createNotification(
      notifyId,
      'ONBOARDING_DIP_REQUIRED',
      `Lead ${lead.leadId} moved to Onboarding — welcome mail sent. Complete the OB→OBM checklist next.`,
      leadId,
    ).catch(() => {});
  }
}

registerOnSentHandler('PD_OB_WELCOME', completePdObWelcomeSent);
