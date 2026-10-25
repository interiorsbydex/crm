import { Router } from 'express';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { timingSafeEqual } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { isAuthorizedForLead } from '../lib/leadAuth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { isLeadLocked, sendLeadLockedError } from '../lib/leadLock.js';

export const quotesRouter = Router();
export const usersDiscountRouter = Router({ mergeParams: true });

// The 'system' placeholder isn't a real user row (no SYSTEM_USER_ID env var is
// configured), so logActivity(SYSTEM_USER_ID, ...) would otherwise fail its FK
// constraint. Resolve to an active Branch Head instead of skipping the log
// entirely, matching the pattern used in leadWebhooks.ts/slaCheck.ts.
const RAW_SYSTEM_USER_ID = process.env.SYSTEM_USER_ID ?? 'system';
let cachedSystemUserId: string | null = null;
async function resolveSystemUserId(): Promise<string | null> {
  if (RAW_SYSTEM_USER_ID !== 'system') return RAW_SYSTEM_USER_ID;
  if (cachedSystemUserId) return cachedSystemUserId;
  const bh = await prisma.user.findFirst({ where: { role: 'BRANCH_HEAD', isActive: true }, select: { id: true } });
  cachedSystemUserId = bh?.id ?? null;
  return cachedSystemUserId;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const QUOTE_FILES_BUCKET = 'crm-quote-files'; // private bucket — task #89
const ALLOWED_QUOTE_MIMES = new Set(['application/pdf']);
const ALLOWED_QUOTE_EXTS = new Set(['pdf']);

// Max discount per role (%)
const DISCOUNT_AUTHORITY: Record<string, number> = {
  DESIGNER: 5,
  CRE: 10,
  BL: 20,
  BRANCH_HEAD: 30,
};

// ── GET /api/users/:id/discount-authority ─────────────────────────────────────
// Called by the Quote Builder before allowing discount submission
usersDiscountRouter.get('/', async (req, res) => {
  try {
    const { id } = req.params as { id: string };
    const user = await prisma.user.findUnique({
      where: { id },
      select: { role: true, name: true },
    });
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    res.json({ userId: id, role: user.role, maxDiscountPct: DISCOUNT_AUTHORITY[user.role] ?? 5 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/quotes/callback — Quote Builder posts back when quote created ───
//
// This endpoint is called directly by the external Quote Builder app
// (proposals.interiorsbydex.com), which is not a CRM user and has no
// Supabase session — verifyToken doesn't apply here. Soft-enforcement:
// a shared secret is checked and mismatches/missing values are logged,
// but the request is still allowed through until the Quote Builder app
// is confirmed to be sending the secret. Flip QUOTE_CALLBACK_HARD_ENFORCE
// to 'true' once that's confirmed to start rejecting bad requests.
const QUOTE_BUILDER_CALLBACK_SECRET = process.env.QUOTE_BUILDER_CALLBACK_SECRET ?? '';
const QUOTE_CALLBACK_HARD_ENFORCE = process.env.QUOTE_CALLBACK_HARD_ENFORCE === 'true';

function callbackSecretMatches(providedSecret: string): boolean {
  if (!QUOTE_BUILDER_CALLBACK_SECRET || providedSecret.length !== QUOTE_BUILDER_CALLBACK_SECRET.length) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(providedSecret, 'utf8'),
    Buffer.from(QUOTE_BUILDER_CALLBACK_SECRET, 'utf8'),
  );
}

type CallbackWriteResult =
  | { kind: 'created'; quote: Awaited<ReturnType<typeof prisma.quote.create>> }
  | { kind: 'updated'; quote: Awaited<ReturnType<typeof prisma.quote.update>> }
  | { kind: 'unchanged'; quote: Awaited<ReturnType<typeof prisma.quote.findFirstOrThrow>> }
  | { kind: 'conflict' };

async function writeQuoteCallback(
  leadId: string,
  quoteRef: string,
  amount: number,
  discountPct: number,
): Promise<CallbackWriteResult> {
  const write = () => prisma.$transaction(async (tx) => {
    const receipt = await tx.quoteCallbackReceipt.findUnique({
      where: { quoteRef },
      include: { quote: true },
    });
    if (receipt) {
      if (receipt.leadId !== leadId) return { kind: 'conflict' } as const;

      const valuesChanged =
        !receipt.quote.amount?.equals(amount) ||
        !receipt.quote.discountPct?.equals(discountPct);
      if (!valuesChanged) return { kind: 'unchanged', quote: receipt.quote } as const;

      const quote = await tx.quote.update({
        where: { id: receipt.quoteId },
        data: { amount, discountPct },
      });
      await tx.lead.update({ where: { id: leadId }, data: { estimatedValue: amount } });
      return { kind: 'updated', quote } as const;
    }

    // Historical CRM rows can share a non-null legacy reference. Reuse the
    // newest matching row and bind it to a receipt rather than creating a
    // duplicate quote. New callbacks create both records atomically.
    const legacyQuote = await tx.quote.findFirst({
      where: { quoteBuilderRef: quoteRef },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (legacyQuote && legacyQuote.leadId !== leadId) return { kind: 'conflict' } as const;

    if (legacyQuote) {
      const valuesChanged =
        !legacyQuote.amount?.equals(amount) ||
        !legacyQuote.discountPct?.equals(discountPct);
      const quote = valuesChanged
        ? await tx.quote.update({ where: { id: legacyQuote.id }, data: { amount, discountPct } })
        : legacyQuote;

      await tx.quoteCallbackReceipt.create({
        data: { quoteRef, leadId, quoteId: quote.id },
      });
      if (valuesChanged) {
        await tx.lead.update({ where: { id: leadId }, data: { estimatedValue: amount } });
        return { kind: 'updated', quote } as const;
      }
      return { kind: 'unchanged', quote } as const;
    }

    const quote = await tx.quote.create({
      data: { leadId, quoteBuilderRef: quoteRef, amount, discountPct, status: 'DRAFT' },
    });
    await tx.quoteCallbackReceipt.create({
      data: { quoteRef, leadId, quoteId: quote.id },
    });
    await tx.lead.update({ where: { id: leadId }, data: { estimatedValue: amount } });
    return { kind: 'created', quote } as const;
  });

  try {
    return await write();
  } catch (error: any) {
    // A concurrent callback may win creation of the unique receipt. Retry once
    // so it follows the existing-receipt path without producing another quote
    // or activity row.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return write();
    }
    throw error;
  }
}

quotesRouter.post('/callback', async (req, res) => {
  try {
    const providedSecret = req.header('x-quote-builder-secret') ?? '';
    if (!QUOTE_BUILDER_CALLBACK_SECRET) {
      console.warn('[quotes:callback] QUOTE_BUILDER_CALLBACK_SECRET is not configured — callback is unauthenticated');
    } else if (!callbackSecretMatches(providedSecret)) {
      console.warn(`[quotes:callback] secret mismatch from ${req.ip} for lead ${req.body?.leadId ?? 'unknown'}${QUOTE_CALLBACK_HARD_ENFORCE ? ' — rejecting' : ' — allowing through (soft-enforce)'}`);
      if (QUOTE_CALLBACK_HARD_ENFORCE) {
        res.status(401).json({ error: 'Invalid callback secret' });
        return;
      }
    }

    const { leadId: leadRef, amount, discountPct, quoteRef } = req.body as {
      leadId?: string; amount?: number; discountPct?: number; quoteRef?: string;
    };

    if (
      !leadRef ||
      typeof amount !== 'number' ||
      !Number.isFinite(amount) ||
      amount < 0 ||
      typeof quoteRef !== 'string' ||
      !quoteRef.trim()
    ) {
      res.status(400).json({ error: 'leadId, amount, and quoteRef are required' });
      return;
    }
    const normalizedQuoteRef = quoteRef.trim();
    const normalizedDiscountPct =
      typeof discountPct === 'number' && Number.isFinite(discountPct) ? discountPct : 0;

    // leadId can be X#### format or the UUID id
    const lead = await prisma.lead.findFirst({
      where: { OR: [{ leadId: leadRef }, { id: leadRef }] },
    });
    if (!lead) { res.status(404).json({ error: `Lead not found: ${leadRef}` }); return; }
    if (isLeadLocked(lead.status)) { sendLeadLockedError(res); return; }

    const result = await writeQuoteCallback(lead.id, normalizedQuoteRef, amount, normalizedDiscountPct);
    if (result.kind === 'conflict') {
      res.status(409).json({ error: 'Quote reference is already linked to another lead' });
      return;
    }

    if (result.kind === 'created') {
      const systemUserId = await resolveSystemUserId();
      if (systemUserId) {
        await logActivity(systemUserId, 'QUOTE_RECEIVED', lead.id, {
          quoteRef: normalizedQuoteRef, amount, discountPct: normalizedDiscountPct,
        }).catch((e) => console.warn('[quotes:callback:activity]', e.message));
      }
    }

    res.status(result.kind === 'created' ? 201 : 200).json({
      quote: result.quote,
      lead: { id: lead.id, leadId: lead.leadId },
      callbackResult: result.kind,
    });
  } catch (err: any) {
    console.error('[quotes:callback]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/:leadId/quotes — list quotes for a lead ───────────────────
// Scoped like every other lead-scoped resource (task #89): DESIGNER/CRE only
// see quotes for leads assigned to them, BL only their team's, mirroring
// isAuthorizedForLead used by files.ts/leads.ts.
quotesRouter.get('/lead/:leadId', verifyToken, async (req, res) => {
  try {
    const user = req.user!;
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.leadId },
      select: { id: true, assignedDesignerId: true, assignedBLId: true, project: { select: { id: true } } },
    });
    if (!lead) { res.status(404).json({ error: 'Lead not found' }); return; }
    const baseAuthorized = await isAuthorizedForLead(lead, user);
    if (!baseAuthorized) {
      // Post-handover: assignedDesignerId/BLId are cleared, but the designer
      // may be an approved member of the lead's project — allow quote access.
      let projectAuthorized = false;
      if ((user.role === 'DESIGNER' || user.role === 'CRE') && lead.project?.id) {
        const member = await prisma.projectTeamMember.findFirst({
          where: { projectId: lead.project.id, userId: user.id, status: 'APPROVED' },
          select: { id: true },
        });
        projectAuthorized = !!member;
      }
      if (!projectAuthorized) {
        res.status(403).json({ error: 'Not authorised to view quotes for this lead' });
        return;
      }
    }

    const quotes = await prisma.quote.findMany({
      where: { leadId: req.params.leadId },
      include: { files: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' },
    });

    // Hydrate fresh signed URLs for each attachment (never store long-lived
    // URLs — mirrors files.ts/calls.ts).
    const storageClient = supabaseAdmin;
    const quotesWithSignedFiles = await Promise.all(
      quotes.map(async (q) => ({
        ...q,
        files: !storageClient
          ? q.files.map((f) => ({ ...f, signedUrl: undefined }))
          : await Promise.all(
              q.files.map(async (f) => {
                const { data } = await storageClient.storage
                  .from(QUOTE_FILES_BUCKET)
                  .createSignedUrl(f.storagePath, 60 * 60);
                return { ...f, signedUrl: data?.signedUrl };
              }),
            ),
      })),
    );

    res.json({ quotes: quotesWithSignedFiles });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/quotes/:id/files — attach the actual quote document ────────────
// Real file attachment, not a link (task #89): stored in the private
// crm-quote-files bucket, same pattern as LeadFile/CallAttachment.
quotesRouter.post('/:id/files', verifyToken, upload.single('file') as any, async (req, res) => {
  try {
    const user = req.user!;
    const quote = await prisma.quote.findUnique({
      where: { id: req.params.id },
      include: { lead: { select: { id: true, assignedDesignerId: true, assignedBLId: true, status: true } } },
    });
    if (!quote) { res.status(404).json({ error: 'Quote not found' }); return; }
    if (!(await isAuthorizedForLead(quote.lead, user))) {
      res.status(403).json({ error: 'Not authorised to attach files to this quote' });
      return;
    }
    if (isLeadLocked(quote.lead.status)) { sendLeadLockedError(res); return; }

    const file = req.file;
    if (!file) { res.status(400).json({ error: 'No file uploaded' }); return; }

    const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
    if (!ALLOWED_QUOTE_MIMES.has(file.mimetype) || !ALLOWED_QUOTE_EXTS.has(ext)) {
      res.status(400).json({ error: 'Quote attachments must be PDF files' });
      return;
    }
    if (!supabaseAdmin) { res.status(500).json({ error: 'Storage not configured' }); return; }

    await supabaseAdmin.storage.createBucket(QUOTE_FILES_BUCKET, { public: false }).catch(() => {});

    const storagePath = `${quote.leadId}/${quote.id}/${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from(QUOTE_FILES_BUCKET)
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (uploadError) { res.status(500).json({ error: uploadError.message }); return; }

    const record = await prisma.quoteFile.create({
      data: { quoteId: quote.id, fileName: file.originalname, storagePath, uploadedById: user.id },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });

    const { data: signed } = await supabaseAdmin.storage.from(QUOTE_FILES_BUCKET).createSignedUrl(storagePath, 60 * 60);

    await logActivity(user.id, 'QUOTE_FILE_ATTACHED', quote.leadId, {
      quoteId: quote.id, fileId: record.id, fileName: file.originalname,
    }).catch(() => {});

    res.status(201).json({ file: { ...record, signedUrl: signed?.signedUrl } });
  } catch (err: any) {
    console.error('[quotes:files:upload]', err.message);
    res.status(500).json({ error: err.message });
  }
});
