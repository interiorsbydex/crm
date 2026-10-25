-- Add per-designer, per-cycle inputs for the three-part Sales Performance Score.
-- Nullable values preserve existing historical target rows until an admin fills
-- in the new targets for an active cycle.
ALTER TABLE "designer_targets"
  ADD COLUMN IF NOT EXISTS "conversionTargetPct" DECIMAL(5, 2),
  ADD COLUMN IF NOT EXISTS "averageBookingValueTarget" DECIMAL(12, 2);