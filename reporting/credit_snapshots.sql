-- Saved designer credits for Power BI. Run in prod: Database -> Production -> SQL runner.
-- Run block 1, then block 2, then block 3 (one at a time if the runner is slow).

-- 1) table
CREATE TABLE IF NOT EXISTS designer_credit_snapshots (
  id text PRIMARY KEY,
  "designerId" text NOT NULL,
  "cycleStart" timestamp(3) NOT NULL,
  "cycleEnd" timestamp(3) NOT NULL,
  "cycleLabel" text NOT NULL,
  "bookingTargetValue" numeric(14,2),
  "bookingValue" numeric(14,2) NOT NULL,
  "bookingCount" integer NOT NULL,
  "coreStandardCredits" numeric(10,2) NOT NULL,
  "coreOverachievementCredits" numeric(10,2) NOT NULL,
  "coreCredits" numeric(10,2) NOT NULL,
  "boosterCredits" numeric(10,2) NOT NULL,
  "totalCredits" numeric(10,2) NOT NULL,
  "eligibilityBand" text NOT NULL,
  "computedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS designer_credit_snapshots_designer_cycle
  ON designer_credit_snapshots ("designerId", "cycleStart");

-- 2) reporting view (no personal data)
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

-- 3) let the reporting login read it
GRANT SELECT ON rpt_credits TO reporting_reader;
