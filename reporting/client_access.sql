-- Read-only login for the client's reporting tool (Power BI etc.).
-- It can read ONLY the rpt_ views (no phone/email/PAN/GST/notes), nothing else.
--
-- BEFORE RUNNING: replace  CHOOSE_A_LONG_PASSWORD  with a long random password
-- (20+ characters). Do not paste that password into chat or any document.
-- Run in: Database -> Production -> My Data -> SQL runner (Enable Editing on).
-- Run the 4 blocks one at a time if the runner crashes on long scripts.

-- 1) the login
CREATE ROLE reporting_reader LOGIN PASSWORD '99Q]O<&TAp9$a/1;6u^n'
  NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 5;

-- 2) safety limits: no long-running queries
ALTER ROLE reporting_reader SET statement_timeout = '60s';
ALTER ROLE reporting_reader SET default_transaction_read_only = on;

-- 3) allow looking at the schema and reading the views only
GRANT USAGE ON SCHEMA public TO reporting_reader;
GRANT SELECT ON rpt_users, rpt_leads, rpt_stage_changes, rpt_meetings, rpt_calls,
                rpt_tasks, rpt_discounts, rpt_nps, rpt_projects TO reporting_reader;

-- 4) make sure no table is readable directly
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM reporting_reader;
GRANT SELECT ON rpt_users, rpt_leads, rpt_stage_changes, rpt_meetings, rpt_calls,
                rpt_tasks, rpt_discounts, rpt_nps, rpt_projects TO reporting_reader;

-- To remove access later:
--   REVOKE ALL ON ALL TABLES IN SCHEMA public FROM reporting_reader;
--   REVOKE USAGE ON SCHEMA public FROM reporting_reader;
--   DROP ROLE reporting_reader;
