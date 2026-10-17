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
--     existing Lots are NOT changed — they keep NULL ("recorded before the
--     choice existed", legacy);
--   * adds reagents.receipt_seq, GENERATED ALWAYS AS IDENTITY: the database
--     numbers every Lot itself; the app (anon / authenticated) can neither set it
--     on insert nor change it on update, and its sequence is closed to them
--     (no setval). Existing Lots are numbered 1…N when this runs;
--   * adds ONE check constraint (not a trigger — Receive's retry safety relies on
--     reagents having no INSERT trigger), reagents_receipt_choices:
--       - a legacy Lot (both choices NULL) is accepted only if receipt_seq ≤ N,
--         the last number when this file was first applied (fixed in the
--         constraint; only the table owner can change it);
--       - every other Lot must carry both choices, matching its data:
--         device_choice 'device' ⇔ a device is recorded, 'none' ⇔ none;
--         expiry_choice 'date' ⇔ an expiry date is recorded, 'none' ⇔ none.
--     Legacy Lots therefore keep working everywhere (Log use, edit / undo, Stock
--     Count, discard, Edit Lot), and a NEW Lot can't be saved without both
--     decisions — whatever the app sends (created_at, the id of an erased Lot,
--     a receipt_seq of its own: none of these makes a new Lot "legacy").
-- No quantity, log, count or device value is changed. Release control is unaffected.
-- Apply the app version that sends the choices in the SAME maintenance window
-- (an older app's receipts are refused by this constraint).
--
-- NOTE — GraphQL: on 2026-10-17 pg_graphql was NOT enabled on Production. If it is
-- ever enabled, re-assess this rule on Staging before relying on it (an API layer
-- that could insert with OVERRIDING SYSTEM VALUE would bypass receipt_seq).
-- VERIFY_RECEIPT_CHOICES.sql reports whether pg_graphql is installed.
--
-- Run in the Supabase SQL Editor (during maintenance), then VERIFY_RECEIPT_CHOICES.sql.
-- Re-running is safe: it never renumbers Lots or moves the cut-off.
-- Undo: ROLLBACK_RECEIPT_CHOICES.sql (removes the rule, keeps recorded choices).
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.reagents add column if not exists device_choice text;
alter table public.reagents add column if not exists expiry_choice text;
comment on column public.reagents.device_choice is 'Receive choice: device = a device is recorded, none = deliberately no device; NULL = Lot recorded before the choice existed';
comment on column public.reagents.expiry_choice is 'Receive choice: date = an expiry date is recorded, none = deliberately no expiry date; NULL = Lot recorded before the choice existed';

-- One statement: numbering, sequence privileges and the rule are applied together,
-- under a lock, so no Lot can be received between numbering and fixing the cut-off.
do $$
declare
  v_seq text;
  v_cutoff bigint;
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.reagents'::regclass and conname = 'reagents_receipt_choices') then
    return; -- already applied: never renumber, never move the cut-off
  end if;
  lock table public.reagents in access exclusive mode;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'reagents' and column_name = 'receipt_seq') then
    execute 'alter table public.reagents add column receipt_seq bigint generated always as identity';
  end if;
  v_seq := pg_get_serial_sequence('public.reagents', 'receipt_seq');
  -- Receive doesn't need these (an identity column is filled with the table
  -- owner's rights); without them nobody but the owner can setval / nextval it.
  execute format('revoke all on sequence %s from public, anon, authenticated', v_seq);
  select coalesce(max(receipt_seq), 0) into v_cutoff from public.reagents;
  execute format($f$
    alter table public.reagents add constraint reagents_receipt_choices check (
      (device_choice is null and expiry_choice is null and receipt_seq <= %s)
      or (
        coalesce(device_choice in ('device', 'none'), false)
        and coalesce(expiry_choice in ('date', 'none'), false)
        and (device_choice = 'device') = (btrim(coalesce(device, '')) <> '')
        and (expiry_choice = 'date') = (expiry_date is not null)
      )
    )$f$, v_cutoff);
end $$;
comment on column public.reagents.receipt_seq is 'Database-assigned number of each Lot (identity; the app cannot set or change it). Lots numbered up to the cut-off in reagents_receipt_choices were recorded before explicit receipt choices existed.';
