import { Router } from 'express';
import multer from 'multer';
import { prisma } from '../lib/prisma.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { createNotification } from '../lib/notifications.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { isAuthorizedForLead } from '../lib/leadAuth.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';
import { getCrmSettings, type CrmSettings } from '../lib/crmSettings.js';

export const discountsRouter = Router();
export const leadDiscountRouter = Router({ mergeParams: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
// Shared with quotes.ts's quote-document uploads — quotation attachments are PDF-only.
const QUOTE_FILES_BUCKET = 'crm-quote-files';
const ALLOWED_QUOTE_MIMES = new Set(['application/pdf']);
const ALLOWED_QUOTE_EXTS = new Set(['pdf']);

// ── Discount approval limits (Admin → CRM Settings → Discount limits) ────────
// Defaults: ≤ 10% designer self-approves, 11–15% BL, 16–20% Branch Head,
// > 20% Branch Head as a special case; post-discount woodwork below ₹5,00,000
// always goes to the Branch Head as a special case.
type DiscountLimits = CrmSettings['discount'];

/**
 * Compute approval routing from the discount % and post-discount woodwork value.
 *
 * Rules:
 *  ≤ self limit             → SELF (auto-approved, no request sent upstream)
 *  ≤ BL limit               → BL approval
 *  ≤ Branch Head limit      → BRANCH_HEAD approval (direct, no BL step)
 *  > Branch Head limit      → BRANCH_HEAD, isSpecialCase = true
 *  Post-discount woodwork
 *    < woodwork threshold   → BRANCH_HEAD override, isSpecialCase = true
 */
export function computeApprovalRouting(
  discountPct: number,
  woodworkValueExGst: number,
  limits: DiscountLimits,
): { approverRole: 'SELF' | 'BL' | 'BRANCH_HEAD'; isSpecialCase: boolean } {
  const postDiscountWoodwork = woodworkValueExGst * (1 - discountPct / 100);
  const woodworkBelowThreshold = postDiscountWoodwork < limits.woodworkSpecialCaseBelow;

  if (woodworkBelowThreshold || discountPct > limits.branchHeadUpToPct) {
    return { approverRole: 'BRANCH_HEAD', isSpecialCase: true };
  }
  if (discountPct > limits.blApproveUpToPct) {
    return { approverRole: 'BRANCH_HEAD', isSpecialCase: false };
  }
  if (discountPct > limits.selfApproveUpToPct) {
    return { approverRole: 'BL', isSpecialCase: false };
  }
  return { approverRole: 'SELF', isSpecialCase: false };
}

/** Highest discount % each role may approve themselves. */
function authorityCeiling(role: string, limits: DiscountLimits): number {
  if (role === 'BRANCH_HEAD') return 100;
  if (role === 'BL') return limits.blApproveUpToPct;
  if (role === 'DESIGNER' || role === 'CRE') return limits.selfApproveUpToPct;
  return 0;
}

const discountInclude = {
  lead: { select: { id: true, leadId: true, name: true } },
  requestedBy: { select: { id: true, name: true, role: true } },
  reviewedBy: { select: { id: true, name: true } },
  forwardedBy: { select: { id: true, name: true } },
  files: { orderBy: { createdAt: 'asc' as const } },
} as const;

// Hydrate a fresh 1-hour signed URL for each request's quote attachment(s)
// (never store long-lived URLs — mirrors files.ts/quotes.ts). Requests
// created before this migration only have the legacy `quoteLink` or the
// legacy single quoteFileName/quoteStoragePath pair, both left as-is for display.
async function withQuoteFileUrl<T extends { quoteStoragePath: string | null; files?: { id: string; fileName: string; storagePath: string }[] }>(requests: T[]): Promise<(T & { quoteFileUrl?: string; files?: { id: string; fileName: string; storagePath: string; fileUrl?: string }[] })[]> {
  if (!supabaseAdmin) return requests;
  return Promise.all(
    requests.map(async (r) => {
      const [legacyUrl, hydratedFiles] = await Promise.all([
        r.quoteStoragePath
          ? supabaseAdmin!.storage.from(QUOTE_FILES_BUCKET).createSignedUrl(r.quoteStoragePath, 60 * 60).then((res) => res.data?.signedUrl)
          : Promise.resolve(undefined),
        r.files?.length
          ? Promise.all(
              r.files.map(async (f) => {
                const { data } = await supabaseAdmin!.storage.from(QUOTE_FILES_BUCKET).createSignedUrl(f.storagePath, 60 * 60);
                return { ...f, fileUrl: data?.signedUrl };
              }),
            )
          : Promise.resolve(r.files),
      ]);
      return { ...r, quoteFileUrl: legacyUrl, files: hydratedFiles };
    }),
  );
}

// ── POST /api/leads/:leadId/discount-request ──────────────────────────────────
// Task #89: the quote document is a real attachment (multipart `quoteFiles`
// field, one or more files), not a pasted link — mirrors files.ts/quotes.ts's
// upload pattern. Allows multiple attachments per request.
leadDiscountRouter.post('/', verifyToken, upload.array('quoteFiles', 10) as any, async (req, res) => {
  try {
    const { leadId } = req.params as { leadId: string };
    const user = req.user!;

    // multer with a file field puts other fields on req.body as strings —
    // numeric fields are parsed explicitly below.
    const { originalAmount, amount, discountPct, reason, woodworkValueExGst, totalValueExGst } = {
      originalAmount: req.body.originalAmount != null ? Number(req.body.originalAmount) : undefined,
      amount: req.body.amount != null ? Number(req.body.amount) : undefined,
      discountPct: req.body.discountPct != null ? Number(req.body.discountPct) : undefined,
      reason: req.body.reason as string | undefined,
      woodworkValueExGst: req.body.woodworkValueExGst != null ? Number(req.body.woodworkValueExGst) : undefined,
      totalValueExGst: req.body.totalValueExGst != null ? Number(req.body.totalValueExGst) : undefined,
    };

    if (!originalAmount || !amount || !reason) {
      res.status(400).json({ error: 'originalAmount, amount, and reason are required' });
      return;
    }
    if (!woodworkValueExGst || !totalValueExGst) {
      res.status(400).json({ error: 'Woodwork value (ex-GST) and total project value (ex-GST) are required' });
      return;
    }
    if (
      typeof originalAmount !== 'number' || typeof amount !== 'number' ||
      typeof woodworkValueExGst !== 'number' || typeof totalValueExGst !== 'number' ||
      originalAmount <= 0 || amount <= 0 || woodworkValueExGst <= 0 || totalValueExGst <= 0 ||
      amount >= originalAmount
    ) {
      res.status(400).json({ error: 'Amounts must be positive numbers and the discounted amount must be less than the original amount' });
      return;
    }

    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }

    // Task #89: this route accepts and stores a private file upload, so it
    // must be scoped the same way as quotes.ts's lead-quote endpoints —
    // otherwise any authenticated user could create/auto-approve a discount
    // request (and attach a file) for a lead they have no access to.
    if (!(await isAuthorizedForLead(lead, user))) {
      res.status(403).json({ error: 'Not authorised to submit a discount request for this lead' });
      return;
    }
    if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

    // Check for existing pending request
    const existing = await prisma.discountRequest.findFirst({
      where: { leadId, status: 'PENDING' },
    });
    if (existing) {
      res.status(409).json({ error: 'A pending discount request already exists for this lead' });
      return;
    }

    // Canonical discount % is always derived server-side from the amounts —
    // never trust client-supplied discountPct (approval thresholds depend on it).
    const computed = +(((originalAmount - amount) / originalAmount) * 100).toFixed(2);
    if (discountPct != null && Math.abs(discountPct - computed) > 0.1) {
      res.status(400).json({ error: 'discountPct does not match the provided amounts' });
      return;
    }

    // ── Route by new thresholds ───────────────────────────────────────────────
    const limits = (await getCrmSettings()).discount;
    const { approverRole, isSpecialCase } = computeApprovalRouting(computed, woodworkValueExGst, limits);

    // ≤ 10%: auto-approve (designer has authority; no upstream review needed)
    const isAutoApproved = approverRole === 'SELF';

    // ── Quote document attachment(s) (task #89 — real files, not a pasted link) ──
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    for (const f of files) {
      const ext = (f.originalname.split('.').pop() ?? '').toLowerCase();
      if (!ALLOWED_QUOTE_MIMES.has(f.mimetype) || !ALLOWED_QUOTE_EXTS.has(ext)) {
        res.status(400).json({ error: `Unsupported quote file type (${f.originalname}). Quote attachments must be PDF files.` });
        return;
      }
    }
    if (files.length > 0 && !supabaseAdmin) { res.status(500).json({ error: 'Storage not configured' }); return; }

    const uploaded: { fileName: string; storagePath: string }[] = [];
    if (files.length > 0) {
      await supabaseAdmin!.storage.createBucket(QUOTE_FILES_BUCKET, { public: false }).catch(() => {});
      for (const f of files) {
        const storagePath = `discount-requests/${leadId}/${Date.now()}_${f.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const { error: uploadError } = await supabaseAdmin!.storage
          .from(QUOTE_FILES_BUCKET)
          .upload(storagePath, f.buffer, { contentType: f.mimetype, upsert: false });
        if (uploadError) { res.status(500).json({ error: uploadError.message }); return; }
        uploaded.push({ fileName: f.originalname, storagePath });
      }
    }

    const request = await prisma.discountRequest.create({
      data: {
        leadId,
        requestedById: user.id,
        originalAmount,
        amount,
        discountPct: computed,
        reason,
        woodworkValueExGst,
        totalValueExGst,
        approverRole: isAutoApproved ? 'SELF' : approverRole,
        isSpecialCase,
        status: isAutoApproved ? 'APPROVED' : 'PENDING',
        ...(isAutoApproved && {
          reviewedById: user.id,
          reviewedAt: new Date(),
          reviewerComment: `Auto-approved: discount ≤ ${limits.selfApproveUpToPct}%`,
        }),
        files: uploaded.length
          ? { create: uploaded.map((u) => ({ fileName: u.fileName, storagePath: u.storagePath, uploadedById: user.id })) }
          : undefined,
      },
      include: discountInclude,
    });

    await logActivity(user.id, 'DISCOUNT_REQUESTED', leadId, {
      discountPct: computed,
      reason,
      approverRole,
      isSpecialCase,
      autoApproved: isAutoApproved,
    });

    // ── Send notifications based on routing ───────────────────────────────────
    if (!isAutoApproved) {
      if (approverRole === 'BL') {
        // BL range: notify the assigned BL
        if (lead.assignedBLId) {
          await createNotification(
            lead.assignedBLId,
            'DISCOUNT_REQUEST',
            `${user.name} raised a discount request for lead ${lead.leadId} (${lead.name}): ${computed.toFixed(1)}% off — requires your approval`,
            leadId,
          );
        }
      } else {
        // Branch Head range, special case, or low woodwork value: notify Branch Head(s) directly
        const branchHeads = await prisma.user.findMany({
          where: { role: 'BRANCH_HEAD', isActive: true },
          select: { id: true },
        });
        const specialTag = isSpecialCase ? ' 🔴 SPECIAL CASE' : '';
        for (const bh of branchHeads) {
          await createNotification(
            bh.id,
            'DISCOUNT_REQUEST',
            `${user.name} raised a ${computed.toFixed(1)}% discount request for lead ${lead.leadId} (${lead.name}) — requires Branch Head approval${specialTag}`,
            leadId,
          );
        }
      }
    }

    res.status(201).json({ request });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/discount-requests/pending — scoped by role ───────────────────────
discountsRouter.get('/pending', verifyToken, requireRole('BL', 'BRANCH_HEAD'), async (req, res) => {
  try {
    const user = req.user!;
    let where: any = { status: 'PENDING' };

    if (user.role === 'BL') {
      // BL sees requests intended for BL review (approverRole = 'BL' or null for legacy)
      // scoped to their team's leads.
      const members = await prisma.user.findMany({
        where: { blId: user.id },
        select: { id: true },
      });
      where.lead = { assignedDesignerId: { in: members.map((m) => m.id) } };
      where.OR = [
        { approverRole: 'BL' },
        { approverRole: null }, // legacy requests created before approverRole existed
      ];
    } else {
      // BRANCH_HEAD: see all BH-routed or manually forwarded requests
      where.OR = [
        { approverRole: 'BRANCH_HEAD' },
        { forwardedToRole: 'BRANCH_HEAD' },
      ];
    }

    const requests = await prisma.discountRequest.findMany({
      where,
      include: discountInclude,
      orderBy: { createdAt: 'desc' },
    });

    res.json({ requests: await withQuoteFileUrl(requests) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/discount-requests — all requests (filterable) ───────────────────
// The Discounts nav page is visible to every role (Designers see it to track
// their own submissions), but only BL/BRANCH_HEAD have an approval mandate
// spanning other people's requests. Without this scope, any DESIGNER/CRE
// could see every discount amount and reason company-wide via this endpoint,
// not just what they raised — narrow it to `requestedById` for those roles.
discountsRouter.get('/', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const { status, leadId } = req.query as { status?: string; leadId?: string };
    const where: any = {};
    if (status) where.status = status;
    if (leadId) where.leadId = leadId;
    if (!['BL', 'BRANCH_HEAD'].includes(user.role)) where.requestedById = user.id;

    const requests = await prisma.discountRequest.findMany({
      where,
      include: discountInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    res.json({ requests: await withQuoteFileUrl(requests) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/discount-requests/:id/forward — BL escalates to BH ────────────
// Applicable for BL-routed requests only. Requests already routed to
// BRANCH_HEAD do not require manual forwarding.
// The acting BL must own the lead's team (same check as approve/reject).
discountsRouter.patch('/:id/forward', verifyToken, requireRole('BL'), async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;

    const existing = await prisma.discountRequest.findUnique({
      where: { id },
      include: {
        lead: { select: { id: true, leadId: true, name: true, assignedDesignerId: true, status: true } },
        requestedBy: { select: { id: true, name: true } },
      },
    });
    if (!existing) { res.status(404).json({ error: 'Discount request not found' }); return; }
    if (existing.status !== 'PENDING') {
      res.status(409).json({ error: 'Request is no longer pending' });
      return;
    }
    if (isLeadLocked(existing.lead.status)) { sendLeadLockedError(res); return; }
    // Only BL-routed requests need forwarding; BH-direct ones are already routed.
    if (existing.approverRole === 'BRANCH_HEAD') {
      res.status(400).json({ error: 'This request is already routed to Branch Head — no forwarding needed.' });
      return;
    }
    if (existing.approverRole === 'SELF') {
      res.status(400).json({ error: 'This discount was auto-approved — no forwarding needed.' });
      return;
    }
    if (existing.forwardedToRole) {
      res.status(409).json({ error: 'Already forwarded to Branch Head' });
      return;
    }
    // ── Team-ownership check ──────────────────────────────────────────────────
    // A BL may only forward requests for leads assigned to their own team.
    const teamMemberIds = (await prisma.user.findMany({
      where: { blId: user.id },
      select: { id: true },
    })).map((m) => m.id);
    const leadDesignerId = existing.lead.assignedDesignerId;
    if (!leadDesignerId || !teamMemberIds.includes(leadDesignerId)) {
      res.status(403).json({ error: 'This lead is not assigned to your team.' });
      return;
    }

    const updated = await prisma.discountRequest.update({
      where: { id },
      data: {
        forwardedToRole: 'BRANCH_HEAD',
        forwardedById: user.id,
        approverRole: 'BRANCH_HEAD',
      },
      include: discountInclude,
    });

    await logActivity(user.id, 'DISCOUNT_FORWARDED', existing.lead.id, {
      requestId: id, discountPct: Number(existing.discountPct),
    });

    // Notify all BRANCH_HEAD users
    const branchHeads = await prisma.user.findMany({
      where: { role: 'BRANCH_HEAD', isActive: true },
      select: { id: true },
    });
    for (const bh of branchHeads) {
      await createNotification(
        bh.id,
        'DISCOUNT_REQUEST',
        `${user.name} forwarded a ${Number(existing.discountPct).toFixed(1)}% discount request for lead ${existing.lead.leadId} (${existing.lead.name}) — requires Branch Head approval`,
        existing.lead.id,
      );
    }

    res.json({ request: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/discount-requests/:id — approve or reject ─────────────────────
// Authorization rules:
//   BL  — may approve/reject only requests with approverRole='BL' (or null legacy)
//          AND where the lead's assignedDesignerId is on their team
//   BH  — may approve/reject only requests with approverRole='BRANCH_HEAD'
//          or forwardedToRole='BRANCH_HEAD'
//   Percentage ceilings are enforced as a secondary guard on top of routing.
discountsRouter.patch('/:id', verifyToken, requireRole('BL', 'BRANCH_HEAD'), async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.user!;
    const { status, reviewerComment } = req.body as {
      status?: string; reviewerComment?: string;
    };

    if (!status || !['APPROVED', 'REJECTED'].includes(status)) {
      res.status(400).json({ error: 'status must be APPROVED or REJECTED' });
      return;
    }
    if (status === 'REJECTED' && !reviewerComment?.trim()) {
      res.status(400).json({ error: 'reviewerComment is mandatory when rejecting' });
      return;
    }

    const existing = await prisma.discountRequest.findUnique({
      where: { id },
      include: {
        lead: { select: { id: true, leadId: true, name: true, assignedDesignerId: true, status: true } },
        requestedBy: { select: { id: true, name: true } },
      },
    });
    if (!existing) { res.status(404).json({ error: 'Discount request not found' }); return; }
    if (existing.status !== 'PENDING') {
      res.status(409).json({ error: 'Request is no longer pending' });
      return;
    }
    if (isLeadLocked(existing.lead.status)) { sendLeadLockedError(res); return; }

    const discountPctNum = Number(existing.discountPct);
    const limits = (await getCrmSettings()).discount;
    // Requests store their routing when raised; only legacy rows without it
    // fall back to today's limits.
    const effectiveApproverRole = existing.approverRole
      ?? (discountPctNum <= limits.selfApproveUpToPct ? 'SELF' : discountPctNum <= limits.blApproveUpToPct ? 'BL' : 'BRANCH_HEAD');
    const isRoutedToBH = effectiveApproverRole === 'BRANCH_HEAD' || existing.forwardedToRole === 'BRANCH_HEAD';
    const isRoutedToBL = !isRoutedToBH && (effectiveApproverRole === 'BL' || existing.approverRole === null);

    if (user.role === 'BL') {
      // BL can only act on BL-routed requests for their own team
      if (!isRoutedToBL) {
        res.status(403).json({ error: 'This request requires Branch Head approval — you cannot act on it.' });
        return;
      }
      // Ownership check: lead must belong to a member of this BL's team
      const teamMemberIds = (await prisma.user.findMany({
        where: { blId: user.id },
        select: { id: true },
      })).map((m) => m.id);
      const leadDesignerId = existing.lead.assignedDesignerId;
      if (!leadDesignerId || !teamMemberIds.includes(leadDesignerId)) {
        res.status(403).json({ error: 'This lead is not assigned to your team.' });
        return;
      }
      // Percentage ceiling guard (secondary)
      const ceiling = authorityCeiling(user.role, limits);
      if (status === 'APPROVED' && discountPctNum > ceiling) {
        res.status(403).json({ error: `Exceeds your approval authority (max ${ceiling}%). Use /forward to escalate.` });
        return;
      }
    } else {
      // BRANCH_HEAD — can only act on BH-routed or forwarded requests
      if (!isRoutedToBH) {
        res.status(403).json({ error: 'This request is routed for BL approval, not Branch Head.' });
        return;
      }
    }

    const updated = await prisma.discountRequest.update({
      where: { id },
      data: {
        status: status as any,
        reviewedById: user.id,
        reviewerComment,
        reviewedAt: new Date(),
      },
      include: discountInclude,
    });

    await logActivity(user.id, `DISCOUNT_${status}`, existing.lead.id, {
      requestId: id,
      discountPct: discountPctNum,
      reviewerComment,
    });

    // Notify the designer who raised the request
    const notifyMsg =
      `Your discount request for lead ${existing.lead.leadId} (${existing.lead.name}) was ${status.toLowerCase()} by ${user.name}.${reviewerComment ? ` Note: ${reviewerComment}` : ''}`;

    const notifyIds = new Set<string>([existing.requestedById]);

    // Also notify forwarding BL if different from reviewer
    if (existing.forwardedById && existing.forwardedById !== user.id) {
      notifyIds.add(existing.forwardedById);
    }

    await Promise.all(
      Array.from(notifyIds).map((uid) =>
        createNotification(uid, 'DISCOUNT_REQUEST', notifyMsg, existing.lead.id),
      ),
    );

    res.json({ request: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
