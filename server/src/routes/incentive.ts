// Designer credit incentive: calculated credits, admin-editable rules, manual attendance.
// Credit tracking only — no payout. Rules: server/src/lib/incentiveCredits.ts.
import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken, requireRole } from '../middleware/auth.js';
import { logActivity } from '../lib/activityLog.js';
import { CancellationReviewRequired } from '../lib/bookingCancellations.js';
import {
  calculateDesignerCredits, getCycleForDate, loadIncentiveConfig, parseIncentiveConfig, DEFAULT_INCENTIVE_CONFIG,
} from '../lib/incentiveCredits.js';
import { requirePermission } from '../lib/permissions.js';
import {
  calculateBlCredits, loadBlCreditConfig, parseBlCreditConfig, DEFAULT_BL_CREDIT_CONFIG, BL_CONFIG_ID,
  loadBlTargets, saveBlTarget, savePitchApproval,
} from '../lib/blCredits.js';
import { isCycleInPast } from '../lib/targetCycle.js';

export const incentiveRouter = Router();
incentiveRouter.use(verifyToken);

/** Designers the caller may see: self (DESIGNER), own team (BL), all active (BRANCH_HEAD). */
async function permittedDesigners(user: { id: string; role: string }) {
  if (user.role === 'DESIGNER') return prisma.user.findMany({ where: { id: user.id }, select: { id: true, name: true } });
  if (user.role === 'BL') {
    return prisma.user.findMany({ where: { blId: user.id, role: 'DESIGNER', isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }
  if (user.role === 'BRANCH_HEAD') {
    return prisma.user.findMany({ where: { role: 'DESIGNER', isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }
  return null;
}

function cycleFromQuery(value: unknown) {
  if (typeof value === 'string' && value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw Object.assign(new Error('Invalid cycle date'), { status: 400 });
    return getCycleForDate(d);
  }
  return getCycleForDate(new Date());
}

// GET /api/incentive/credits?designerId=&cycle=YYYY-MM-DD (any date inside the wanted cycle)
incentiveRouter.get('/credits', async (req, res) => {
  try {
    const designers = await permittedDesigners(req.user!);
    if (!designers) { res.status(403).json({ error: 'Credits are available to DESIGNER, BL and BRANCH_HEAD only' }); return; }
    const requested = typeof req.query.designerId === 'string' ? req.query.designerId : '';
    if (req.user!.role !== 'DESIGNER' && requested && !designers.some((d) => d.id === requested)) {
      res.status(403).json({ error: 'Designer is outside your permitted scope' }); return;
    }
    const designerId = req.user!.role === 'DESIGNER' ? req.user!.id : requested || designers[0]?.id;
    if (!designerId) { res.json({ designers, result: null }); return; }
    const cycle = cycleFromQuery(req.query.cycle);
    const { config, isDefault } = await loadIncentiveConfig();
    let result;
    try {
      result = await calculateDesignerCredits(designerId, cycle, config);
    } catch (err) {
      if (!(err instanceof CancellationReviewRequired)) throw err;
      res.json({
        designers, result: null,
        review: { status: 'PENDING_REVIEW', reason: err.message, designerId, cycle, leads: err.leads },
      });
      return;
    }
    res.json({ designers, result, rules: { isDefault, config } });
  } catch (err: any) {
    if (err.status) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[incentive:credits]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/incentive/config — BH edits, BL reads (to understand how credits are computed).
incentiveRouter.get('/config', requireRole('BRANCH_HEAD', 'BL', 'DESIGNER'), async (_req, res) => {
  const { config, isDefault, updatedAt } = await loadIncentiveConfig();
  res.json({ config, isDefault, updatedAt, defaults: DEFAULT_INCENTIVE_CONFIG });
});

// PUT /api/incentive/config — BRANCH_HEAD only.
incentiveRouter.put('/config', requireRole('BRANCH_HEAD'), async (req, res) => {
  try {
    const config = parseIncentiveConfig(req.body?.config);
    await prisma.incentiveConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', config: config as any, updatedById: req.user!.id },
      update: { config: config as any, updatedById: req.user!.id },
    });
    await logActivity(req.user!.id, 'INCENTIVE_CONFIG_UPDATED', undefined, { config });
    res.json({ config });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/incentive/attendance — BL (own team) or BRANCH_HEAD record the manual attendance credit.
incentiveRouter.put('/attendance', requirePermission('ATTENDANCE_CREDITS'), async (req, res) => {
  const { designerId, cycle, awarded } = req.body ?? {};
  if (typeof designerId !== 'string' || typeof awarded !== 'boolean') {
    res.status(400).json({ error: 'designerId and awarded (true/false) are required' }); return;
  }
  const designers = await permittedDesigners(req.user!);
  if (!designers?.some((d) => d.id === designerId)) { res.status(403).json({ error: 'Designer is outside your permitted scope' }); return; }
  let cy;
  try { cy = cycleFromQuery(cycle); } catch (e: any) { res.status(400).json({ error: e.message }); return; }
  const row = await prisma.incentiveAttendance.upsert({
    where: { designerId_cycleStart: { designerId, cycleStart: cy.cycleStart } },
    create: { designerId, cycleStart: cy.cycleStart, awarded, enteredById: req.user!.id },
    update: { awarded, enteredById: req.user!.id, enteredAt: new Date() },
  });
  await logActivity(req.user!.id, 'INCENTIVE_ATTENDANCE_SET', undefined, { designerId, cycle: cy.label, awarded });
  res.json({ attendance: row });
});

// ── Business Lead credits (lib/blCredits.ts) ─────────────────────────────────

/** BLs the caller may see: self (BL), all active BLs (BRANCH_HEAD). */
async function permittedBls(user: { id: string; role: string }) {
  if (user.role === 'BL') return prisma.user.findMany({ where: { id: user.id }, select: { id: true, name: true } });
  if (user.role === 'BRANCH_HEAD') {
    return prisma.user.findMany({ where: { role: 'BL', isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }
  return null;
}

// GET /api/incentive/bl-credits?blId=&cycle=YYYY-MM-DD
incentiveRouter.get('/bl-credits', async (req, res) => {
  try {
    const bls = await permittedBls(req.user!);
    if (!bls) { res.status(403).json({ error: 'BL credits are available to BL and BRANCH_HEAD only' }); return; }
    const requested = typeof req.query.blId === 'string' ? req.query.blId : '';
    if (requested && !bls.some((b) => b.id === requested)) { res.status(403).json({ error: 'BL is outside your permitted scope' }); return; }
    const blId = requested || bls[0]?.id;
    if (!blId) { res.json({ bls, result: null }); return; }
    const cycle = cycleFromQuery(req.query.cycle);
    const { config, isDefault } = await loadBlCreditConfig();
    const result = await calculateBlCredits(blId, cycle, config);
    res.json({ bls, result, rules: { isDefault, config } });
  } catch (err: any) {
    if (err.status) { res.status(err.status).json({ error: err.message }); return; }
    console.error('[incentive:bl-credits]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/incentive/bl-config — BH edits, BL reads.
incentiveRouter.get('/bl-config', requireRole('BRANCH_HEAD', 'BL'), async (_req, res) => {
  const { config, isDefault, updatedAt } = await loadBlCreditConfig();
  res.json({ config, isDefault, updatedAt, defaults: DEFAULT_BL_CREDIT_CONFIG });
});

// PUT /api/incentive/bl-config — BRANCH_HEAD only.
incentiveRouter.put('/bl-config', requireRole('BRANCH_HEAD'), async (req, res) => {
  try {
    const config = parseBlCreditConfig(req.body?.config);
    await prisma.incentiveConfig.upsert({
      where: { id: BL_CONFIG_ID },
      create: { id: BL_CONFIG_ID, config: config as any, updatedById: req.user!.id },
      update: { config: config as any, updatedById: req.user!.id },
    });
    await logActivity(req.user!.id, 'BL_CREDIT_CONFIG_UPDATED', undefined, { config });
    res.json({ config });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/incentive/bl-targets?cycle= — BRANCH_HEAD list of every active BL's booking target.
incentiveRouter.get('/bl-targets', requireRole('BRANCH_HEAD'), async (req, res) => {
  try {
    const cycle = cycleFromQuery(req.query.cycle);
    const [bls, targets] = await Promise.all([permittedBls(req.user!), loadBlTargets(cycle.cycleStart)]);
    res.json({
      cycle: { cycleStart: cycle.cycleStart, cycleEnd: cycle.cycleEnd, label: cycle.label },
      locked: isCycleInPast(cycle.cycleStart),
      bls: (bls ?? []).map((b) => ({ blId: b.id, name: b.name, bookingTargetValue: targets.get(b.id)?.value ?? null })),
    });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /api/incentive/bl-targets — BRANCH_HEAD sets one BL's booking target. Past cycles are locked, as for designers.
incentiveRouter.post('/bl-targets', requireRole('BRANCH_HEAD'), async (req, res) => {
  try {
    const { blId, bookingTargetValue } = req.body ?? {};
    const value = Number(bookingTargetValue);
    if (typeof blId !== 'string' || !blId) { res.status(400).json({ error: 'blId is required' }); return; }
    if (bookingTargetValue == null || bookingTargetValue === '' || !Number.isFinite(value) || value < 0) {
      res.status(400).json({ error: 'Booking target must be a number, 0 or more' }); return;
    }
    const bl = await prisma.user.findUnique({ where: { id: blId }, select: { role: true } });
    if (!bl || bl.role !== 'BL') { res.status(404).json({ error: 'Business Lead not found' }); return; }
    const cycle = cycleFromQuery(req.body?.cycle);
    if (isCycleInPast(cycle.cycleStart)) {
      res.status(403).json({ error: `The cycle ${cycle.label} has already passed and its target is locked from changes.` }); return;
    }
    const { updated } = await saveBlTarget(blId, cycle, value, req.user!.id);
    await logActivity(req.user!.id, updated ? 'BL_TARGET_UPDATED' : 'BL_TARGET_SET', undefined, { blId, cycle: cycle.label, bookingTargetValue: value });
    res.json({ blId, cycle: cycle.label, bookingTargetValue: value });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// PUT /api/incentive/bl-pitch-approval — BRANCH_HEAD approves (or withdraws) a BL's pitch booster for a cycle.
incentiveRouter.put('/bl-pitch-approval', requireRole('BRANCH_HEAD'), async (req, res) => {
  try {
    const { blId, approved } = req.body ?? {};
    if (typeof blId !== 'string' || typeof approved !== 'boolean') {
      res.status(400).json({ error: 'blId and approved (true/false) are required' }); return;
    }
    const bl = await prisma.user.findUnique({ where: { id: blId }, select: { role: true } });
    if (!bl || bl.role !== 'BL') { res.status(404).json({ error: 'Business Lead not found' }); return; }
    const cycle = cycleFromQuery(req.body?.cycle);
    const approval = await savePitchApproval(blId, cycle, approved, req.user!.id);
    await logActivity(req.user!.id, 'BL_PITCH_BOOSTER_APPROVAL', undefined, { blId, cycle: cycle.label, approved });
    res.json({ approval });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});
