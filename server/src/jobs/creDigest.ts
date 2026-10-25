/**
 * CRE Daily Digest + Monthly Metrics
 *
 * Daily   — 08:30 IST (03:00 UTC) every day.
 *            Each active CRE receives a pipeline snapshot: how many leads
 *            are at EL, awaiting BL, assigned to a BL, or currently pushed back.
 *
 * Monthly — 08:05 IST (02:35 UTC) on the 1st of every month.
 *            Each active CRE receives the previous month's metrics:
 *            leads qualified (EL→MQL), pushbacks received, and conversion count.
 */

import { Worker, Queue } from 'bullmq';
import { connection } from './index.js';
import { prisma } from '../lib/prisma.js';
import { sendEmail } from '../lib/email.js';
import { isAutomationOn } from '../lib/automations.js';

// ── Queue ─────────────────────────────────────────────────────────────────────

const QUEUE_NAME = 'cre-digest';
export const creDigestQueue = new Queue(QUEUE_NAME, { connection });

// ── HTML builders ─────────────────────────────────────────────────────────────

interface LeadRow {
  leadId: string;
  name: string;
  stage: string;
  mqlPushbackCount: number;
  assignedBLId: string | null;
  createdAt: Date;
}

function ageInDays(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

function stageLabel(stage: string): string {
  const map: Record<string, string> = {
    EFFECTIVE_LEAD: 'Effective Lead',
    MQL: 'MQL',
    DQL: 'DQL',
    PROPOSAL_PREPARATION: 'Proposal Prep',
    DESIGN_IN_PROGRESS: 'Design in Progress',
  };
  return map[stage] ?? stage;
}

function leadTableRows(leads: LeadRow[]): string {
  if (!leads.length) return '<tr><td colspan="4" style="padding:12px;color:#888;text-align:center;">No leads in this group</td></tr>';
  return leads
    .map((l) => {
      const age = ageInDays(l.createdAt);
      const ageColor = age > 10 ? '#dc2626' : age > 5 ? '#f59e0b' : '#16a34a';
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ede8;">${l.leadId}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ede8;">${l.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ede8;color:${ageColor};font-weight:600;">${age}d</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f0ede8;">${l.mqlPushbackCount > 0 ? `⚠ Pushed back ${l.mqlPushbackCount}×` : '—'}</td>
      </tr>`;
    })
    .join('');
}

function sectionTable(title: string, count: number, leads: LeadRow[], accent: string): string {
  return `
    <div style="margin-bottom:28px;">
      <div style="font-size:14px;font-weight:700;color:${accent};margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px;">
        ${title} <span style="background:${accent};color:#fff;border-radius:9999px;padding:2px 10px;font-size:12px;">${count}</span>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;border:1px solid #e8e2da;">
        <thead>
          <tr style="background:#f9f6f2;">
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600;">ID</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600;">Client</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600;">Age</th>
            <th style="padding:8px 12px;text-align:left;font-size:12px;color:#666;font-weight:600;">Pushback</th>
          </tr>
        </thead>
        <tbody>${leadTableRows(leads)}</tbody>
      </table>
    </div>`;
}

function dailyDigestHtml(opts: {
  creName: string;
  elLeads: LeadRow[];
  mqAwaiting: LeadRow[];
  mqAssigned: LeadRow[];
  pushedBack: LeadRow[];
  dateStr: string;
  baseUrl: string;
}): string {
  const total = opts.elLeads.length + opts.mqAwaiting.length + opts.mqAssigned.length + opts.pushedBack.length;
  const urgent = opts.mqAwaiting.length + opts.pushedBack.length;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f0eb;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:620px;margin:32px auto;background:#f4f0eb;">

    <!-- Header -->
    <div style="background:#c8603a;border-radius:8px 8px 0 0;padding:24px 32px;">
      <div style="font-size:22px;font-weight:700;color:#fff;">CRE Daily Digest</div>
      <div style="font-size:13px;color:#f5d8cc;margin-top:4px;">${opts.dateStr}</div>
    </div>

    <!-- Summary bar -->
    <div style="background:#fff;padding:20px 32px;border-bottom:1px solid #e8e2da;display:flex;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td align="center" style="padding:8px 0;">
            <div style="font-size:28px;font-weight:700;color:#1a1a1a;">${total}</div>
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;">Total Active</div>
          </td>
          <td align="center" style="padding:8px 0;">
            <div style="font-size:28px;font-weight:700;color:#c8603a;">${opts.elLeads.length}</div>
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;">At Eff. Lead</div>
          </td>
          <td align="center" style="padding:8px 0;">
            <div style="font-size:28px;font-weight:700;color:#d97706;">${opts.mqAwaiting.length}</div>
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;">MQL – No BL</div>
          </td>
          <td align="center" style="padding:8px 0;">
            <div style="font-size:28px;font-weight:700;color:#16a34a;">${opts.mqAssigned.length}</div>
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;">MQL – BL On It</div>
          </td>
          <td align="center" style="padding:8px 0;">
            <div style="font-size:28px;font-weight:700;color:#dc2626;">${opts.pushedBack.length}</div>
            <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px;">Pushed Back</div>
          </td>
        </tr>
      </table>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">
      <p style="margin:0 0 20px;font-size:15px;color:#333;">Hi ${opts.creName}, here's your pipeline for today.</p>
      ${urgent > 0 ? `<div style="background:#fff3f0;border-left:3px solid #c8603a;padding:12px 16px;border-radius:0 6px 6px 0;margin-bottom:24px;font-size:13px;color:#7a2a1a;">
        <strong>${urgent} lead${urgent !== 1 ? 's' : ''}</strong> need${urgent === 1 ? 's' : ''} your attention — ${opts.mqAwaiting.length} MQL without a BL${opts.pushedBack.length > 0 ? `, ${opts.pushedBack.length} pushed back` : ''}.
      </div>` : `<div style="background:#f0fdf4;border-left:3px solid #16a34a;padding:12px 16px;border-radius:0 6px 6px 0;margin-bottom:24px;font-size:13px;color:#14532d;">
        All MQL leads have a BL assigned — good shape!
      </div>`}

      ${sectionTable('Effective Lead — Pending Qualification', opts.elLeads.length, opts.elLeads, '#c8603a')}
      ${sectionTable('MQL — Awaiting BL Allocation', opts.mqAwaiting.length, opts.mqAwaiting, '#d97706')}
      ${sectionTable('MQL — BL Assigned', opts.mqAssigned.length, opts.mqAssigned, '#16a34a')}
      ${opts.pushedBack.length > 0 ? sectionTable('Pushed Back — Needs Re-qualification', opts.pushedBack.length, opts.pushedBack, '#dc2626') : ''}

      <div style="text-align:center;margin-top:32px;">
        <a href="${opts.baseUrl}/cre-portal" style="background:#c8603a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:14px;display:inline-block;">Open CRE Portal →</a>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:16px 32px;text-align:center;font-size:11px;color:#999;border-top:1px solid #e8e2da;background:#faf7f4;border-radius:0 0 8px 8px;">
      Interiors by DeX CRM — automated daily digest. You receive this because you are assigned as a CRE.
    </div>
  </div>
</body>
</html>`;
}

function monthlyMetricsHtml(opts: {
  creName: string;
  monthLabel: string;
  qualified: number;
  pushbacks: number;
  converted: number;
  currentEl: number;
  currentMql: number;
  baseUrl: string;
}): string {
  const conversionPct = opts.qualified > 0
    ? Math.round((opts.converted / opts.qualified) * 100) + '%'
    : '—';
  const pushbackRate = opts.qualified > 0
    ? Math.round((opts.pushbacks / opts.qualified) * 100) + '%'
    : '—';

  const metricRow = (label: string, value: string | number, note?: string) => `
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #f0ede8;font-size:14px;color:#444;">${label}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #f0ede8;font-size:18px;font-weight:700;color:#1a1a1a;text-align:right;">${value}</td>
      ${note ? `<td style="padding:12px 16px;border-bottom:1px solid #f0ede8;font-size:12px;color:#888;">${note}</td>` : '<td></td>'}
    </tr>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f0eb;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;background:#f4f0eb;">

    <!-- Header -->
    <div style="background:#1a1a1a;border-radius:8px 8px 0 0;padding:24px 32px;">
      <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Monthly Metrics Report</div>
      <div style="font-size:22px;font-weight:700;color:#fff;">${opts.monthLabel}</div>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">
      <p style="margin:0 0 24px;font-size:15px;color:#333;">Hi ${opts.creName}, here's your lead performance summary for <strong>${opts.monthLabel}</strong>.</p>

      <div style="background:#fff;border-radius:6px;border:1px solid #e8e2da;overflow:hidden;margin-bottom:28px;">
        <div style="background:#f9f6f2;padding:10px 16px;font-size:12px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.5px;">Last Month</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          ${metricRow('Leads qualified (EL → MQL)', opts.qualified, 'leads you moved forward')}
          ${metricRow('BL pushbacks received', opts.pushbacks, pushbackRate + ' pushback rate')}
          ${metricRow('Leads converted to Design', opts.converted, conversionPct + ' conversion rate')}
        </table>
      </div>

      <div style="background:#fff;border-radius:6px;border:1px solid #e8e2da;overflow:hidden;margin-bottom:32px;">
        <div style="background:#f9f6f2;padding:10px 16px;font-size:12px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.5px;">Current Pipeline</div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          ${metricRow('Leads at Effective Lead', opts.currentEl)}
          ${metricRow('Leads at MQL', opts.currentMql)}
        </table>
      </div>

      <div style="text-align:center;">
        <a href="${opts.baseUrl}/cre-portal" style="background:#1a1a1a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:14px;display:inline-block;">Open CRE Portal →</a>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:16px 32px;text-align:center;font-size:11px;color:#999;border-top:1px solid #e8e2da;background:#faf7f4;border-radius:0 0 8px 8px;">
      Interiors by DeX CRM — automated monthly report.
    </div>
  </div>
</body>
</html>`;
}

// ── Core data functions ────────────────────────────────────────────────────────

export async function runDailyCreDigest(overrideEmail?: string): Promise<number> {
  if (!overrideEmail && !(await isAutomationOn('CRE_DIGESTS', 'email'))) return 0;
  const cres = await prisma.user.findMany({
    where: { role: 'CRE', isActive: true },
    select: { id: true, name: true, email: true },
  });

  if (!cres.length) {
    console.log('[cre-digest:daily] No active CRE users found — skipping.');
    return 0;
  }

  const baseUrl = process.env.BASE_URL
    ? process.env.BASE_URL
    : process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/default-crm-client`
    : 'https://interiorsbydex.com/crm';

  const dateStr = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });

  let sent = 0;
  for (const cre of cres) {
    const leads = await prisma.lead.findMany({
      where: {
        assignedCREId: cre.id,
        status: 'ACTIVE',
        stage: { in: ['EFFECTIVE_LEAD', 'MQL'] },
      },
      select: {
        leadId: true,
        name: true,
        stage: true,
        mqlPushbackCount: true,
        assignedBLId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    // Pushed-back leads are EL with at least one prior pushback from BL
    const elLeads: LeadRow[]      = leads.filter(l => l.stage === 'EFFECTIVE_LEAD' && l.mqlPushbackCount === 0);
    const pushedBack: LeadRow[]   = leads.filter(l => l.stage === 'EFFECTIVE_LEAD' && l.mqlPushbackCount > 0);
    const mqAwaiting: LeadRow[]   = leads.filter(l => l.stage === 'MQL' && !l.assignedBLId);
    const mqAssigned: LeadRow[]   = leads.filter(l => l.stage === 'MQL' && !!l.assignedBLId);

    // Skip if truly empty (nothing to report)
    const total = leads.length;
    if (total === 0) {
      console.log(`[cre-digest:daily] ${cre.name} has no active EL/MQL leads — skipping email.`);
      continue;
    }

    const html = dailyDigestHtml({ creName: cre.name, elLeads, mqAwaiting, mqAssigned, pushedBack, dateStr, baseUrl });
    const to = overrideEmail ?? cre.email;
    await sendEmail({ to, subject: `Your CRE Pipeline — ${dateStr}`, html });
    console.log(`[cre-digest:daily] Sent to ${to} (${total} leads across ${cre.name})`);
    sent++;
  }

  return sent;
}

export async function runMonthlyCreMetrics(overrideEmail?: string): Promise<number> {
  if (!overrideEmail && !(await isAutomationOn('CRE_DIGESTS', 'email'))) return 0;
  const cres = await prisma.user.findMany({
    where: { role: 'CRE', isActive: true },
    select: { id: true, name: true, email: true },
  });

  if (!cres.length) {
    console.log('[cre-digest:monthly] No active CRE users found — skipping.');
    return 0;
  }

  const baseUrl = process.env.BASE_URL
    ? process.env.BASE_URL
    : process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/default-crm-client`
    : 'https://interiorsbydex.com/crm';

  // Previous calendar month window (UTC midnight)
  const now = new Date();
  const firstOfThisMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const firstOfLastMonth = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1));

  const monthLabel = firstOfLastMonth.toLocaleString('en-IN', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });

  let sent = 0;
  for (const cre of cres) {
    // Leads assigned to this CRE
    const [creLeads, currentEl, currentMql] = await Promise.all([
      prisma.lead.findMany({
        where: { assignedCREId: cre.id },
        select: { id: true },
      }),
      prisma.lead.count({
        where: { assignedCREId: cre.id, stage: 'EFFECTIVE_LEAD', status: 'ACTIVE' },
      }),
      prisma.lead.count({
        where: { assignedCREId: cre.id, stage: 'MQL', status: 'ACTIVE' },
      }),
    ]);

    const leadIds = creLeads.map(l => l.id);
    if (!leadIds.length) {
      console.log(`[cre-digest:monthly] ${cre.name} has no leads ever — skipping.`);
      continue;
    }

    // Count EL→MQL transitions and pushbacks in the previous month
    const [qualifiedLogs, pushbackLogs, convertedLogs] = await Promise.all([
      // Qualified: STAGE_CHANGED with from=EFFECTIVE_LEAD, to=MQL
      prisma.activityLog.count({
        where: {
          leadId: { in: leadIds },
          action: 'STAGE_CHANGED',
          meta: { path: ['from'], equals: 'EFFECTIVE_LEAD' },
          createdAt: { gte: firstOfLastMonth, lt: firstOfThisMonth },
        },
      }),
      // Pushbacks: MQL_PUSHED_BACK on their leads
      prisma.activityLog.count({
        where: {
          leadId: { in: leadIds },
          action: 'MQL_PUSHED_BACK',
          createdAt: { gte: firstOfLastMonth, lt: firstOfThisMonth },
        },
      }),
      // Converted to DIP (the incentive trigger stage)
      prisma.activityLog.count({
        where: {
          leadId: { in: leadIds },
          action: 'STAGE_CHANGED',
          meta: { path: ['to'], equals: 'DESIGN_IN_PROGRESS' },
          createdAt: { gte: firstOfLastMonth, lt: firstOfThisMonth },
        },
      }),
    ]);

    const html = monthlyMetricsHtml({
      creName: cre.name,
      monthLabel,
      qualified: qualifiedLogs,
      pushbacks: pushbackLogs,
      converted: convertedLogs,
      currentEl,
      currentMql,
      baseUrl,
    });

    const to = overrideEmail ?? cre.email;
    await sendEmail({ to, subject: `Your CRE Monthly Report — ${monthLabel}`, html });
    console.log(`[cre-digest:monthly] Sent to ${to} (${cre.name} — ${monthLabel})`);
    sent++;
  }

  return sent;
}

// ── BullMQ worker + scheduler ─────────────────────────────────────────────────

export const creDigestWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { type } = job.data as { type: 'DAILY' | 'MONTHLY' };
    console.log(`[cre-digest] Running ${type} job…`);
    const sent = type === 'DAILY' ? await runDailyCreDigest() : await runMonthlyCreMetrics();
    console.log(`[cre-digest] ${type} complete — ${sent} email(s) sent.`);
  },
  { connection },
);

export async function scheduleCREDigestJobs() {
  // Daily: 08:30 IST = 03:00 UTC
  await creDigestQueue.add('cre-daily-digest', { type: 'DAILY' }, {
    repeat: { pattern: '0 3 * * *' },
    jobId: 'cre-daily-digest-singleton',
  });
  // Monthly: 1st of month at 08:05 IST = 02:35 UTC
  // (offset from the existing generic monthly report at 02:30 to avoid collision)
  await creDigestQueue.add('cre-monthly-metrics', { type: 'MONTHLY' }, {
    repeat: { pattern: '35 2 1 * *' },
    jobId: 'cre-monthly-metrics-singleton',
  });
  console.log('[jobs] CRE digest jobs registered (daily 08:30 IST, monthly 1st 08:05 IST)');
}
