-- Rollback of ADD_ATOMIC_LOG_EDIT.sql. Removes the two functions only.
--
-- Data: nothing is undone or changed. Edits and undos already made through
-- these functions are ordinary consumption_logs / reagents / audit_log rows,
-- exactly the columns the previous app wrote; they stay.
--
-- Order: FIRST roll the app back to a version that does not call log_edit /
-- log_undo (otherwise editing and undoing show "not saved" errors until it is),
-- THEN run this.
drop function if exists log_edit(uuid, uuid, numeric, date, text, text, boolean, numeric, date, text, text, boolean, text);
drop function if exists log_undo(uuid, uuid, numeric, date, text);
