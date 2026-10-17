-- Rollback of MIGRATE_RECEIPT_CHOICES.sql: removes the rule only. The columns and
-- every choice already recorded are KEPT (they're harmless without the rule, and
-- re-applying the migration would otherwise lose them). No inventory, log or
-- count row is changed.
-- After this, receipts without the choices are accepted again — use only if the
-- rule itself blocks work, and roll the app back to the version without choices
-- only if needed (the newer app keeps sending the choices either way).
-- Re-applying MIGRATE_RECEIPT_CHOICES.sql later sets a NEW cut-off (Lots received
-- while the rule was off stay legacy if they have no choices).
alter table public.reagents drop constraint if exists reagents_receipt_choices;
