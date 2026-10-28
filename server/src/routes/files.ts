import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { logActivity } from '../lib/activityLog.js';
import { isAuthorizedForLead } from '../lib/leadAuth.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import { getDocumentTypes, toStoredFileType, documentTypeKey } from '../lib/documentTypes.js';
import { checklistsConfig } from '../lib/checklists.js';
import {
  FUNNEL_ORDER, fileRequirementsForFolder, getEffectiveStageRules, isRequirementMet, type StageRequirement,
} from '../config/stageRequirements.js';

export const filesRouter = Router({ mergeParams: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const ALLOWED_EXTS = new Set([
  'pdf', 'jpg', 'jpeg', 'png', 'webp',
  'ppt', 'pptx', 'doc', 'docx', 'xls', 'xlsx',
]);

// Valid document types and which must be PDFs come from Admin → Document Types
// (lib/documentTypes.ts); the built-in defaults keep the original PDF-only set.
const VALID_STAGES = ['EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER'] as const;

const LEAD_FILES_BUCKET = 'crm-lead-files'; // private bucket

// ── POST /api/leads/:leadId/files — upload a file ─────────────────────────────
filesRouter.post(
  '/',
  verifyToken,
  upload.single('file') as any,
  async (req, res) => {
    try {
      const { leadId } = req.params as { leadId: string };
      const user = req.user!;

      const { stage, fileType } = req.body as { stage?: string; fileType?: string };

      if (!stage || !VALID_STAGES.includes(stage as any)) {
        res.status(400).json({ error: `stage must be one of: ${VALID_STAGES.join(', ')}` });
        return;
      }
      const docType = (await getDocumentTypes()).find((t) => t.key === fileType && t.active);
      if (!fileType || !docType) {
        res.status(400).json({ error: 'Choose a valid document type' });
        return;
      }

      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { id: true, assignedDesignerId: true, assignedBLId: true, status: true },
      });
      if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
      if (!(await isAuthorizedForLead(lead, user))) {
        res.status(403).json({ error: 'Not authorised to upload files for this lead' });
        return;
      }
      if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

      const file = req.file;
      if (!file) { res.status(400).json({ error: 'No file uploaded' }); return; }

      const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
      if (docType.pdfOnly && (file.mimetype !== 'application/pdf' || ext !== 'pdf')) {
        res.status(400).json({ error: `${docType.label} must be uploaded as a PDF file` });
        return;
      }
      if (!ALLOWED_MIMES.has(file.mimetype) || !ALLOWED_EXTS.has(ext)) {
        res.status(400).json({ error: 'Unsupported file type. Allowed: PDF, images, Word, PowerPoint, Excel.' });
        return;
      }
      if (!supabaseAdmin) {
        res.status(500).json({ error: 'Storage not configured' });
        return;
      }

      await supabaseAdmin.storage.createBucket(LEAD_FILES_BUCKET, { public: false }).catch(() => {});

      const storagePath = `${leadId}/${stage}/${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error: uploadError } = await supabaseAdmin.storage
        .from(LEAD_FILES_BUCKET)
        .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
      if (uploadError) {
        res.status(500).json({ error: uploadError.message });
        return;
      }

      const record = await prisma.leadFile.create({
        data: {
          leadId,
          stage: stage as any,
          ...(toStoredFileType(fileType) as { fileType: any; customType: string | null }),
          fileName: file.originalname,
          storagePath,
          uploadedById: user.id,
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });

      // Generate short-lived signed URL for immediate display
      const { data: signed } = await supabaseAdmin.storage
        .from(LEAD_FILES_BUCKET)
        .createSignedUrl(storagePath, 60 * 60);

      await logActivity(user.id, 'FILE_UPLOADED', leadId, {
        fileId: record.id,
        fileName: file.originalname,
        fileType,
        stage,
      });

      res.status(201).json({ file: { ...record, signedUrl: signed?.signedUrl } });
    } catch (err: any) {
      console.error('[files:upload]', err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// ── GET /api/leads/:leadId/files — list files grouped by stage ────────────────
filesRouter.get('/', verifyToken, async (req, res) => {
  try {
    const { leadId } = req.params as { leadId: string };
    const user = req.user!;

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, assignedDesignerId: true, assignedBLId: true, floorPlanUrl: true, stage: true },
    });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!(await isAuthorizedForLead(lead, user))) {
      res.status(403).json({ error: 'Not authorised to view files for this lead' });
      return;
    }

    const rawFiles = await prisma.leadFile.findMany({
      where: { leadId },
      include: { uploadedBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });

    // Generate fresh signed URLs. Files created via the legacy floor-plan
    // upload endpoint (POST /leads/:id/floor-plan) live in the public
    // `crm-files` bucket, not the private `crm-lead-files` bucket, and are
    // tagged with a `crm-files:` storagePath prefix — those already have a
    // permanent public URL and don't need signing.
    const files: Array<Record<string, any>> = await Promise.all(
      // Admin-defined document types are reported as `custom:<key>`.
      rawFiles.map((f) => ({ ...f, fileType: documentTypeKey(f) })).map(async (f) => {
        if (f.storagePath.startsWith('crm-files:')) {
          if (!supabaseAdmin) return { ...f, signedUrl: undefined };
          const realPath = f.storagePath.slice('crm-files:'.length);
          const { data } = supabaseAdmin.storage.from('crm-files').getPublicUrl(realPath);
          return { ...f, signedUrl: data?.publicUrl };
        }
        if (!supabaseAdmin) return { ...f, signedUrl: undefined };
        const { data } = await supabaseAdmin.storage
          .from(LEAD_FILES_BUCKET)
          .createSignedUrl(f.storagePath, 60 * 60);
        return { ...f, signedUrl: data?.signedUrl };
      }),
    );

    // If this lead has a legacy floorPlanUrl (set before the LeadFile system
    // was added in task #30, or via webhook) and no FLOOR_PLAN LeadFile row
    // exists, inject a synthetic file entry so it appears in the Files tab
    // immediately. Re-uploading is blocked once floorPlanUrl is set, so this
    // is the only way legacy floor plans become visible without a DB migration.
    const FLOOR_PLAN_STAGES = ['EFFECTIVE_LEAD', 'MQL', 'DQL'];
    const hasFloorPlanFile = files.some((f) => f['fileType'] === 'FLOOR_PLAN');
    if (lead.floorPlanUrl && !hasFloorPlanFile) {
      const legacyStage = FLOOR_PLAN_STAGES.includes(lead.stage) ? lead.stage : 'MQL';
      files.push({
        id: `legacy-fp-${leadId}`,
        leadId,
        stage: legacyStage,
        fileType: 'FLOOR_PLAN',
        fileName: 'Floor Plan',
        storagePath: lead.floorPlanUrl,
        signedUrl: lead.floorPlanUrl,
        createdAt: new Date().toISOString(),
        uploadedBy: { id: 'system', name: 'Legacy upload' },
        isLegacySynthetic: true,
      });
    }

    // Group by stage
    const grouped: Record<string, typeof files> = {};
    for (const f of files) {
      if (!grouped[f['stage']]) grouped[f['stage']] = [];
      grouped[f['stage']].push(f);
    }

    res.json({ files, grouped });
  } catch (err: any) {
    console.error('[files:list]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/:leadId/files/requirements — required-file badges per folder ──
// Each Files-tab folder shows the document requirements of the move OUT of that
// stage, evaluated by the same engine that gates the stage change, so the
// badges can't drift from the real rules (Admin → Stage Rules).
filesRouter.get('/requirements', verifyToken, async (req, res) => {
  try {
    const { leadId } = req.params as { leadId: string };
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    if (!(await isAuthorizedForLead(lead, req.user!))) {
      res.status(403).json({ error: 'Not authorised to view files for this lead' });
      return;
    }
    const rules = await getEffectiveStageRules();
    const checklists = await checklistsConfig.get();
    const folders: Record<string, { label: string; satisfied: boolean; source: 'stageRule' | 'checklist' }[]> = {};
    for (const stage of FUNNEL_ORDER.slice(0, -1)) {
      const items: { label: string; satisfied: boolean; source: 'stageRule' | 'checklist'; req: StageRequirement }[] = [];
      for (const r of fileRequirementsForFolder(stage, rules)) items.push({ label: r.label, satisfied: false, source: 'stageRule', req: r });
      // The client's approval screenshot belongs to whichever checklist Admin → Checklists
      // asks for it on: the OB→OBM checklist by default, or PD→OB if made required there.
      for (const [kind, folder, name] of [['pdOb', 'PROPOSAL_DISCUSSION', 'PD→OB'], ['obObm', 'ONBOARDING', 'OB→OBM']] as const) {
        if (stage === folder && !checklists[kind].optional.includes('welcomeMailScreenshot')) {
          items.push({ label: `Welcome Mail Approval Screenshot (${name} checklist)`, satisfied: false, source: 'checklist', req: { type: 'file', fileType: 'WELCOME_MAIL_SCREENSHOT', stages: [], label: '' } });
        }
      }
      folders[stage] = await Promise.all(items.map(async ({ req: r, ...item }) => ({ ...item, satisfied: await isRequirementMet(r, lead) })));
    }
    res.json({ folders });
  } catch (err: any) {
    console.error('[files:requirements]', err.message);
    res.status(500).json({ error: err.message });
  }
});
