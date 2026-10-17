-- Rollback of MIGRATE_RECEIPT_CHOICES.sql: removes the rule only.
-- KEPT: the choice columns with every choice already recorded, and receipt_seq
-- (harmless without the rule; dropping them would lose the recorded choices).
-- No quantity, log, count or device value is changed.
--
-- After this, receipts without the choices are accepted again (e.g. from the
-- previous app version after a Vercel rollback — that is what this is for).
-- Re-applying MIGRATE_RECEIPT_CHOICES.sql later fixes a NEW cut-off at the highest
-- receipt_seq at that moment: Lots received while the rule was off and without
-- choices then count as legacy. Run VERIFY_RECEIPT_CHOICES.sql before re-applying
-- (check 6 must PASS — the old app may have edited Lots that carry choices).
alter table public.reagents drop constraint if exists reagents_receipt_choices;

-- Only if the column itself must go (not needed to restore the previous app):
--   alter table public.reagents drop column if exists receipt_seq;
