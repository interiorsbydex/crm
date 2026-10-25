import { Router } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../lib/activityLog.js';

import { isValidEmail, isValidPhone } from '../lib/leadValidation.js';
import { routeAdLead, incrementAssigned } from '../services/assignmentService.js';
import { hasAllMqlMandatoryFields } from '../lib/leadMandatoryFields.js';

export const leadWebhooksRouter = Router();

// projectType/scope/location are intentionally NOT required for webhook-sourced
// leads — ad-form leads (Meta/Google) never collect them upfront; a CRE fills
// them in once they make contact. Phone/email format is still enforced below.

const SYSTEM_USER_ID = process.env.SYSTEM_USER_ID ?? 'system';
const META_APP_SECRET = process.env.META_APP_SECRET ?? '';

// The 'system' placeholder isn't a real user row (no SYSTEM_USER_ID env var is
// configured), so activity logs for webhook-created leads would otherwise fail
// their FK constraint and silently vanish. Fall back to an active Branch Head
// so the assignment is still auditable in the lead's activity timeline.
let cachedSystemUserId: string | null = null;
async function resolveSystemUserId(): Promise<string> {
  if (SYSTEM_USER_ID !== 'system') return SYSTEM_USER_ID;
  if (cachedSystemUserId) return cachedSystemUserId;
  const bh = await prisma.user.findFirst({ where: { role: 'BRANCH_HEAD', isActive: true }, select: { id: true } });
  cachedSystemUserId = bh?.id ?? SYSTEM_USER_ID;
  return cachedSystemUserId;
}
const META_PAGE_ACCESS_TOKEN = process.env.META_PAGE_ACCESS_TOKEN ?? '';
const META_FORM_ID = process.env.META_FORM_ID ?? '';
const GRAPH_API = 'https://graph.facebook.com/v19.0';

// ── Auto-generate X#### lead ID ───────────────────────────────────────────────
async function generateLeadId(): Promise<string> {
  const counter = await prisma.$transaction(async (tx) => {
    return tx.leadCounter.upsert({
      where: { id: 1 },
      create: { id: 1, lastNum: 1 },
      update: { lastNum: { increment: 1 } },
    });
  });
  return `X${String(counter.lastNum).padStart(4, '0')}`;
}

// ── Create lead from parsed data ──────────────────────────────────────────────
async function createLeadFromWebhook(data: {
  name: string; phone: string; email?: string;
  source: string; utmCampaign?: string; utmSource?: string;
  adName?: string;
  /** Optional extra lead columns (agency intake: location, projectType, utmAdSet, notes, customFields). */
  extra?: Record<string, unknown>;
}): Promise<string | null> {
  if (!isValidPhone(data.phone)) {
    console.warn(`[webhook] Rejected lead with invalid phone "${data.phone}" from source ${data.source}`);
    return null;
  }
  if (data.email && !isValidEmail(data.email)) {
    console.warn(`[webhook] Rejected lead with invalid email "${data.email}" from source ${data.source}`);
    return null;
  }

  const existing = await prisma.lead.findFirst({ where: { phone: data.phone } });
  if (existing) return existing.id;

  // Ad-sourced leads go to the next CRE in turn for qualification, or wait
  // unassigned if Admin → Lead Routing & Access says so.
  const cre = await routeAdLead();

  const leadId = await generateLeadId();
  // Webhook-sourced leads never carry projectType/scope/location/
  // possessionTimeline (a CRE fills those in after qualifying the lead), so
  // they must land at EFFECTIVE_LEAD (pre-MQL) rather than skip straight into
  // MQL — same mandatory list as the primary lead-creation form, see
  // leadMandatoryFields.ts. This data shape has no project-detail fields at
  // all, so the check is always false today, but stays correct if a future
  // webhook payload starts supplying them.
  const initialStage = (await hasAllMqlMandatoryFields({})) ? 'MQL' : 'EFFECTIVE_LEAD';
  const lead = await prisma.lead.create({
    data: {
      leadId,
      name: data.name,
      phone: data.phone,
      email: data.email,
      source: data.source,
      adName: data.adName,
      utmCampaign: data.utmCampaign,
      utmSource: data.utmSource,
      ...(data.extra ?? {}),
      stage: initialStage,
      leadOriginDate: new Date(),
      ...(cre && { assignedDesignerId: cre.id }),
      // CRE Stage 1: permanent qualification-owner record — survives post-MQL
      // designer assignment which overwrites assignedDesignerId.
      ...(cre && { assignedCREId: cre.id }),
    },
  });
  if (cre) await incrementAssigned(cre.id);
  await logActivity(await resolveSystemUserId(), 'LEAD_CREATED_VIA_WEBHOOK', lead.id, {
    source: data.source,
    leadId,
    ...(cre && { autoAssignedCREId: cre.id, autoAssignedCREName: cre.name }),
  });
  return lead.id;
}

// ── META LEAD ADS ─────────────────────────────────────────────────────────────

// GET /api/leads/webhook/meta — Meta verification
leadWebhooksRouter.get('/meta', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN ?? 'interiorsbydex_meta_verify';
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[meta:webhook] Verification success');
    res.status(200).send(challenge);
  } else {
    res.status(403).json({ error: 'Verification failed' });
  }
});

// POST /api/leads/webhook/meta — receive lead gen notification
leadWebhooksRouter.post('/meta', async (req, res) => {
  // Verify HMAC-SHA256 signature
  if (META_APP_SECRET) {
    const sig = req.headers['x-hub-signature-256'] as string;
    const payload = (req as any).rawBody ?? JSON.stringify(req.body);
    const expected = `sha256=${crypto.createHmac('sha256', META_APP_SECRET).update(payload).digest('hex')}`;
    try {
      if (!sig || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    } catch {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  }

  res.status(200).json({ status: 'ok' }); // ACK immediately

  // Process asynchronously
  setImmediate(async () => {
    try {
      const body = req.body as any;
      const entries = body?.entry ?? [];
      for (const entry of entries) {
        for (const change of entry?.changes ?? []) {
          if (change.field !== 'leadgen') continue;
          const leadgenId = change.value?.leadgen_id;
          if (!leadgenId) continue;
          if (META_FORM_ID && change.value?.form_id !== META_FORM_ID) continue;

          // Fetch lead data from Graph API
          const apiRes = await fetch(
            `${GRAPH_API}/${leadgenId}?access_token=${META_PAGE_ACCESS_TOKEN}`,
          );
          const leadData = await apiRes.json() as any;

          if (!apiRes.ok) {
            console.error('[meta:webhook] Graph API error:', leadData);
            continue;
          }

          const fieldMap: Record<string, string> = {};
          for (const f of leadData.field_data ?? []) {
            fieldMap[f.name.toLowerCase()] = f.values?.[0] ?? '';
          }

          const name = fieldMap['full_name'] || fieldMap['name'] || 'Unknown';
          const phone = fieldMap['phone_number'] || fieldMap['phone'] || '';
          if (!phone) { console.warn('[meta:webhook] No phone in lead:', leadgenId); continue; }

          await createLeadFromWebhook({
            name, phone,
            email: fieldMap['email'] || undefined,
            source: 'META_ADS',
            adName: change.value?.ad_name,
            utmCampaign: change.value?.campaign_name,
            utmSource: 'meta',
          });
          console.log(`[meta:webhook] Lead created for ${name} (${phone})`);
        }
      }
    } catch (e) {
      console.error('[meta:webhook] Processing error:', e);
    }
  });
});

// ── GOOGLE ADS (Zapier / direct webhook) ─────────────────────────────────────
leadWebhooksRouter.post('/google', async (req, res) => {
  res.status(200).json({ status: 'ok' });

  setImmediate(async () => {
    try {
      const b = req.body as Record<string, string>;
      const name = b.name || b.full_name || 'Unknown';
      const phone = b.phone || b.phone_number || b.mobile || '';

      if (!phone) { console.warn('[google:webhook] No phone provided'); return; }
      if (!isValidPhone(phone)) { console.warn(`[google:webhook] Rejected lead with invalid phone "${phone}"`); return; }
      if (b.email && !isValidEmail(b.email)) { console.warn(`[google:webhook] Rejected lead with invalid email "${b.email}"`); return; }

      const existing = await prisma.lead.findFirst({ where: { phone } });
      if (!existing) {
        // Next CRE in turn, or unassigned (Admin → Lead Routing & Access).
        const cre = await routeAdLead();

        const leadId = await generateLeadId();
        // Same EL-vs-MQL mandatory-field check as createLeadFromWebhook above
        // — this path can supply `location` (city) but never projectType/
        // scope/possessionTimeline, so it still can't qualify straight into
        // MQL. Reuses the shared mandatory list, not a new one.
        const googleLeadLocation = b.city || b.location || undefined;
        const initialStage = (await hasAllMqlMandatoryFields({ location: googleLeadLocation })) ? 'MQL' : 'EFFECTIVE_LEAD';
        const lead = await prisma.lead.create({
          data: {
            leadId,
            name, phone,
            email: b.email || undefined,
            source: 'GOOGLE_ADS',
            utmCampaign: b.utm_campaign || b.campaign_name || undefined,
            utmSource: b.utm_source || 'google',
            utmAdSet: b.utm_adset || undefined,
            location: googleLeadLocation,
            stage: initialStage,
            leadOriginDate: new Date(),
            ...(cre && { assignedDesignerId: cre.id }),
            // CRE Stage 1: permanent qualification-owner record.
            ...(cre && { assignedCREId: cre.id }),
          },
        });
        if (cre) await incrementAssigned(cre.id);
        await logActivity(await resolveSystemUserId(), 'LEAD_CREATED_VIA_WEBHOOK', lead.id, {
          source: 'GOOGLE_ADS',
          leadId,
          ...(cre && { autoAssignedCREId: cre.id, autoAssignedCREName: cre.name }),
        });
        console.log(`[google:webhook] Lead created: ${lead.leadId} for ${name}`);
      } else {
        console.log(`[google:webhook] Duplicate phone ${phone}, skipping`);
      }
    } catch (e) {
      console.error('[google:webhook] Error:', e);
    }
  });
});


// ── AGENCY INTAKE (ad agency's own connector, e.g. Meta/Google form → JSON) ───
// POST /api/leads/webhook/agency
// Authorization: Bearer <AGENCY_LEAD_TOKEN>
// Route-scoped credential: it only ever creates leads here and is rejected
// everywhere else. Fails closed (503) when the secret is not configured.
function agencyTokenOk(header: string | undefined): 'ok' | 'unconfigured' | 'bad' {
  const expected = process.env.AGENCY_LEAD_TOKEN ?? '';
  if (!expected) return 'unconfigured';
  if (!header?.startsWith('Bearer ')) return 'bad';
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'bad';
}

const pick = (b: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = b[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
};

leadWebhooksRouter.post('/agency', async (req, res) => {
  const auth = agencyTokenOk(req.headers.authorization);
  if (auth === 'unconfigured') { res.status(503).json({ error: 'Agency intake is not configured' }); return; }
  if (auth === 'bad') { res.status(401).json({ error: 'Missing or invalid token' }); return; }

  try {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = pick(b, 'name', 'full_name', 'fullName');
    const phone = pick(b, 'phone', 'phone_number', 'phoneNumber', 'mobile');
    const email = pick(b, 'email', 'email_id', 'emailId');
    const city = pick(b, 'city', 'location');
    const propertyType = pick(b, 'propertyType', 'property_type', 'projectType');
    const budget = pick(b, 'budget', 'estimatedBudget', 'estimated_budget');
    const srcRaw = pick(b, 'source').toUpperCase().replace(/[\s-]+/g, '_');
    const source = ['META_ADS', 'GOOGLE_ADS'].includes(srcRaw) ? srcRaw : 'META_ADS';

    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    if (!phone) { res.status(400).json({ error: 'phone is required' }); return; }
    if (!isValidPhone(phone)) { res.status(400).json({ error: 'phone: invalid number' }); return; }
    if (email && !isValidEmail(email)) { res.status(400).json({ error: 'email: invalid format' }); return; }

    // Duplicate by last-10 digits of phone, or by email.
    const last10 = phone.replace(/\D/g, '').slice(-10);
    const dup = await prisma.lead.findFirst({
      where: { OR: [{ phone: { endsWith: last10 } }, ...(email ? [{ email }] : [])] },
      select: { leadId: true },
    });
    if (dup) { res.status(200).json({ status: 'duplicate', leadId: dup.leadId }); return; }

    // "2 BhK" -> "2BHK" to match the CRM's existing free-text convention.
    const projectType = propertyType.replace(/\s+/g, '').toUpperCase() || undefined;
    const extra: Record<string, unknown> = {
      ...(city && { location: city }),
      ...(projectType && { projectType }),
      utmAdSet: pick(b, 'adSet', 'ad_set', 'utmAdSet') || undefined,
      ...(budget && {
        notes: `Budget selected on ad form: ${budget}`,
        customFields: { budgetRange: budget },
      }),
    };

    const id = await createLeadFromWebhook({
      name, phone, email: email || undefined, source,
      utmCampaign: pick(b, 'campaign', 'campaignName', 'utmCampaign') || undefined,
      utmSource: pick(b, 'utmSource') || (source === 'GOOGLE_ADS' ? 'google' : 'meta'),
      adName: pick(b, 'adName', 'ad_name') || undefined,
      extra,
    });
    if (!id) { res.status(400).json({ error: 'Lead rejected by validation' }); return; }
    const created = await prisma.lead.findUnique({ where: { id }, select: { leadId: true, stage: true } });
    res.status(201).json({ status: 'created', leadId: created?.leadId, stage: created?.stage });
  } catch (e: any) {
    console.error('[agency:intake] Error:', e.message);
    res.status(500).json({ error: 'Could not create lead' });
  }
});
