import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { runSLACheck } from '../jobs/slaCheck.js';
import { runMidnightCheck } from '../jobs/midnightOverdueTask.js';
import { runWeeklyTaskDigest } from '../jobs/weeklyTaskDigest.js';
import { runUpcomingDueReminder } from '../jobs/upcomingDueReminder.js';
import { runPerformanceRecalc } from '../jobs/performanceRecalc.js';
import { refreshCreditSnapshots } from '../lib/creditSnapshots.js';
import { SALES_STAGE_SLA, type StageSlaThreshold } from '../config/slaConfig.js';
import { getEffectiveStageSla } from '../lib/stageSla.js';
import { getEffectiveMailTemplates, setMailTemplateOverride, resetMailTemplateOverride, MAIL_TEMPLATES } from '../lib/mailTemplates.js';
import { adminMailAttachmentsRouter, adminObmDocumentUploadRouter } from './adminMailAttachments.js';
import { obmDocumentsConfig } from '../lib/obmDocuments.js';
import { OBM_DOC_ITEMS, OBM_DOC_LABELS } from '../lib/checklists.js';
import { validateMasterMailAttachments, downloadMasterMailAttachments, type MasterMailAttachment } from '../lib/mailTemplateAttachments.js';
import { logActivity } from '../lib/activityLog.js';
import { createNotification } from '../lib/notifications.js';
import { resolveBaseUrl } from '../lib/baseUrl.js';
import { sendViaResend } from '../lib/resendEmail.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import {
  StageRulesError, RULE_FIELD_OPTIONS, RULE_MEETING_OPTIONS,
  loadStageRulesState, saveStageRules, resetStageRules, stageRulesHistory, previewStageRulesImpact,
} from '../lib/stageRules.js';
import { DEFAULT_CYCLE_SCHEDULE } from '../lib/targetCycle.js';
import { defaultStageRules, FUNNEL_EDGES, SKIPPABLE_CANDIDATES, WARNABLE_TARGETS, SKIP_FLAG_BY_STAGE } from '../config/stageRequirements.js';
import {
  DOCUMENT_TYPES_CONFIG_KEY, documentTypeOverridesSchema, loadDocumentTypeOverrides, resolveDocumentTypes,
} from '../lib/documentTypes.js';
import { mountVersionedConfig, plainMessage } from '../lib/versionedConfig.js';
import { welcomeMailFilesConfig, WELCOME_FILE_KINDS } from '../lib/welcomeMailFiles.js';
import { automationsConfig, AUTOMATION_EVENTS, CC_ROLES } from '../lib/automations.js';
import { dashboardLayoutsConfig } from '../lib/dashboardLayouts.js';
import { customBoxesConfig, BOX_MEASURES, BOX_SPLITS, BOX_ROLES, BOX_STAGES, BOX_STATUSES } from '../lib/customBoxes.js';
import { permissionsConfig, PERMISSIONS } from '../lib/permissions.js';
import { checklistsConfig, CHECKLIST_NAMES, BUILT_IN_ITEMS } from '../lib/checklists.js';
import { leadRoutingConfig } from '../lib/leadRouting.js';
import { formulaSettingsConfig } from '../lib/formulaSettings.js';
import { meetingSettingsConfig } from '../lib/meetingSettings.js';
import { alertSettingsConfig, NOTIFICATION_TYPES, ALERT_ROLES } from '../lib/notifications.js';
import { reportDefinitionsConfig, WON_STAGE_CHOICES, NPS_SURVEYS, NPS_SURVEY_LABELS, NPS_TRIGGER_STAGES } from '../lib/reportDefinitions.js';
import { BUILT_IN_DOCUMENT_TYPES, getDocumentTypes } from '../lib/documentTypes.js';
import {
  CrmSettingsError, DEFAULT_CRM_SETTINGS, LEAD_DETAIL_OPTIONS, HIDEABLE_STAGES, NAMEABLE_STAGES, DESIGN_PHASE_KEYS,
  loadCrmSettingsState, saveCrmSettings, resetCrmSettings, crmSettingsHistory, getCrmSettings, previewCycleStartDay,
} from '../lib/crmSettings.js';
import { wordingConfig, WORDING_KEYS } from '../lib/wording.js';

export const adminRouter = Router();

adminRouter.use(verifyToken, requireRole('BRANCH_HEAD'));
adminRouter.use('/mail-templates', adminMailAttachmentsRouter);
adminRouter.use('/obm-documents', adminObmDocumentUploadRouter);

// ── GET /api/admin/users ───────────────────────────────────────────────────────
adminRouter.get('/users', async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        _count: { select: { designerLeads: true, blLeads: true } },
        bl: { select: { id: true, name: true } },
        designManager: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ users });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/users/invite — create user record (Supabase handles email) ─
adminRouter.post('/users/invite', async (req, res) => {
  try {
    const { name, email, role, blId, designManagerId, designation } = req.body as {
      name?: string; email?: string; role?: string; blId?: string; designManagerId?: string; designation?: string;
    };
    if (!name?.trim() || !email?.trim() || !role) {
      res.status(400).json({ error: 'name, email, and role are required' });
      return;
    }
    const validRoles = ['DESIGNER', 'DESIGN_MANAGER', 'CRE', 'BL', 'BRANCH_HEAD'];
    if (!validRoles.includes(role)) {
      res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
      return;
    }
    // Designation is a display-only title layered on role — never used for
    // permission checks. Currently the only value is DESIGN_TEAM_LEAD (task #79).
    const validDesignations = ['DESIGN_TEAM_LEAD'];
    if (designation && !validDesignations.includes(designation)) {
      res.status(400).json({ error: `designation must be one of: ${validDesignations.join(', ')}` });
      return;
    }
    if (designManagerId) {
      const manager = await prisma.user.findUnique({ where: { id: designManagerId }, select: { role: true, isActive: true } });
      if (!manager || !manager.isActive || manager.role !== 'DESIGN_MANAGER') {
        res.status(400).json({ error: 'designManagerId must be an active DESIGN_MANAGER user' });
        return;
      }
    }

    // Try to invite via Supabase Admin API (requires SERVICE_ROLE_KEY)
    let supabaseId = `pending-${Date.now()}`;
    try {
      if (supabaseAdmin) {
        const { data, error } = await (supabaseAdmin as any).auth.admin.inviteUserByEmail(email);
        if (data?.user?.id) supabaseId = data.user.id;
        if (error) console.warn('[admin:invite] Supabase invite error:', error.message);
      }
    } catch (e) {
      console.warn('[admin:invite] Supabase admin not available — creating user record only');
    }

    const user = await prisma.user.create({
      data: {
        supabaseId,
        name: name.trim(),
        email: email.toLowerCase().trim(),
        role: role as any,
        ...(designation && { designation: designation as any }),
        blId: blId || undefined,
        designManagerId: designManagerId || undefined,
        isActive: true,
      },
    });
    res.status(201).json({ user, note: 'User created. Supabase invite email sent if SERVICE_ROLE_KEY is configured.' });
  } catch (err: any) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'A user with this email already exists' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

/**
 * Admin is Branch Head only, so switching off or demoting the last active
 * Branch Head (or yourself) would lock everyone out of Admin. Returns the
 * reason to refuse, or null.
 */
async function adminLockoutReason(actorId: string, targetId: string, change: { deactivate?: boolean; role?: string }): Promise<string | null> {
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { role: true, isActive: true } });
  if (!target || target.role !== 'BRANCH_HEAD' || !target.isActive) return null;
  const losesAdmin = change.deactivate || (change.role !== undefined && change.role !== 'BRANCH_HEAD');
  if (!losesAdmin) return null;
  if (targetId === actorId) return change.deactivate
    ? 'You cannot switch off your own account. Ask another Branch Head to do it.'
    : 'You cannot change your own role away from Branch Head. Ask another Branch Head to do it.';
  const others = await prisma.user.count({ where: { role: 'BRANCH_HEAD', isActive: true, id: { not: targetId } } });
  return others === 0 ? 'This is the only active Branch Head. Make someone else Branch Head first, or nobody can open Admin.' : null;
}

// ── PATCH /api/admin/users/:id/deactivate ─────────────────────────────────────
adminRouter.patch('/users/:id/deactivate', async (req, res) => {
  try {
    const { id } = req.params;
    const { reassignDesignerId, reassignBLId } = req.body as {
      reassignDesignerId?: string; reassignBLId?: string;
    };

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    const lockout = await adminLockoutReason(req.user!.id, id, { deactivate: true });
    if (lockout) { res.status(400).json({ error: lockout }); return; }

    // Step 1 — reassign leads if targets provided. Inactive leads are frozen
    // (task #149) and keep their existing assignment — they're excluded here
    // rather than reassigned, since reassignment is itself an edit.
    const reassignOps: Promise<any>[] = [];
    if (reassignDesignerId) {
      reassignOps.push(prisma.lead.updateMany({
        where: { assignedDesignerId: id, status: { not: 'INACTIVE' } },
        data: { assignedDesignerId: reassignDesignerId },
      }));
    }
    if (reassignBLId) {
      reassignOps.push(prisma.lead.updateMany({
        where: { assignedBLId: id, status: { not: 'INACTIVE' } },
        data: { assignedBLId: reassignBLId },
      }));
    }
    if (reassignOps.length) await Promise.all(reassignOps);

    // Step 2 — block if active leads still remain after reassignment
    const remainingLeads = await prisma.lead.count({
      where: {
        OR: [{ assignedDesignerId: id }, { assignedBLId: id }],
        status: 'ACTIVE',
        stage: { notIn: ['HANDED_OVER'] },
      },
    });

    if (remainingLeads > 0) {
      res.status(409).json({
        message: `Reassign all ${remainingLeads} remaining lead(s) before deactivating`,
        count: remainingLeads,
      });
      return;
    }

    // Step 3 — deactivate
    await prisma.user.update({ where: { id }, data: { isActive: false } });

    const affected = (reassignDesignerId || reassignBLId)
      ? await prisma.lead.count({ where: { assignedDesignerId: reassignDesignerId ?? undefined } })
      : 0;
    res.json({ message: `User deactivated. ${affected} leads reassigned.` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/users/:id — update user (role, blId, name) ──────────────
adminRouter.patch('/users/:id', async (req, res) => {
  try {
    const { name, role, blId, designManagerId, isActive, designation } = req.body;
    const lockout = await adminLockoutReason(req.user!.id, req.params.id, { deactivate: isActive === false, role: role || undefined });
    if (lockout) { res.status(400).json({ error: lockout }); return; }
    const validDesignations = ['DESIGN_TEAM_LEAD'];
    if (designation && !validDesignations.includes(designation)) {
      res.status(400).json({ error: `designation must be one of: ${validDesignations.join(', ')}` });
      return;
    }
    if (designManagerId) {
      const manager = await prisma.user.findUnique({ where: { id: designManagerId }, select: { role: true, isActive: true } });
      if (!manager || !manager.isActive || manager.role !== 'DESIGN_MANAGER') {
        res.status(400).json({ error: 'designManagerId must be an active DESIGN_MANAGER user' });
        return;
      }
    }
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(role && { role: role as any }),
        ...(blId !== undefined && { blId: blId || null }),
        ...(designManagerId !== undefined && { designManagerId: designManagerId || null }),
        ...(isActive !== undefined && { isActive }),
        ...(designation !== undefined && { designation: designation ? (designation as any) : null }),
      },
    });
    res.json({ user });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/projects/:id/pd — assign/clear "Project Designer" ───────
// Task #87 — admin-portal-only control. `userId: null` clears the assignment.
adminRouter.patch('/projects/:id/pd', async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { userId } = req.body as { userId?: string | null };

    const project = await prisma.project.findUnique({ where: { id }, include: { lead: { select: { id: true, leadId: true, status: true } } } });
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (isLeadLocked(project.lead.status)) { sendLeadLockedError(res); return; }

    if (userId) {
      const candidate = await prisma.user.findUnique({ where: { id: userId } });
      if (!candidate || !candidate.isActive || candidate.role !== 'DESIGNER') {
        res.status(400).json({ error: 'userId must be an active DESIGNER user' });
        return;
      }
    }

    const updated = await prisma.project.update({
      where: { id },
      data: { pdUserId: userId || null },
      include: { pd: { select: { id: true, name: true } } },
    });

    await logActivity(user.id, 'PROJECT_PD_ASSIGNED', project.lead.id, { projectId: id, pdUserId: userId || null });
    if (userId) {
      await createNotification(userId, 'PD_ASSIGNED', `You were assigned as Project Designer (PD) for lead ${project.lead.leadId}`, project.lead.id);
    }

    res.json({ project: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/projects/:id/dtl — assign/clear "Design Team Lead" ──────
// Restricted to users carrying the DESIGN_TEAM_LEAD designation, so this
// stays consistent with the existing (display-only) Designation system
// rather than introducing a second, disconnected notion of "team lead".
adminRouter.patch('/projects/:id/dtl', async (req, res) => {
  try {
    const user = req.user!;
    const { id } = req.params;
    const { userId } = req.body as { userId?: string | null };

    const project = await prisma.project.findUnique({ where: { id }, include: { lead: { select: { id: true, leadId: true, status: true } } } });
    if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
    if (isLeadLocked(project.lead.status)) { sendLeadLockedError(res); return; }

    if (userId) {
      const candidate = await prisma.user.findUnique({ where: { id: userId } });
      if (!candidate || !candidate.isActive || candidate.designation !== 'DESIGN_TEAM_LEAD') {
        res.status(400).json({ error: 'userId must be an active user with the Design Team Lead designation' });
        return;
      }
    }

    const updated = await prisma.project.update({
      where: { id },
      data: { dtlUserId: userId || null },
      include: { dtl: { select: { id: true, name: true } } },
    });

    await logActivity(user.id, 'PROJECT_DTL_ASSIGNED', project.lead.id, { projectId: id, dtlUserId: userId || null });
    if (userId) {
      await createNotification(userId, 'DTL_ASSIGNED', `You were assigned as Design Team Lead (DTL) for lead ${project.lead.leadId}`, project.lead.id);
    }

    res.json({ project: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/report-schedules ───────────────────────────────────────────
adminRouter.get('/report-schedules', async (_req, res) => {
  try {
    const schedules = await prisma.reportSchedule.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ schedules });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/report-schedules ─────────────────────────────────────────
adminRouter.post('/report-schedules', async (req, res) => {
  try {
    const { type, recipients } = req.body as { type?: string; recipients?: string[] };
    if (!type || !['WEEKLY', 'MONTHLY'].includes(type)) {
      res.status(400).json({ error: 'type must be WEEKLY or MONTHLY' });
      return;
    }
    if (!Array.isArray(recipients) || recipients.length === 0) {
      res.status(400).json({ error: 'recipients must be a non-empty array of userId' });
      return;
    }
    const schedule = await prisma.reportSchedule.create({ data: { type, recipients } });
    res.status(201).json({ schedule });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/report-schedules/:id ────────────────────────────────────
adminRouter.patch('/report-schedules/:id', async (req, res) => {
  try {
    const { recipients } = req.body as { recipients?: string[] };
    const schedule = await prisma.reportSchedule.update({
      where: { id: req.params.id },
      data: { ...(Array.isArray(recipients) && { recipients }) },
    });
    res.json({ schedule });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/report-schedules/:id ───────────────────────────────────
adminRouter.delete('/report-schedules/:id', async (req, res) => {
  try {
    await prisma.reportSchedule.delete({ where: { id: req.params.id } });
    res.json({ message: 'Deleted' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/users/:id/deactivation-preview ─────────────────────────────
adminRouter.get('/users/:id/deactivation-preview', async (req, res) => {
  try {
    const { id } = req.params;
    const leads = await prisma.lead.findMany({
      where: {
        OR: [{ assignedDesignerId: id }, { assignedBLId: id }],
        status: 'ACTIVE',
        stage: { notIn: ['HANDED_OVER'] },
      },
      select: { id: true, leadId: true, name: true, stage: true },
      take: 100,
    });
    res.json({ activeLeads: leads.length, leads });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/users/:id/reassign-leads ──────────────────────────────────
adminRouter.post('/users/:id/reassign-leads', async (req, res) => {
  try {
    const { id } = req.params;
    const { reassignToUserId } = req.body as { reassignToUserId?: string };
    if (!reassignToUserId) {
      res.status(400).json({ error: 'reassignToUserId is required' });
      return;
    }
    const targetUser = await prisma.user.findUnique({
      where: { id: reassignToUserId },
      select: { id: true, role: true, blId: true },
    });
    if (!targetUser) { res.status(404).json({ error: 'Target user not found' }); return; }

    // Inactive leads are frozen (task #149) and are excluded from reassignment.
    const [designerCount, blCount] = await Promise.all([
      prisma.lead.updateMany({
        where: { assignedDesignerId: id, status: { not: 'INACTIVE' } },
        data: { assignedDesignerId: reassignToUserId },
      }),
      prisma.lead.updateMany({
        where: { assignedBLId: id, status: { not: 'INACTIVE' } },
        data: { assignedBLId: reassignToUserId },
      }),
    ]);

    res.json({
      message: `Reassigned ${designerCount.count + blCount.count} lead(s) to new user`,
      designerLeadsReassigned: designerCount.count,
      blLeadsReassigned: blCount.count,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/invites — list pending invites ─────────────────────────────
adminRouter.get('/invites', async (_req, res) => {
  try {
    const invites = await prisma.userInvite.findMany({
      where: { acceptedAt: null, expiresAt: { gt: new Date() } },
      include: { invitedBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ invites });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/users/send-invite — UserInvite-based invite flow ──────────
adminRouter.post('/users/send-invite', async (req, res) => {
  try {
    const adminUser = (req as any).user!;
    const { name, email, role, blId, designation } = req.body as {
      name?: string; email?: string; role?: string; blId?: string; designation?: string;
    };
    if (!name?.trim() || !email?.trim() || !role) {
      res.status(400).json({ error: 'name, email, and role are required' });
      return;
    }
    const validRoles = ['DESIGNER', 'CRE', 'BL', 'BRANCH_HEAD'];
    if (!validRoles.includes(role)) {
      res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}` });
      return;
    }
    // blId only makes sense for Designers/CREs reporting to a BL; designation
    // only exists for Designers (see Designation enum) — silently ignore
    // otherwise rather than persisting a value that can never apply.
    if (blId && !['DESIGNER', 'CRE'].includes(role)) {
      res.status(400).json({ error: 'blId only applies to DESIGNER or CRE invites' });
      return;
    }
    if (designation && role !== 'DESIGNER') {
      res.status(400).json({ error: 'designation only applies to DESIGNER invites' });
      return;
    }
    if (blId) {
      const bl = await prisma.user.findUnique({ where: { id: blId } });
      if (!bl || bl.role !== 'BL') {
        res.status(400).json({ error: 'blId must reference an existing BL user' });
        return;
      }
    }

    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours
    const invite = await prisma.userInvite.create({
      data: {
        email: email.toLowerCase().trim(),
        role: role as any,
        name: name.trim(),
        blId: blId || undefined,
        designation: designation ? (designation as any) : undefined,
        invitedById: adminUser.id,
        expiresAt,
      },
    });

    // A hardcoded localhost fallback here would silently hand the admin a
    // link nobody outside this container can open — resolve the real public
    // URL (explicit BASE_URL, else the Replit dev domain) and fail loudly
    // instead of pretending the invite worked.
    const baseUrl = resolveBaseUrl();
    if (!baseUrl) {
      await prisma.userInvite.delete({ where: { id: invite.id } });
      res.status(500).json({
        error: 'Could not determine the app\'s public URL (BASE_URL is not configured), so no usable invite link could be created. Set BASE_URL and try again.',
      });
      return;
    }
    const inviteLink = `${baseUrl}/accept-invite/${invite.token}`;

    const from = process.env.FROM_EMAIL ?? 'noreply@interiorsbydex.com';
    const subject = "You've been invited to FYX CRM";
    const html = `<p>Hi ${name},</p><p>You've been invited to join FYX CRM as <strong>${role}</strong>.</p><p>Click the link below to set up your account (expires in 48 hours):</p><p><a href="${inviteLink}">${inviteLink}</a></p>`;
    let delivery: 'resend' | 'smtp' | 'manual' = 'manual';

    // Send through the project's direct Resend API key. SMTP remains a
    // compatibility fallback if the Resend key is unavailable or rejected.
    try {
      const resendResult = await sendViaResend({ from, to: email, subject, html });
      delivery = 'resend';
      console.log(`[admin:invite] Resend accepted invite email (message ID: ${resendResult.id})`);
    } catch (resendError: any) {
      console.warn('[admin:invite] Resend delivery failed:', resendError.message);

      if (process.env.SMTP_HOST) {
        const nodemailer = await import('nodemailer');
        const transporter = nodemailer.default.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT ?? 587),
          secure: Number(process.env.SMTP_PORT ?? 587) === 465,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.sendMail({ from, to: email, subject, html });
        delivery = 'smtp';
        console.log(`[admin:invite] SMTP sent invite to ${email}`);
      } else {
        console.log(`[admin:invite] No email provider available. INVITE LINK for ${email}: ${inviteLink}`);
      }
    }

    res.status(201).json({
      invite: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt },
      inviteLink,
      note: delivery === 'resend'
        ? 'Invite email sent through Resend'
        : delivery === 'smtp'
          ? 'Invite email sent through SMTP'
          : 'Invite email delivery unavailable — invite link returned for manual sharing',
    });
  } catch (err: any) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'An active invite for this email already exists' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── GET /api/admin/intent-ratings ────────────────────────────────────────────
adminRouter.get('/intent-ratings', async (_req, res) => {
  try {
    const ratings = await prisma.intentRatingConfig.findMany({ orderBy: { rating: 'asc' } });
    res.json({ ratings });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/intent-ratings — upsert all 5 ratings at once ───────────
adminRouter.patch('/intent-ratings', async (req, res) => {
  try {
    const { ratings } = req.body as {
      ratings?: Array<{ rating: number; label: string; description: string; color?: string }>;
    };
    if (!Array.isArray(ratings)) {
      res.status(400).json({ error: 'ratings must be an array' });
      return;
    }
    const ops = ratings.map((r) =>
      prisma.intentRatingConfig.upsert({
        where: { rating: r.rating },
        create: { rating: r.rating, label: r.label, description: r.description, color: r.color ?? '#6b7280' },
        update: { label: r.label, description: r.description, ...(r.color && { color: r.color }) },
      }),
    );
    await Promise.all(ops);
    const updated = await prisma.intentRatingConfig.findMany({ orderBy: { rating: 'asc' } });
    res.json({ ratings: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/custom-fields ─────────────────────────────────────────────
adminRouter.get('/custom-fields', async (_req, res) => {
  try {
    const fields = await prisma.customFieldDefinition.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ fields });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/custom-fields ────────────────────────────────────────────
adminRouter.post('/custom-fields', async (req, res) => {
  try {
    const { key, label, fieldType, selectOptions } = req.body as {
      key?: string; label?: string; fieldType?: string; selectOptions?: unknown[];
    };
    if (!key?.trim() || !label?.trim() || !fieldType) {
      res.status(400).json({ error: 'key, label, and fieldType are required' });
      return;
    }
    const validTypes = ['TEXT', 'NUMBER', 'DATE', 'SELECT'];
    if (!validTypes.includes(fieldType)) {
      res.status(400).json({ error: `fieldType must be one of: ${validTypes.join(', ')}` });
      return;
    }
    const field = await prisma.customFieldDefinition.create({
      data: {
        key: key.trim().toLowerCase().replace(/\s+/g, '_'),
        label: label.trim(),
        fieldType: fieldType as any,
        selectOptions: selectOptions as Prisma.InputJsonValue | undefined,
      },
    });
    res.status(201).json({ field });
  } catch (err: any) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'A custom field with this key already exists' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── PATCH /api/admin/custom-fields/:id ───────────────────────────────────────
adminRouter.patch('/custom-fields/:id', async (req, res) => {
  try {
    const { label, selectOptions, isActive } = req.body;
    const field = await prisma.customFieldDefinition.update({
      where: { id: req.params.id },
      data: {
        ...(label && { label }),
        ...(selectOptions !== undefined && { selectOptions }),
        ...(isActive !== undefined && { isActive }),
      },
    });
    res.json({ field });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/custom-fields/:id — soft delete ─────────────────────────
adminRouter.delete('/custom-fields/:id', async (req, res) => {
  try {
    const field = await prisma.customFieldDefinition.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ field, note: 'Soft deleted — historical data preserved' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/assignment-config ─────────────────────────────────────────
adminRouter.get('/assignment-config', async (_req, res) => {
  try {
    const configs = await prisma.assignmentConfig.findMany();
    const map: Record<string, unknown> = {};
    for (const c of configs) map[c.key] = c.value;
    const smartEnabled = process.env.SMART_ASSIGNMENT_ENABLED === 'true';
    res.json({
      smartAssignmentEnabled: smartEnabled,
      premiumThresholdValue: map['premium_threshold_value'] ?? 2000000,
      standardThresholdValue: map['standard_threshold_value'] ?? 500000,
      note: 'Set SMART_ASSIGNMENT_ENABLED=true in env to activate smart assignment',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/assignment-config ─────────────────────────────────────────
adminRouter.post('/assignment-config', async (req, res) => {
  try {
    const { premiumThresholdValue, standardThresholdValue } = req.body as {
      premiumThresholdValue?: number;
      standardThresholdValue?: number;
    };
    const ops = [];
    if (premiumThresholdValue !== undefined) {
      ops.push(prisma.assignmentConfig.upsert({
        where: { key: 'premium_threshold_value' },
        create: { key: 'premium_threshold_value', value: premiumThresholdValue },
        update: { value: premiumThresholdValue },
      }));
    }
    if (standardThresholdValue !== undefined) {
      ops.push(prisma.assignmentConfig.upsert({
        where: { key: 'standard_threshold_value' },
        create: { key: 'standard_threshold_value', value: standardThresholdValue },
        update: { value: standardThresholdValue },
      }));
    }
    await Promise.all(ops);
    res.json({ message: 'Assignment config updated' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET/PUT /api/admin/notify-config — mandatory client-notification toggles ──
// Lets an admin force the "notify client" checkbox to always-on (and block
// the action if the lead has no email/phone) for specific status-change
// flows, instead of leaving it as a freely-uncheckable per-action choice.
const NOTIFY_MANDATORY_KEYS = ['notify_mandatory_on_hold', 'notify_mandatory_inactive', 'notify_mandatory_reactivate'] as const;
type NotifyMandatoryKey = typeof NOTIFY_MANDATORY_KEYS[number];

adminRouter.get('/notify-config', async (_req, res) => {
  try {
    const configs = await prisma.assignmentConfig.findMany({ where: { key: { in: [...NOTIFY_MANDATORY_KEYS] } } });
    const map: Record<string, boolean> = {};
    for (const key of NOTIFY_MANDATORY_KEYS) map[key] = false;
    for (const c of configs) map[c.key] = c.value === true;
    res.json({ config: map });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.put('/notify-config', async (req, res) => {
  try {
    const body = req.body as Partial<Record<NotifyMandatoryKey, boolean>>;
    const ops = [];
    for (const key of NOTIFY_MANDATORY_KEYS) {
      const val = body[key];
      if (typeof val !== 'boolean') continue;
      ops.push(prisma.assignmentConfig.upsert({
        where: { key }, create: { key, value: val }, update: { value: val },
      }));
    }
    if (!ops.length) { res.status(400).json({ error: 'No valid notify-config keys provided' }); return; }
    await Promise.all(ops);
    const configs = await prisma.assignmentConfig.findMany({ where: { key: { in: [...NOTIFY_MANDATORY_KEYS] } } });
    const map: Record<string, boolean> = {};
    for (const key of NOTIFY_MANDATORY_KEYS) map[key] = false;
    for (const c of configs) map[c.key] = c.value === true;
    res.json({ config: map });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/offer-options — list all offers (incl. inactive) ──────────
adminRouter.get('/offer-options', async (_req, res) => {
  try {
    const offers = await prisma.offerOption.findMany({ orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] });
    res.json({ offers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/offer-options ─────────────────────────────────────────────
adminRouter.post('/offer-options', async (req, res) => {
  try {
    const { label, sortOrder } = req.body as { label?: string; sortOrder?: number };
    if (!label?.trim()) { res.status(400).json({ error: 'label is required' }); return; }
    const offer = await prisma.offerOption.create({
      data: { label: label.trim(), sortOrder: sortOrder ?? 0 },
    });
    res.status(201).json({ offer });
  } catch (err: any) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'An offer with this label already exists' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── PATCH /api/admin/offer-options/:id ────────────────────────────────────────
adminRouter.patch('/offer-options/:id', async (req, res) => {
  try {
    const { label, isActive, sortOrder } = req.body as { label?: string; isActive?: boolean; sortOrder?: number };
    const offer = await prisma.offerOption.update({
      where: { id: req.params.id },
      data: {
        ...(label !== undefined && { label: label.trim() }),
        ...(isActive !== undefined && { isActive }),
        ...(sortOrder !== undefined && { sortOrder }),
      },
    });
    res.json({ offer });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/admin/offer-options/:id — soft delete (deactivate) ───────────
adminRouter.delete('/offer-options/:id', async (req, res) => {
  try {
    const offer = await prisma.offerOption.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ offer, note: 'Soft deleted — leads that already used this offer keep it.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/health — system health ─────────────────────────────────────
adminRouter.get('/health', async (_req, res) => {
  try {
    const [
      totalLeads, totalUsers, activeBreaches, recentWebhooks,
      schedules,
    ] = await Promise.all([
      prisma.lead.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.sLABreach.count({ where: { resolvedAt: null } }),
      prisma.activityLog.findMany({
        where: { action: { contains: 'WEBHOOK' } },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { action: true, createdAt: true, meta: true },
      }),
      prisma.reportSchedule.findMany({ select: { type: true, lastSentAt: true } }),
    ]);

    res.json({
      db: 'connected',
      totalLeads, totalUsers, activeBreaches,
      reportSchedules: schedules,
      recentWebhookEvents: recentWebhooks,
      redisConfigured: !!(process.env.REDIS_URL && !process.env.REDIS_URL.includes('localhost')),
      smtpConfigured: !!process.env.SMTP_HOST,
      twilioConfigured: !!process.env.TWILIO_ACCOUNT_SID,
      metaConfigured: !!process.env.META_PAGE_ACCESS_TOKEN,
      baseUrl: process.env.BASE_URL ?? 'http://localhost:3001',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/sla-config — list all SLA thresholds ──────────────────────
adminRouter.get('/sla-config', async (_req, res) => {
  try {
    const DEFAULT_THRESHOLDS = [
      { rule: 'FIRST_CONTACT_24H', thresholdHours: 24, label: 'First call within N hours' },
      { rule: 'LEAD_TO_MQL_5D', thresholdHours: 120, label: 'Move to MQL within N hours' },
      { rule: 'MQL_TO_DQL_5D', thresholdHours: 120, label: 'Schedule DQL within N hours' },
      { rule: 'PROPOSAL_TO_PP_2D', thresholdHours: 48, label: 'Schedule PP within N hours' },
    ];

    // Auto-seed defaults if missing
    await prisma.sLAConfig.createMany({
      data: DEFAULT_THRESHOLDS.map(({ rule, thresholdHours }) => ({ rule, thresholdHours })),
      skipDuplicates: true,
    });

    const configs = await prisma.sLAConfig.findMany({ orderBy: { rule: 'asc' } });
    const enriched = configs.map((c) => ({
      ...c,
      label: DEFAULT_THRESHOLDS.find((d) => d.rule === c.rule)?.label ?? c.rule,
    }));
    res.json({ configs: enriched });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/sla-config/:rule { thresholdHours } ─────────────────────
adminRouter.patch('/sla-config/:rule', async (req, res) => {
  try {
    const { rule } = req.params;
    const { thresholdHours } = req.body as { thresholdHours?: number };

    if (!thresholdHours || thresholdHours < 1) {
      res.status(400).json({ error: 'thresholdHours must be a positive integer' });
      return;
    }

    const config = await prisma.sLAConfig.upsert({
      where: { rule },
      create: { rule, thresholdHours },
      update: { thresholdHours },
    });
    res.json({ config });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/stage-sla-config — sales-funnel stage SLA thresholds ───────
// Task #14: the *new* stage-transition SLA system (green/yellow/red, drives
// lead-list/pipeline/StageRoadmap badges) — distinct from the older
// /admin/sla-config (first-contact/legacy breach rules) above.
const STAGE_SLA_CONFIG_KEY = 'stage_sla_thresholds';

adminRouter.get('/stage-sla-config', async (_req, res) => {
  try {
    const effective = await getEffectiveStageSla();
    const rows = Object.entries(effective).map(([stage, t]) => ({
      stage,
      label: t.label,
      warningDays: t.warningDays,
      breachDays: t.breachDays,
      isDefault: JSON.stringify(t) === JSON.stringify(SALES_STAGE_SLA[stage]),
    }));
    res.json({ configs: rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/admin/stage-sla-config/:stage { warningDays, breachDays } ──────
adminRouter.patch('/stage-sla-config/:stage', async (req, res) => {
  try {
    const { stage } = req.params;
    const { warningDays, breachDays } = req.body as { warningDays?: number; breachDays?: number };

    if (!SALES_STAGE_SLA[stage]) {
      res.status(400).json({ error: `Unknown stage "${stage}". Must be one of: ${Object.keys(SALES_STAGE_SLA).join(', ')}` });
      return;
    }
    if (!Number.isFinite(warningDays) || !Number.isFinite(breachDays) || warningDays! < 1 || breachDays! < 1) {
      res.status(400).json({ error: 'warningDays and breachDays must be positive integers' });
      return;
    }
    if (warningDays! > breachDays!) {
      res.status(400).json({ error: 'warningDays cannot be greater than breachDays' });
      return;
    }

    const row = await prisma.assignmentConfig.findUnique({ where: { key: STAGE_SLA_CONFIG_KEY } });
    const overrides = (row?.value as Record<string, Partial<StageSlaThreshold>> | undefined) ?? {};
    overrides[stage] = { warningDays, breachDays };

    await prisma.assignmentConfig.upsert({
      where: { key: STAGE_SLA_CONFIG_KEY },
      create: { key: STAGE_SLA_CONFIG_KEY, value: overrides },
      update: { value: overrides },
    });

    const effective = await getEffectiveStageSla();
    res.json({ stage, config: { stage, ...effective[stage] } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stage rules (Admin → Stage Rules) ─────────────────────────────────────────
// What a lead needs before it can move from one stage to the next. Engine:
// config/stageRequirements.ts; saving/validation/history: lib/stageRules.ts.
function sendStageRulesError(res: any, err: any) {
  if (err instanceof StageRulesError) {
    res.status(err.status).json({ error: err.message, problems: err.problems });
  } else {
    res.status(500).json({ error: err.message });
  }
}

adminRouter.get('/stage-rules', async (_req, res) => {
  try {
    const [state, customFields, docOverrides] = await Promise.all([
      loadStageRulesState(),
      prisma.customFieldDefinition.findMany({ where: { isActive: true }, select: { key: true, label: true }, orderBy: { label: 'asc' } }),
      loadDocumentTypeOverrides(),
    ]);
    res.json({
      ...state,
      defaults: defaultStageRules(),
      catalog: {
        edges: FUNNEL_EDGES,
        skippableCandidates: SKIPPABLE_CANDIDATES,
        warnableTargets: WARNABLE_TARGETS,
        owedLaterStages: Object.keys(SKIP_FLAG_BY_STAGE),
        fields: RULE_FIELD_OPTIONS,
        meetings: RULE_MEETING_OPTIONS,
        customFields,
        documentTypes: resolveDocumentTypes(docOverrides.overrides),
      },
    });
  } catch (err: any) {
    sendStageRulesError(res, err);
  }
});

adminRouter.put('/stage-rules', async (req, res) => {
  try {
    const { config, revision, note } = req.body as { config?: unknown; revision?: unknown; note?: string };
    const saved = await saveStageRules(config, revision, req.user!.id, typeof note === 'string' ? note : undefined);
    res.json({ revision: saved.revision, updatedAt: saved.updatedAt, config: saved.config });
  } catch (err: any) {
    sendStageRulesError(res, err);
  }
});

adminRouter.post('/stage-rules/preview', async (req, res) => {
  try {
    res.json(await previewStageRulesImpact((req.body as { config?: unknown }).config));
  } catch (err: any) {
    sendStageRulesError(res, err);
  }
});

adminRouter.get('/stage-rules/history', async (_req, res) => {
  try {
    res.json({ history: await stageRulesHistory() });
  } catch (err: any) {
    sendStageRulesError(res, err);
  }
});

adminRouter.delete('/stage-rules', async (req, res) => {
  try {
    await resetStageRules(req.user!.id);
    res.json(await loadStageRulesState());
  } catch (err: any) {
    sendStageRulesError(res, err);
  }
});

// ── CRM settings (Admin → CRM Settings) ───────────────────────────────────────
// Lists and simple numbers the client controls (lib/crmSettings.ts).
function sendCrmSettingsError(res: any, err: any) {
  if (err instanceof CrmSettingsError) res.status(err.status).json({ error: err.message, problems: err.problems });
  else res.status(500).json({ error: err.message });
}

adminRouter.get('/crm-settings', async (_req, res) => {
  try {
    res.json({
      ...(await loadCrmSettingsState()),
      defaults: DEFAULT_CRM_SETTINGS,
      catalog: { leadDetails: LEAD_DETAIL_OPTIONS, hideableStages: HIDEABLE_STAGES, nameableStages: NAMEABLE_STAGES, designPhases: DESIGN_PHASE_KEYS },
    });
  } catch (err: any) {
    sendCrmSettingsError(res, err);
  }
});

adminRouter.put('/crm-settings', async (req, res) => {
  try {
    const { settings, revision, note } = req.body as { settings?: unknown; revision?: unknown; note?: string };
    const saved = await saveCrmSettings(settings, revision, req.user!.id, typeof note === 'string' ? note : undefined);
    res.json({ revision: saved.revision, updatedAt: saved.updatedAt, settings: saved.settings });
  } catch (err: any) {
    sendCrmSettingsError(res, err);
  }
});

// The next cycles if the start day were changed to ?startDay= today (nothing is saved).
adminRouter.get('/crm-settings/cycle-preview', async (req, res) => {
  try {
    const startDay = Number(req.query.startDay);
    if (!Number.isInteger(startDay) || startDay < 1 || startDay > 28) {
      res.status(400).json({ error: 'startDay must be a whole number from 1 to 28' });
      return;
    }
    const settings = await getCrmSettings();
    res.json({ upcoming: previewCycleStartDay(settings.cycleSchedule ?? DEFAULT_CYCLE_SCHEDULE, startDay) });
  } catch (err: any) {
    sendCrmSettingsError(res, err);
  }
});

adminRouter.get('/crm-settings/history', async (_req, res) => {
  try {
    res.json({ history: await crmSettingsHistory() });
  } catch (err: any) {
    sendCrmSettingsError(res, err);
  }
});

adminRouter.delete('/crm-settings', async (req, res) => {
  try {
    await resetCrmSettings(req.user!.id);
    res.json(await loadCrmSettingsState());
  } catch (err: any) {
    sendCrmSettingsError(res, err);
  }
});

// ── Automations (Admin → Automations) ─────────────────────────────────────────
// Which automatic messages are sent, on which channels, and who is copied.
mountVersionedConfig(adminRouter, '/automations', automationsConfig, async () => ({
  catalog: { events: AUTOMATION_EVENTS, ccRoles: CC_ROLES },
}));

// ── Dashboards (Admin → Dashboards) ───────────────────────────────────────────
// Hidden tiles, tile order within sections and tile names, per role's dashboard.
mountVersionedConfig(adminRouter, '/dashboards', dashboardLayoutsConfig);

// ── Custom boxes (Admin → Custom Boxes) ───────────────────────────────────────
// Boxes the Branch Head builds from a menu and puts on a role's dashboard (lib/customBoxes.ts).
mountVersionedConfig(adminRouter, '/custom-boxes', customBoxesConfig, async () => ({
  catalog: { measures: BOX_MEASURES, splits: BOX_SPLITS, roles: BOX_ROLES, stages: BOX_STAGES, statuses: BOX_STATUSES },
}));

// ── Checklist documents (Admin → Checklist Documents) ─────────────────────────
// Standard files sent with the OBM mail for each ticked Onboarding → OBM checklist item (lib/obmDocuments.ts).
mountVersionedConfig(adminRouter, '/obm-documents', obmDocumentsConfig, async () => ({
  catalog: { items: OBM_DOC_ITEMS.map((key) => ({ key, label: OBM_DOC_LABELS[key] })) },
}));

// ── Permissions (Admin → Permissions) ─────────────────────────────────────────
// Which roles may do each action; roles can only be switched off/on among those
// the action was built for (lib/permissions.ts).
mountVersionedConfig(adminRouter, '/permissions', permissionsConfig, async () => ({ catalog: { permissions: PERMISSIONS } }));

// ── Checklists (Admin → Checklists) ───────────────────────────────────────────
// Optional built-in items and the admin's own items per checklist (lib/checklists.ts).
mountVersionedConfig(adminRouter, '/checklists', checklistsConfig, async () => ({
  catalog: { names: CHECKLIST_NAMES, builtIn: BUILT_IN_ITEMS, documentTypes: (await getDocumentTypes()).filter((t) => t.active) },
}));

// ── Lead routing & access (Admin → Lead Routing & Access) ─────────────────────
// Who receives new and qualified leads, and which leads each role can open (lib/leadRouting.ts).
mountVersionedConfig(adminRouter, '/lead-routing', leadRoutingConfig);

// ── Meetings (Admin → Meetings) ───────────────────────────────────────────────
// Meeting type names, availability, intent stars and mandatory details (lib/meetingSettings.ts).
mountVersionedConfig(adminRouter, '/meetings', meetingSettingsConfig);

// ── Welcome Mail (Admin → Welcome Mail) ───────────────────────────────────────
// Which of the lead's files go out with the PD→OB welcome mail (lib/welcomeMailFiles.ts).
mountVersionedConfig(adminRouter, '/welcome-mail-files', welcomeMailFilesConfig, async () => ({ catalog: { kinds: WELCOME_FILE_KINDS.map(({ key, label }) => ({ key, label })), documentTypes: (await getDocumentTypes()).filter((t) => t.active).map(({ key, label }) => ({ key, label })) } }));

// ── In-app alerts (Admin → In-app Alerts) ────────────────────────────────────
// Which roles see each type of in-app alert (lib/notifications.ts).
mountVersionedConfig(adminRouter, '/alerts', alertSettingsConfig, async () => ({ catalog: { types: NOTIFICATION_TYPES, roles: ALERT_ROLES } }));

// ── Wording (Admin → Wording) ─────────────────────────────────────────────────
mountVersionedConfig(adminRouter, '/wording', wordingConfig, async () => ({ catalog: { labels: WORDING_KEYS } }));

// ── Formulas (Admin → Formulas) ───────────────────────────────────────────────
// Medal levels, score weights, intent tiers and contact-health days (lib/formulaSettings.ts).
mountVersionedConfig(adminRouter, '/formulas', formulaSettingsConfig);

// ── Reports & NPS (Admin → Reports & NPS) ─────────────────────────────────────
// Which stages count as onboarded in Reports, and which stage starts each NPS survey (lib/reportDefinitions.ts).
mountVersionedConfig(adminRouter, '/report-definitions', reportDefinitionsConfig, async () => ({
  catalog: { wonStageChoices: WON_STAGE_CHOICES, surveys: NPS_SURVEYS.map((key) => ({ key, label: NPS_SURVEY_LABELS[key] })), triggerStages: NPS_TRIGGER_STAGES },
}));

// ── Document types (Admin → Document Types) ───────────────────────────────────
adminRouter.get('/document-types', async (_req, res) => {
  try {
    const state = await loadDocumentTypeOverrides();
    res.json({ ...state, types: resolveDocumentTypes(state.overrides) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.put('/document-types', async (req, res) => {
  try {
    const { overrides, revision } = req.body as { overrides?: unknown; revision?: unknown };
    const parsed = documentTypeOverridesSchema.safeParse(overrides);
    if (!parsed.success) {
      res.status(400).json({ error: 'The document types could not be saved', problems: parsed.error.issues.map((i) => {
        // Name the type the way the screen does, not by its internal path.
        const [group, at] = i.path;
        const custom = group === 'custom' && typeof at === 'number' ? (overrides as any)?.custom?.[at]?.label : null;
        const builtIn = group === 'builtIn' ? BUILT_IN_DOCUMENT_TYPES.find((t) => t.key === at)?.label : null;
        const name = custom || builtIn;
        return name ? `${name}: ${plainMessage(i.message)}` : plainMessage(i.message);
      }) });
      return;
    }
    const current = await loadDocumentTypeOverrides();
    if (revision !== current.revision) {
      res.status(409).json({ error: 'Someone else saved the document types since you opened this page. Reload and try again.' });
      return;
    }
    // A custom type, once created, keeps its key forever: files point at it.
    const removed = current.overrides.custom.filter((c) => !parsed.data.custom.some((n) => n.key === c.key));
    if (removed.length) {
      res.status(400).json({ error: `Document types can be switched off but not deleted: ${removed.map((r) => r.label).join(', ')}` });
      return;
    }
    const value = { overrides: parsed.data, revision: current.revision + 1, updatedAt: new Date().toISOString(), updatedById: req.user!.id };
    await prisma.assignmentConfig.upsert({
      where: { key: DOCUMENT_TYPES_CONFIG_KEY },
      create: { key: DOCUMENT_TYPES_CONFIG_KEY, value: value as any },
      update: { value: value as any },
    });
    await logActivity(req.user!.id, 'DOCUMENT_TYPES_UPDATED', undefined, { revision: value.revision, overrides: parsed.data });
    res.json({ ...value, types: resolveDocumentTypes(parsed.data) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/whatsapp-templates — read-only list (no DB needed) ─────────
adminRouter.get('/whatsapp-templates', async (_req, res) => {
  const templates = [
    {
      id: 'pre_call_intro',
      label: 'Pre-call Introduction',
      body: 'Hi {{clientName}}, this is {{designerName}} from Interiors by DeX. I would love to connect and understand your interior design requirements. When would be a good time to speak?',
      note: 'Pre-approved WhatsApp template — read-only',
    },
    {
      id: 'rnr_followup',
      label: 'RNR Follow-up',
      body: 'Hi {{clientName}}, I tried reaching you but could not connect. I am here to help with your interior design journey. Please let me know a convenient time to talk!',
      note: 'Pre-approved WhatsApp template — read-only',
    },
    {
      id: 'meeting_confirmation',
      label: 'Meeting Confirmation',
      body: 'Hi {{clientName}}, your {{meetingType}} meeting is confirmed for {{scheduledAt}}. Mode: {{mode}}. Looking forward to meeting you! — Team Interiors by DeX',
      note: 'Pre-approved WhatsApp template — read-only',
    },
    {
      id: 'mom_sent',
      label: 'MOM Sent',
      body: 'Hi {{clientName}}, thank you for the meeting today! I have sent the meeting summary to your email. Please review and reach out if you have any questions.',
      note: 'Pre-approved WhatsApp template — read-only',
    },
    {
      id: 'onboarding_welcome',
      label: 'Onboarding Welcome',
      body: 'Welcome aboard, {{clientName}}! We are thrilled to start your interior design journey with Interiors by DeX. Your designer {{designerName}} will be your primary point of contact.',
      note: 'Pre-approved WhatsApp template — read-only',
    },
    {
      id: 'on_hold_notification',
      label: 'On-Hold Notification',
      body: 'Hi {{clientName}}, your interior design project with Interiors by DeX is on hold until {{revivalDate}}. Reason: {{reason}}. Please reach out if you have any questions.',
      note: 'Pre-approved WhatsApp template — read-only',
    },
  ];
  res.json({ templates, note: 'Templates are pre-approved and managed server-side. Contact Twilio BSP to modify.' });
});

// ── Mail templates (Task #66) — admin-editable defaults for every system-
// triggered email; overrides live in AssignmentConfig via lib/mailTemplates.ts.
// GET returns each template's registry metadata + effective subject/html
// (override if set, else hardcoded default) so Settings can show current state.
adminRouter.get('/mail-templates', async (_req, res) => {
  try {
    const templates = await getEffectiveMailTemplates();
    res.json({ templates });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.put('/mail-templates/:code', async (req, res) => {
  try {
    const { code } = req.params as { code: string };
    const def = MAIL_TEMPLATES.find((t) => t.code === code);
    if (!def) { res.status(404).json({ error: 'Unknown mail template' }); return; }
    const { subject, html, attachments } = req.body as { subject?: string; html?: string; attachments?: unknown };
    if (!subject?.trim() || !html?.trim()) {
      res.status(400).json({ error: 'subject and html are required' });
      return;
    }
    let files: MasterMailAttachment[] | undefined;
    if (attachments !== undefined) {
      try {
        files = validateMasterMailAttachments(attachments);
        if (code !== 'OB_OBM_WELCOME' && files.length) throw new Error('Automatic documents apply to the OB→OBM welcome email only');
        // Verify the private files exist before accepting a configuration.
        await downloadMasterMailAttachments(files);
      } catch (error: any) {
        res.status(400).json({ error: error.message });
        return;
      }
    }
    await setMailTemplateOverride(code, subject, html, files);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.delete('/mail-templates/:code', async (req, res) => {
  try {
    const { code } = req.params as { code: string };
    await resetMailTemplateOverride(code);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/admin/jobs/trigger — run a background job immediately ────────────
// ── GET /admin/nps-tracker — NPS responses table for admin ────────────────────
adminRouter.get('/nps-tracker', async (req, res) => {
  try {
    const { designerId, from, to } = req.query as Record<string, string>;

    const where: any = { score: { not: null } };
    if (designerId) {
      where.lead = { assignedDesignerId: designerId };
    }
    if (from || to) {
      where.respondedAt = {};
      if (from) where.respondedAt.gte = new Date(from); // start of that calendar day (UTC)
      if (to) {
        // Make the end date inclusive: advance to midnight of the *next* day so
        // every response submitted during `to` (any time) is included.
        const toDate = new Date(to);
        toDate.setUTCDate(toDate.getUTCDate() + 1);
        where.respondedAt.lt = toDate;
      }
    }

    const responses = await prisma.nPSResponse.findMany({
      where,
      include: {
        lead: {
          select: {
            id: true,
            leadId: true,
            name: true,
            assignedDesigner: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { respondedAt: 'desc' },
      take: 500,
    });

    // Group by lead
    const grouped = new Map<string, {
      leadDbId: string; leadId: string; leadName: string;
      designerId: string | null; designerName: string;
      scores: Record<string, number>;
    }>();

    for (const r of responses) {
      if (!grouped.has(r.leadId)) {
        grouped.set(r.leadId, {
          leadDbId: r.lead.id,
          leadId: r.lead.leadId,
          leadName: r.lead.name,
          designerId: r.lead.assignedDesigner?.id ?? null,
          designerName: r.lead.assignedDesigner?.name ?? '—',
          scores: {},
        });
      }
      grouped.get(r.leadId)!.scores[r.stage] = r.score!;
    }

    const rows = Array.from(grouped.values()).map((row) => {
      const allScores = Object.values(row.scores);
      const avgNps = allScores.length > 0
        ? +(allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(1)
        : null;
      return { ...row, avgNps };
    });

    res.json({ rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/jobs/trigger', async (req, res) => {
  try {
    const { job } = req.body as { job?: string };

    if (job === 'sla-check') {
      const result = await runSLACheck();
      res.json({ job: 'sla-check', ...result });
      return;
    }

    if (job === 'midnight-overdue') {
      const result = await runMidnightCheck();
      res.json({ job: 'midnight-overdue', ...result });
      return;
    }

    if (job === 'performance-recalc') {
      const result = await runPerformanceRecalc();
      res.json({ job: 'performance-recalc', ...result });
      return;
    }

    if (job === 'credit-snapshots') {
      const result = await refreshCreditSnapshots();
      res.json({ job: 'credit-snapshots', ...result });
      return;
    }

    if (job === 'weekly-task-digest') {
      const result = await runWeeklyTaskDigest();
      res.json({ job: 'weekly-task-digest', ...result });
      return;
    }

    if (job === 'upcoming-due-reminder') {
      const result = await runUpcomingDueReminder();
      res.json({ job: 'upcoming-due-reminder', ...result });
      return;
    }

    res.status(400).json({ error: `Unknown job "${job}". Valid: sla-check, midnight-overdue, performance-recalc, credit-snapshots, weekly-task-digest, upcoming-due-reminder` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
