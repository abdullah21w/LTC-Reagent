-- Rollback of ADD_ATOMIC_LOG_USE.sql. Removes the function only.
--
-- Data: nothing is undone or changed. Logs and deductions already recorded
-- through log_use are ordinary consumption_logs rows and reagents quantities
-- (date_provenance 'manual'), exactly what the previous app wrote; they stay.
--
-- Order: FIRST roll the app back to a version that does not call log_use
-- (otherwise Log use shows "not saved" errors until it is), THEN run this.
drop function if exists log_use(uuid, uuid, numeric, date, text, text, boolean, boolean, boolean, uuid, text);
