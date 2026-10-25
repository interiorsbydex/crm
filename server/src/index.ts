import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

import express from 'express';
import { autoSendDrafts } from './lib/autoSendDrafts.js';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required. Refusing to start without it.');
}

import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { leadsRouter } from './routes/leads.js';
import { callsRouter } from './routes/calls.js';
import { tasksRouter, myTasksRouter } from './routes/tasks.js';
import { meetingsRouter, meetingStatusRouter } from './routes/meetings.js';
import { notificationsRouter } from './routes/notifications.js';
import { whatsappRouter, leadWhatsAppRouter } from './routes/whatsapp.js';
import { leadChatRouter } from './routes/leadChat.js';
import { emailRouter } from './routes/email.js';
import { slaRouter } from './routes/sla.js';
import { feedbackRouter } from './routes/feedback.js';
import { dashboardRouter } from './routes/dashboard.js';
import { dashboardContentRouter, adminDashboardContentRouter } from './routes/dashboardContent.js';
import { reportsRouter } from './routes/reports.js';
import { designerReportsRouter } from './routes/designerReports.js';
import { blAdminReportsRouter } from './routes/blAdminReports.js';
import { offersRouter, leadOfferRouter } from './routes/offers.js';
import { discountsRouter, leadDiscountRouter } from './routes/discounts.js';
import { leadWebhooksRouter } from './routes/leadWebhooks.js';
import { quotesRouter, usersDiscountRouter } from './routes/quotes.js';
import { importRouter } from './routes/import.js';
import { adminRouter } from './routes/admin.js';
import { callWebhookRouter } from './routes/callWebhook.js';
import { callsStandaloneRouter } from './routes/calls.js';
import { googleFormWebhookRouter, questionnaireRouter } from './routes/questionnaire.js';
import { acceptInviteRouter } from './routes/acceptInvite.js';
import { dipChecklistRouter } from './routes/dipChecklist.js';
import { pdObChecklistRouter } from './routes/pdObChecklist.js';
import { obObmChecklistRouter } from './routes/obObmChecklist.js';
import { calendarRouter } from './routes/calendar.js';
import { scheduleClientTuesdayDigest, clientTuesdayDigestWorker } from './jobs/clientTuesdayDigest.js';
import { projectsRouter } from './routes/projects.js';
import { filesRouter } from './routes/files.js';
import { configRouter } from './routes/config.js';
import { collectionsRouter } from './routes/collections.js';
import { npsRouter } from './routes/nps.js';
import { dataQualityRouter } from './routes/dataQuality.js';
import { clientHealthRouter } from './routes/clientHealth.js';
import { designerTargetsRouter } from './routes/designerTargets.js';
import { incentiveRouter } from './routes/incentive.js';
import { scheduleMidnightJob } from './jobs/midnightOverdueTask.js';
import { scheduleSLACheck } from './jobs/slaCheck.js';
import { scheduleReportJobs } from './jobs/reportScheduler.js';
import { schedulePerformanceRecalc } from './jobs/performanceRecalc.js';
import { scheduleCreditSnapshots } from './jobs/creditSnapshots.js';
import { startTaskReminderLoop } from './services/taskReminders.js';
import { scheduleWeeklyTaskDigest } from './jobs/weeklyTaskDigest.js';
import { scheduleUpcomingDueReminder } from './jobs/upcomingDueReminder.js';
import { scheduleCREDigestJobs, runDailyCreDigest, runMonthlyCreMetrics } from './jobs/creDigest.js';
import './jobs/emailWorker.js';
import './jobs/performanceRecalc.js';
import { startCycleScheduleRefresh } from './lib/crmSettings.js';

const app = express();
const PORT = process.env.PORT ?? 3001;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

// Deployed app runs behind Replit's reverse proxy, which sets X-Forwarded-For.
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// on every request (it can't safely resolve the real client IP), which was
// crashing login and other rate-limited routes with 500s in production.
app.set('trust proxy', 1);

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for iframe support

app.use(cors({
  origin: process.env.CLIENT_URL ?? 'http://localhost:5173',
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again later' },
}) as unknown as express.RequestHandler;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many auth attempts — please wait 15 minutes' },
}) as unknown as express.RequestHandler;

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
}) as unknown as express.RequestHandler;

// ── Raw body for Meta webhook signature verification ──────────────────────────
app.use('/api/leads/webhook', express.raw({ type: 'application/json' }), (req, _res, next) => {
  if (Buffer.isBuffer(req.body)) {
    (req as any).rawBody = req.body;
    req.body = JSON.parse(req.body.toString('utf-8'));
  }
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(generalLimiter);

// Client emails set to "send straight away" in Admin → Automations skip the review screen.
app.use('/api', autoSendDrafts);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api', healthRouter);
app.use('/api/auth', authLimiter, authRouter);


// Webhooks (rate-limited separately)
app.use('/api/leads/webhook', webhookLimiter, leadWebhooksRouter);
app.use('/api/calls/webhook', webhookLimiter, callWebhookRouter);
app.use('/api/integrations/google-form-webhook', webhookLimiter, googleFormWebhookRouter);

// Public invite acceptance (no auth)
app.use('/api/accept-invite', acceptInviteRouter);

// Standalone calls (recording URL)
app.use('/api/calls', callsStandaloneRouter);
app.use('/api/quotes', quotesRouter);
app.use('/api/config', configRouter);

// Leads CRUD
app.use('/api/leads', leadsRouter);

// Lead sub-resources
app.use('/api/leads/:leadId/calls', callsRouter);
app.use('/api/leads/:leadId/tasks', tasksRouter);
app.use('/api/leads/:leadId/meetings', meetingsRouter);
app.use('/api/leads/:leadId/whatsapp', leadWhatsAppRouter);
app.use('/api/leads/:leadId/chat', leadChatRouter);
app.use('/api/leads/:leadId/offer', leadOfferRouter);
app.use('/api/leads/:leadId/discount-request', leadDiscountRouter);
app.use('/api/leads/:leadId/questionnaire', questionnaireRouter);
app.use('/api/leads/:leadId/dip-checklist', dipChecklistRouter);
app.use('/api/leads/:leadId/pd-ob-checklist', pdObChecklistRouter);
app.use('/api/leads/:leadId/ob-obm-checklist', obObmChecklistRouter);
app.use('/api/leads/:leadId/files', filesRouter);

// Bulk import
app.use('/api/leads/import', importRouter);

// Standalone task routes
app.use('/api/tasks', myTasksRouter);

// Meeting status update
app.use('/api/meetings', meetingStatusRouter);

// Notifications
app.use('/api/notifications', notificationsRouter);

// WhatsApp
app.use('/api/whatsapp', whatsappRouter);

// Email preview/draft
app.use('/api/email', emailRouter);


// SLA
app.use('/api/sla', slaRouter);

// Lenient-launch visibility: bypass log + data completeness
app.use('/api/data-quality', dataQualityRouter);
app.use('/api/client-health', clientHealthRouter);

// Dashboard
app.use('/api/dashboard', dashboardRouter);
app.use('/api/dashboard-content', dashboardContentRouter);

// Reports
app.use('/api/designer-reports', designerReportsRouter);
app.use('/api/bl-admin-reports', blAdminReportsRouter);
app.use('/api/reports', reportsRouter);

// Offers
app.use('/api/offers', offersRouter);

// Discount requests
app.use('/api/discount-requests', discountsRouter);

// Users
app.use('/api/users/:id/discount-authority', usersDiscountRouter);

// Admin panel (Branch Head only)
app.use('/api/admin/dashboard-content', adminDashboardContentRouter);
app.use('/api/admin', adminRouter);

// Calendar
app.use('/api/calendar', calendarRouter);

// Projects (delivery)
app.use('/api/projects', projectsRouter);

// Collections (payments) and NPS drill-through lists
app.use('/api/collections', collectionsRouter);
app.use('/api/nps', npsRouter);
app.use('/api/designer-targets', designerTargetsRouter);
app.use('/api/incentive', incentiveRouter);

// Public feedback form (no auth)
app.use('/api/feedback', feedbackRouter);

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[server:error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Safety net: an unhandled rejection in any async route handler must never take
// the whole API down (Express 4 does not catch these itself).
process.on('unhandledRejection', (reason) => {
  console.error('[server:unhandledRejection]', reason instanceof Error ? reason.message : reason);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  // Cycle maths (targets, credits) follow the start day in CRM Settings.
  startCycleScheduleRefresh();
  console.log(`CRM Server running on port ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);

  const redisConfigured =
    process.env.REDIS_URL && !process.env.REDIS_URL.includes('localhost');

  if (redisConfigured) {
    try {
      await scheduleMidnightJob();
      await scheduleSLACheck();
      await scheduleReportJobs();
      await schedulePerformanceRecalc();
      await scheduleCreditSnapshots();
      await scheduleWeeklyTaskDigest();
      await scheduleUpcomingDueReminder();
      await scheduleCREDigestJobs();
      await scheduleClientTuesdayDigest();
    } catch (e) {
      console.warn('[jobs] Could not schedule background jobs:', e);
    }
  } else {
    console.log('[jobs] Skipping background job schedule — Redis not configured');
  }

  // Task due reminders — in-process loop, independent of Redis
  startTaskReminderLoop();
});

export default app;
