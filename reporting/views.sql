-- Read-only reporting views for Power BI / external reporting.
-- No phone, email, PAN, GST or free-text notes are exposed.
-- Test/demo leads are included but flagged (is_test_lead) so the report decides.
-- Safe to re-run (CREATE OR REPLACE). Run in the Database pane.

CREATE OR REPLACE VIEW rpt_users AS
SELECT u.id AS user_id, u.name, u.role::text AS role, u.designation::text AS designation,
       u."blId" AS bl_user_id, u."isActive" AS is_active, u."createdAt" AS created_at
FROM users u;

CREATE OR REPLACE VIEW rpt_leads AS
SELECT l.id AS lead_pk, l."leadId" AS lead_code, l.stage::text AS stage, l.status::text AS status,
       l.source, l."utmCampaign" AS utm_campaign, l."projectType" AS project_type,
       l.location, l."estimatedValue" AS estimated_value, l."intentRating" AS intent_rating,
       l."assignedCREId" AS cre_user_id, l."assignedBLId" AS bl_user_id,
       l."assignedDesignerId" AS designer_user_id,
       l."inactiveReason" AS inactive_reason, l."isDuplicate" AS is_duplicate,
       l."isTestLead" AS is_test_lead, l."isSLABreached" AS is_sla_breached,
       l."expectedObDate" AS expected_ob_date, l."leadOriginDate" AS lead_origin_date,
       l."createdAt" AS created_at, l."updatedAt" AS updated_at
FROM leads l;

CREATE OR REPLACE VIEW rpt_stage_changes AS
SELECT a.id AS event_id, a."leadId" AS lead_pk, a."userId" AS changed_by_user_id,
       a.meta->>'from' AS from_stage, a.meta->>'to' AS to_stage,
       COALESCE((a.meta->>'isBackward')::boolean, false) AS is_backward,
       a."createdAt" AS changed_at
FROM activity_logs a
WHERE a.action = 'STAGE_CHANGED';

CREATE OR REPLACE VIEW rpt_meetings AS
SELECT m.id AS meeting_id, m."leadId" AS lead_pk, m.type::text AS meeting_type,
       m."ppNumber" AS pp_number, m.mode::text AS mode, m.status::text AS status,
       m."scheduledAt" AS scheduled_at, m."noShowReason" AS no_show_reason,
       m."confirmationSent" AS confirmation_sent, m."momSent" AS mom_sent,
       m."createdAt" AS created_at
FROM meetings m;

CREATE OR REPLACE VIEW rpt_calls AS
SELECT c.id AS call_id, c."leadId" AS lead_pk, c."loggedById" AS logged_by_user_id,
       c.outcome::text AS outcome, c.duration AS duration_seconds,
       COALESCE(c."calledAt", c."createdAt") AS called_at
FROM calls c;

CREATE OR REPLACE VIEW rpt_tasks AS
SELECT t.id AS task_id, t."leadId" AS lead_pk, t."assignedToId" AS assigned_to_user_id,
       t."taskType"::text AS task_type, t.status::text AS status, t."dueDate" AS due_date,
       t."isCompleted" AS is_completed, t."isOverdue" AS is_overdue,
       t."completedAt" AS completed_at, t."createdAt" AS created_at
FROM follow_up_tasks t;

CREATE OR REPLACE VIEW rpt_discounts AS
SELECT d.id AS discount_id, d."leadId" AS lead_pk, d."requestedById" AS requested_by_user_id,
       d."originalAmount" AS original_amount, d.amount AS discounted_amount,
       d."discountPct" AS discount_pct, d.status::text AS status,
       d."reviewedById" AS reviewed_by_user_id, d."approverRole"::text AS approver_role,
       d."isSpecialCase" AS is_special_case, d."createdAt" AS requested_at, d."reviewedAt" AS reviewed_at
FROM discount_requests d;

CREATE OR REPLACE VIEW rpt_nps AS
SELECT n.id AS nps_id, n."leadId" AS lead_pk, n."projectId" AS project_pk,
       n.stage::text AS survey_stage, n.score, n."sentAt" AS sent_at, n."respondedAt" AS responded_at
FROM nps_responses n;

CREATE OR REPLACE VIEW rpt_projects AS
SELECT p.id AS project_pk, p."projectCode" AS project_code, p."leadId" AS lead_pk,
       p."designerId" AS designer_user_id, p.phase::text AS phase, p.health::text AS health,
       p."progressPercent" AS progress_percent, p."contractValue" AS contract_value,
       p."outstandingAmount" AS outstanding_amount, p."handoverTargetDate" AS handover_target_date,
       p."createdAt" AS created_at
FROM projects p;

-- Saved designer credits (table created by reporting/credit_snapshots.sql)
CREATE OR REPLACE VIEW rpt_credits AS
SELECT s."designerId" AS designer_user_id, s."cycleLabel" AS cycle_label,
       s."cycleStart" AS cycle_start, s."cycleEnd" AS cycle_end,
       s."bookingTargetValue" AS booking_target_value, s."bookingValue" AS booking_value,
       s."bookingCount" AS booking_count, s."coreStandardCredits" AS core_standard_credits,
       s."coreOverachievementCredits" AS core_overachievement_credits,
       s."coreCredits" AS core_credits, s."boosterCredits" AS booster_credits,
       s."totalCredits" AS total_credits, s."eligibilityBand" AS eligibility_band,
       s."computedAt" AS computed_at
FROM designer_credit_snapshots s;
