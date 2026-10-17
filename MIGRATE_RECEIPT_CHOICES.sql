-- ═══════════════════════════════════════════════════════════════════════════
-- LTC Lab Inventory — explicit device and expiry choice on every NEW Lot
-- ═══════════════════════════════════════════════════════════════════════════
-- Receive now makes staff decide, for each Lot, with no default:
--   device:  a device from the department's list  → device_choice = 'device'
--            "No device recorded"                   → device_choice = 'none' (device '')
--   expiry:  an expiry date                         → expiry_choice = 'date'
--            "No expiry date"                       → expiry_choice = 'none' (expiry_date null)
-- The two choices are stored, so a deliberate "none" can be told apart from a
-- field that was simply left empty before this change.
--
-- What this does:
--   * adds reagents.device_choice and reagents.expiry_choice (empty = NULL);
--     existing Lots are NOT changed — they keep NULL, meaning "recorded before
--     the choice existed" (legacy);
--   * adds ONE check constraint (not a trigger — Receive's retry safety relies on
--     reagents having no INSERT trigger), reagents_receipt_choices:
--       - a legacy Lot (both choices NULL) is accepted as it is — but only if it
--         was created before this file was applied;
--       - every other Lot must carry both choices, matching its data:
--         device_choice 'device' ⇔ a device is recorded, 'none' ⇔ none;
--         expiry_choice 'date' ⇔ an expiry date is recorded, 'none' ⇔ none.
--     Legacy Lots therefore keep working everywhere (Log use, edit / undo, Stock
--     Count, discard, Edit Lot), and a NEW Lot can't be saved without both
--     decisions — by any version of the app or any other client.
-- No inventory, log or count row is changed. Release control is unaffected.
-- Apply the app version that sends the choices in the SAME maintenance window
-- (an older app's receipts are refused by this constraint).
-- Run in the Supabase SQL Editor, then VERIFY_RECEIPT_CHOICES.sql.
-- Re-running is safe: it never moves the legacy cut-off.
-- Undo: ROLLBACK_RECEIPT_CHOICES.sql (removes the rule, keeps recorded choices).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.reagents add column if not exists device_choice text;
alter table public.reagents add column if not exists expiry_choice text;
comment on column public.reagents.device_choice is 'Receive choice: device = a device is recorded, none = deliberately no device; NULL = Lot recorded before the choice existed';
comment on column public.reagents.expiry_choice is 'Receive choice: date = an expiry date is recorded, none = deliberately no expiry date; NULL = Lot recorded before the choice existed';

do $$
declare
  v_cutoff text;
begin
  -- Added once: the cut-off is the moment it was first applied, never later.
  if exists (select 1 from pg_constraint where conrelid = 'public.reagents'::regclass and conname = 'reagents_receipt_choices') then
    return;
  end if;
  v_cutoff := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  execute format($f$
    alter table public.reagents add constraint reagents_receipt_choices check (
      (device_choice is null and expiry_choice is null and coalesce(created_at < %1$L::timestamptz, false))
      or (
        coalesce(device_choice in ('device', 'none'), false)
        and coalesce(expiry_choice in ('date', 'none'), false)
        and (device_choice = 'device') = (btrim(coalesce(device, '')) <> '')
        and (expiry_choice = 'date') = (expiry_date is not null)
      )
    )$f$, v_cutoff);
end $$;
