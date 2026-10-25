import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { selectCREForLead } from '../services/assignmentService.js';
import { resolveImportOwnership } from '../lib/importOwnership.js';

import { isValidEmail, isValidPhone } from '../lib/leadValidation.js';
import { requirePermission } from '../lib/permissions.js';

export const importRouter = Router();

// projectType/location are collected on a best-effort basis from the sheet and
// stay optional here (unlike the authenticated create form) — bulk-imported
// leads are typically enriched by a CRE after the fact.

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|csv)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('Only .xlsx and .csv files are accepted'));
  },
});

// ── Column name normaliser ─────────────────────────────────────────────────────
// Strips whitespace/case/punctuation so header variants like "Mail id ",
// "Contact number", "Project Type " all normalise to a stable key.
function normalise(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Maps normalised header -> internal field name. Includes both the generic
// template headers (leadid/name/phone/...) and the real headers used in the
// team's existing PID export (pid/leadname/contactnumber/mailid/...).
const COLUMN_MAP: Record<string, string> = {
  leadid: 'leadId', pid: 'leadId',
  name: 'name', leadname: 'name',
  phone: 'phone', contactnumber: 'phone',
  phone2: 'phone2', alternatephone: 'phone2',
  email: 'email', mailid: 'email',
  email2: 'email2', alternateemail: 'email2',
  source: 'source', leadsource: 'source',
  stage: 'stage', leadstage: 'stage',
  designername: 'designerName', blname: 'blName',
  crename: 'creName',
  owner: 'ownerName', ownername: 'ownerName', leadowner: 'ownerName',
  projecttype: 'projectType', projecttype1: 'projectType2',
  scope: 'scope', scopeofwork: 'scope',
  location: 'location',
  offercommitted: 'offer1', offer1: 'offer1', offer2: 'offer2', offer3: 'offer3',
  possessiontimeline: 'possessionTimeline',
  estimatedvalue: 'estimatedValue',
  builder: 'builder',
  expectedmoveinddmmyyyy: 'expectedMoveIn', expectedmovein: 'expectedMoveIn',
  expectedinteriorhandoverdateddmmyyyy: 'expectedMoveIn', expectedinteriorhandoverdate: 'expectedMoveIn',
  pan: 'pan', gst: 'gst', notes: 'notes',
  createdat: 'createdAt',
  leadorigindate: 'leadOriginDate', leadorigindateddmmyyyy: 'leadOriginDate',
};

// Task #88: ON_HOLD/INACTIVE are no longer stage values — status is tracked
// separately on `status`. EFFECTIVE_LEAD is kept as a legacy/off-funnel stage
// value (see LeadStage enum comment) so historical rows still decode; it is
// a valid target for imported rows that were genuinely at that stage.
const VALID_STAGES = [
  'EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY',
  'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING',
  'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
];

// Real export values are prefixed "1- Effective Lead", "2- MQL", "3- DQL" —
// strip any leading "<digit>- " before matching against VALID_STAGES.
function normaliseStageValue(raw: string): string {
  return raw.replace(/^\s*\d+\s*[-.]\s*/, '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

// Stage labels used in the team's sheet ("6- Onboarded", "7- DIP", "Proposal
// Ready"...) that differ from the enum names once normalised.
const STAGE_ALIASES: Record<string, string> = {
  ONBOARDED: 'ONBOARDING',
  DIP: 'DESIGN_IN_PROGRESS',
  DESIGN_IN_PROGRESS: 'DESIGN_IN_PROGRESS',
};

// "Expected Interior Handover Date (DD-MM-YYYY)" — parse that exact format; anything else
// (blank, unparseable) is left unset rather than guessed at.
function parseDDMMYYYY(raw: string | undefined): Date | undefined {
  if (!raw?.trim()) return undefined;
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(raw.trim());
  if (!m) return undefined;
  const [, d, mo, y] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  return isNaN(date.getTime()) ? undefined : date;
}

// Lead-source aliases seen in the team's real export that don't match
// SOURCE_OPTIONS (client/src/lib/leadSources.ts) verbatim.
const SOURCE_ALIASES: Record<string, string> = {
  'expo walkin lead': 'WALK_IN',
  'expo lead': 'WALK_IN',
  'walk in': 'WALK_IN',
  'walkin': 'WALK_IN',
  'cold call': 'OTHER',
  'refferal': 'REFERRAL',
  'referral': 'REFERRAL',
  'instagram': 'ORGANIC',
  'meta': 'META_ADS',
  'facebook': 'META_ADS',
  'google': 'GOOGLE_ADS',
};

function normaliseSource(raw: string): string {
  const key = raw.trim().toLowerCase();
  return SOURCE_ALIASES[key] || raw.trim();
}

// Some cells pack multiple phone numbers separated by "/" — take the first.
// Some cells prefix the number with a label like "p:" or "m:" (seen in the
// real export, e.g. "p:+919500061781") — strip any leading "<letters>:" tag.
function firstPhone(raw: string): string {
  return raw.split('/')[0].trim().replace(/^[a-zA-Z]+\s*:\s*/, '').trim();
}

// Phones in the source data are formatted inconsistently ("+919994180029",
// "p:+919994180029", "099941 80029", "9994180029") — canonicalise to the
// last 10 digits for duplicate comparisons, matching the convention already
// used for inbound WhatsApp matching (see routes/whatsapp.ts).
function canonicalPhone(phone: string): string {
  return phone.replace(/\D/g, '').slice(-10);
}

const VALID_STATUSES = ['ACTIVE', 'INACTIVE', 'ON_HOLD'];

// ── RFC4180-ish CSV parser ──────────────────────────────────────────────────
// Handles quoted fields containing commas, embedded newlines, and doubled
// quotes ("") for an escaped quote — the naive split(',')/split('\n') parser
// this replaced silently corrupted every row after a multi-line quoted
// Location cell (a real, frequent case in the team's exports).
function parseCsvTable(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i++; continue;
    }
    field += c; i++;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

async function parseRows(file: Express.Multer.File): Promise<Record<string, string>[]> {
  if (file.originalname.endsWith('.csv')) {
    const text = file.buffer.toString('utf-8');
    const table = parseCsvTable(text);
    if (table.length < 2) return [];
    const headers = table[0].map((h) => h.trim());
    return table.slice(1).map((vals) => {
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = (vals[i] ?? '').trim(); });
      return row;
    });
  } else {
    const workbook = new ExcelJS.Workbook();
    const workbookData = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    ) as ArrayBuffer;
    await workbook.xlsx.load(workbookData);
    const ws = workbook.worksheets[0];
    const headers: string[] = [];
    const rows: Record<string, string>[] = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) {
        row.eachCell((cell) => headers.push(String(cell.value ?? '')));
        return;
      }
      const r: Record<string, string> = {};
      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        const v = cell.value;
        if (v instanceof Date && !isNaN(v.getTime())) {
          // Real Excel date cells: hand them on as DD-MM-YYYY (the format the
          // rest of the importer parses) instead of JS Date.toString() text,
          // which would be ignored and silently replaced by the import date.
          const dd = String(v.getUTCDate()).padStart(2, '0');
          const mm = String(v.getUTCMonth() + 1).padStart(2, '0');
          r[headers[colNum - 1]] = `${dd}-${mm}-${v.getUTCFullYear()}`;
        } else {
          r[headers[colNum - 1]] = String(v ?? '').trim();
        }
      });
      rows.push(r);
    });
    return rows;
  }
}

// ── GET /api/leads/import/template — downloadable CSV matching the real headers ─
importRouter.get('/template', verifyToken, requirePermission('LEAD_IMPORT'), (_req, res) => {
  const headers = [
    'PID', 'Lead Name', 'Contact number', 'Alternate Phone', 'Mail id', 'Alternate Email',
    'Lead Stage', 'Lead Source', 'Project Type', 'Project Type 1', 'Scope', 'Location',
    'Offer Committed', 'Possession Timeline', 'Estimated Value', 'Builder',
    'Expected Interior Handover Date (DD-MM-YYYY)', 'Lead Origin Date (DD-MM-YYYY)',
    'Designer Name', 'BL Name', 'CRE Name',
  ];
  const example = [
    'X2001', 'Jane Doe', '9876543210', '', 'jane@example.com', '',
    '2- MQL', 'Referral', 'Apartment', '3BHK', 'FHD', 'Example Layout, Chennai',
    '', '3-6 months', '1500000', 'Example Builders', '', '',
    '', '', '',
  ];
  const csv = [headers, example].map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="lead-import-template.csv"');
  res.send(csv);
});

// ── POST /api/leads/import ────────────────────────────────────────────────────
// `status` (ACTIVE | INACTIVE | ON_HOLD) is a required form field, not a
// column — the team's real exports are one file per status bucket rather
// than a status column per row.
importRouter.post('/', verifyToken, requirePermission('LEAD_IMPORT'), upload.single('file') as any, async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    const dryRun = req.query.dryRun === 'true';
    const status = String(req.body.status || 'ACTIVE').toUpperCase();
    if (!VALID_STATUSES.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
      return;
    }

    const rawRows = await parseRows(req.file);

    // Normalise header keys
    const rows = rawRows.map((row) => {
      const norm: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) {
        const mapped = COLUMN_MAP[normalise(k)];
        if (mapped) norm[mapped] = v;
      }
      return norm;
    });

    // Pre-load existing phones + emails + leadIds + designers + BLs.
    // Duplicate matching against the DB is done on canonicalised (last-10-digit)
    // phone since existing leads may be stored with/without a country code.
    const emails = rows.map((r) => r.email).filter(Boolean);
    const leadIds = rows.map((r) => r.leadId).filter(Boolean);
    const canonicalPhones = rows.map((r) => (r.phone ? canonicalPhone(firstPhone(r.phone)) : '')).filter(Boolean);
    const [existingLeads, existingLeadIds, staff] = await Promise.all([
      prisma.lead.findMany({
        where: {
          OR: [
            ...canonicalPhones.map((p) => ({ phone: { endsWith: p } })),
            { email: { in: emails } },
          ],
        },
        select: { phone: true, email: true, leadId: true },
      }),
      prisma.lead.findMany({ where: { leadId: { in: leadIds } }, select: { leadId: true } }),
      prisma.user.findMany({ where: { role: { in: ['DESIGNER', 'CRE', 'BL'] } }, select: { id: true, name: true, role: true } }),
    ]);
    const existingPhoneSet = new Set(existingLeads.map((l) => canonicalPhone(l.phone)));
    const existingEmailSet = new Set(existingLeads.map((l) => l.email).filter((e): e is string => !!e));
    const existingLeadIdSet = new Set(existingLeadIds.map((l) => l.leadId));

    // Get last counter value — advanced past both freshly-generated IDs and
    // any preserved PID that happens to be higher (X#### format).
    const counterRow = await prisma.leadCounter.findUnique({ where: { id: 1 } });
    let nextNum = (counterRow?.lastNum ?? 0) + 1;
    const bumpCounterPast = (leadId: string) => {
      const m = /^X(\d+)$/i.exec(leadId);
      if (m) nextNum = Math.max(nextNum, parseInt(m[1], 10) + 1);
    };

    const preview: any[] = [];
    const errors: string[] = [];
    let importedCount = 0;
    let skippedCount = 0;
    const assignmentCounts = { preserved: 0, allocated: 0, manualReview: 0 };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNum = i + 2;
      const rawPhone = r.phone ? firstPhone(r.phone) : '';

      if (!r.name?.trim() || !rawPhone) {
        errors.push(`Row ${rowNum}: name and phone are required`);
        skippedCount++;
        preview.push({ row: rowNum, status: 'INVALID', phone: rawPhone || null, name: r.name || null, reason: 'name and phone are required' });
        continue;
      }

      if (!isValidPhone(rawPhone)) {
        errors.push(`Row ${rowNum}: phone "${rawPhone}" is not a valid phone number`);
        skippedCount++;
        preview.push({ row: rowNum, status: 'INVALID', phone: rawPhone, name: r.name, reason: 'invalid phone' });
        continue;
      }
      if (r.email && !isValidEmail(r.email)) {
        errors.push(`Row ${rowNum}: email "${r.email}" is not a valid email address`);
        skippedCount++;
        preview.push({ row: rowNum, status: 'INVALID', phone: rawPhone, name: r.name, reason: 'invalid email' });
        continue;
      }
      if (r.leadId && existingLeadIdSet.has(r.leadId)) {
        skippedCount++;
        preview.push({ row: rowNum, status: 'DUPLICATE', phone: rawPhone, name: r.name, reason: `PID ${r.leadId} already exists` });
        continue;
      }

      const phoneKey = canonicalPhone(rawPhone);
      if (existingPhoneSet.has(phoneKey) || (r.email && existingEmailSet.has(r.email))) {
        skippedCount++;
        preview.push({ row: rowNum, status: 'DUPLICATE', phone: rawPhone, name: r.name, reason: 'phone or email already in CRM' });
        continue;
      }

      // A stage we cannot map is rejected, never guessed: silently defaulting to
      // MQL would put a lead at the wrong stage in the funnel.
      const rawNormalisedStage = r.stage ? normaliseStageValue(r.stage) : '';
      const normalisedStage = STAGE_ALIASES[rawNormalisedStage] ?? rawNormalisedStage;
      if (r.stage && !VALID_STAGES.includes(normalisedStage)) {
        errors.push(`Row ${rowNum}: stage "${r.stage}" not recognised — row skipped (no stage guessed)`);
        skippedCount++;
        preview.push({ row: rowNum, status: 'INVALID', phone: rawPhone, name: r.name, reason: `stage "${r.stage}" not recognised` });
        continue;
      }
      const stage = VALID_STAGES.includes(normalisedStage) ? normalisedStage : 'MQL';

      // Guard against duplicates within the same file (same phone/email/PID twice).
      existingPhoneSet.add(phoneKey);
      if (r.email) existingEmailSet.add(r.email);
      if (r.leadId) existingLeadIdSet.add(r.leadId);

      const providedOwners = {
        designerName: r.designerName, blName: r.blName, creName: r.creName, ownerName: r.ownerName,
      };
      const ownership = resolveImportOwnership(providedOwners, staff, stage, status);
      // A dry-run must not make an assignment or promise the same candidate for
      // every row. Current round-robin availability is checked on confirmation.
      const cre = !dryRun && ownership.allocationEligible ? await selectCREForLead() : null;
      const assignedDesignerId = ownership.assignedDesignerId ?? cre?.id;
      const assignedCREId = ownership.assignedCREId ?? cre?.id;
      const assignmentOutcome = cre ? 'AUTO_ALLOCATED'
        : ownership.allocationEligible && !dryRun ? 'MANUAL_REVIEW' : ownership.outcome;
      const assignmentReason = cre ? `Auto-allocated to CRE ${cre.name} using configured allocation.`
        : ownership.allocationEligible && !dryRun
          ? 'Unassigned — no active CRE available. Manual ownership review required.'
          : ownership.reason;

      // Preserve the source PID as leadId when present and not already used;
      // otherwise mint the next X#### number.
      let leadId: string;
      if (r.leadId && /^X\d+$/i.test(r.leadId)) {
        leadId = r.leadId.toUpperCase();
        bumpCounterPast(leadId);
      } else {
        leadId = `X${String(nextNum).padStart(4, '0')}`;
        nextNum++;
      }

      // Combine "Project Type" + "Project Type 1" (e.g. Apartment/Independent
      // House + 2BHK/3BHK) — the Lead model has one free-text projectType field.
      const projectType = [r.projectType, r.projectType2]
        .filter((v) => v && v.trim() && v.trim().toLowerCase() !== 'not disclosed')
        .join(' - ') || undefined;

      const source = r.source ? normaliseSource(r.source) : undefined;
      const estimatedValue = r.estimatedValue && !isNaN(parseFloat(r.estimatedValue)) ? parseFloat(r.estimatedValue) : undefined;
      const expectedMoveIn = parseDDMMYYYY(r.expectedMoveIn);
      // Explicit historical date wins (for backfilling old leads); a blank
      // column means "no historical date given" and defaults to import time,
      // same as any other new lead — no fallback to createdAt.
      const leadOriginDate = parseDDMMYYYY(r.leadOriginDate) ?? new Date();

      const previewRow = {
        row: rowNum, status: 'WILL_IMPORT',
        name: r.name, phone: rawPhone, email: r.email || null,
        source: source || null, stage, leadStatus: status, leadId,
        designerId: assignedDesignerId || null, blId: ownership.assignedBLId || null,
        creId: assignedCREId || null, creName: cre?.name ?? r.creName ?? null,
        assignmentOutcome, reason: assignmentReason,
        estimatedValue: estimatedValue ?? null,
        leadOriginDate: leadOriginDate.toISOString().slice(0, 10),
      };
      preview.push(previewRow);

      if (!dryRun) {
        try {
          await prisma.$transaction(async (tx) => {
          const lead = await tx.lead.create({
            data: {
              leadId,
              name: r.name.trim(), phone: rawPhone,
              phone2: r.phone2 || undefined,
              email: r.email || undefined,
              email2: r.email2 || undefined,
              source,
              stage: stage as any,
              status: status as any,
              projectType,
              scope: r.scope || undefined,
              location: r.location || undefined,
              possessionTimeline: r.possessionTimeline || undefined,
              estimatedValue,
              builder: r.builder || undefined,
              offer1: r.offer1 || undefined,
              offer2: r.offer2 || undefined,
              offer3: r.offer3 || undefined,
              expectedMoveIn,
              pan: r.pan || undefined,
              gst: r.gst || undefined,
              notes: r.notes || undefined,
              assignedDesignerId,
              assignedCREId,
              assignedBLId: ownership.assignedBLId,
              createdById: req.user!.id,
              createdAt: r.createdAt ? new Date(r.createdAt) : undefined,
              leadOriginDate,
            },
          });
          // Do not count preserved historical assignments as new allocations.
          // Creation, allocation counter and audit must succeed together.
          if (cre) await tx.user.update({
            where: { id: cre.id }, data: { totalLeadsAssigned: { increment: 1 } },
          });
          await tx.activityLog.create({
            data: {
              userId: req.user!.id, action: 'LEAD_IMPORTED', leadId: lead.id,
              meta: {
                assignmentOutcome, reason: assignmentReason, providedOwners,
                assignedDesignerId: assignedDesignerId ?? null,
                assignedBLId: ownership.assignedBLId ?? null,
                assignedCREId: assignedCREId ?? null,
                // This is evidence of the import, not a fabricated historical
                // assignment event or verified historical effective date.
                historicalAssignmentDateVerified: false,
              },
            },
          });
          });
          importedCount++;
          if (assignmentOutcome === 'PRESERVED') assignmentCounts.preserved++;
          else if (assignmentOutcome === 'AUTO_ALLOCATED') assignmentCounts.allocated++;
          else assignmentCounts.manualReview++;
        } catch (e: any) {
          previewRow.status = 'INVALID';
          previewRow.reason = `Import failed; no row assignment was saved: ${e.message}`;
          errors.push(`Row ${rowNum} (${leadId}): ${e.message}`);
          skippedCount++;
        }
      }
    }

    if (!dryRun && importedCount > 0) {
      await prisma.leadCounter.upsert({
        where: { id: 1 },
        create: { id: 1, lastNum: nextNum - 1 },
        update: { lastNum: nextNum - 1 },
      });
      await logActivity(req.user!.id, 'BULK_IMPORT', undefined, {
        imported: importedCount, skipped: skippedCount, status, assignmentCounts,
      }).catch(() => { errors.push('Import saved with per-lead audits, but the bulk summary audit could not be saved.'); });
    }

    res.json({
      dryRun,
      status,
      total: rows.length,
      imported: dryRun ? 0 : importedCount,
      skipped: skippedCount,
      errors,
      assignmentCounts,
      preview,
    });
  } catch (err: any) {
    console.error('[import]', err.message);
    res.status(500).json({ error: err.message });
  }
});
