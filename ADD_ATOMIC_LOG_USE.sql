-- Atomic Log Use (one database transaction per recorded use).
-- Requires ADD_EVIDENCE_FOUNDATION.sql (date_provenance) and ADD_LOT_TO_LOT.sql.
-- Safe to re-run. Adds ONE function only: no table, column, policy, trigger or
-- existing function is changed, nothing is backfilled, and the current app keeps
-- working unchanged until it is switched to call this function.
--
-- Rollout order: this file → VERIFY_ATOMIC_LOG_USE.sql → the app that calls it.
-- Rollback: ROLLBACK_ATOMIC_LOG_USE.sql (drops the function; data untouched).
--
--   log_use(...)   record one use of a Lot: the usage log and the stock deduction
--
-- One call is one transaction: the log, the deduction and the rules that
-- follow from it (auto-remove of a depleted Lot with its activity entry, device
-- activation, Lot-to-Lot) all commit, or none does. Expected outcomes come back
-- as { "status": ... } and are decided BEFORE the first write, so any status
-- other than "ok" means nothing was written. Anything unexpected raises an
-- error and rolls everything back.
--
-- Statuses:
--   ok             saved now
--   already_saved  a log with this id already exists with the same submission
--                  (Lot, amount, date, used by, note, QC flag); nothing written
--   mismatch       a log with this id exists but is a different submission;
--                  nothing written (never reported as a success)
--   insufficient   amount is more than the Lot's current quantity ("available")
--   lot_not_found  no Lot with this id
--   lot_removed    the Lot is removed (deleted)
--   lot_changed    the Lot's name or device changed while waiting; try again
--   reserved_user  "used by" is the Stock Count correction user
--   invalid_input  missing / malformed input ("reason" says which)
--
-- Concurrency: every Lot with the same name and device (the rows the rules
-- below may touch) is locked FOR UPDATE in id order — the same order for every
-- caller, so two uses of sibling Lots can't deadlock. The deduction is computed
-- here from the locked row (current_quantity - amount), never from a value the
-- browser saw. A second caller waits, then sees the committed quantity (and,
-- for a retry, the committed log). Stock Count reconciliation locks the same
-- Lot row, so it serializes with this function too.
--
-- Idempotency: the client generates p_log_id once per submission and reuses it
-- on every retry; it becomes consumption_logs.id (the primary key), so one
-- submission can never create two logs or deduct twice.
--
-- Amount: > 0, at most 2 decimals, at most 1,000,000,000, and a whole number
-- unless the Lot's unit is a measured unit (the same vocabulary as units.js:
-- mL, L, µL, g, mg, kg and their spellings). Never rounded: anything else is
-- refused. No overdraw: the stock is never clamped.
--
-- The rules mirror App.jsx recordConsumption as it was (same columns, same
-- values, date_provenance 'manual'), including a known quirk kept on purpose:
-- a Lot that is auto-removed when depleted is still made active on its device
-- (reported separately; not changed here).
--
-- security invoker: runs with the caller's own privileges (the app's anon role,
-- which can already write these tables directly). It grants nothing new.

create or replace function log_use(
  p_log_id uuid,
  p_reagent_id uuid,
  p_amount numeric,
  p_date date,
  p_used_by text,
  p_note text,
  p_tested_by_qc boolean,
  p_replace_on_device boolean,
  p_lot_to_lot boolean,
  p_confirm_ltl_id uuid,
  p_actor text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  c_reserved constant text := 'Unlogged (physical count)';
  c_max constant numeric := 1000000000;
  v_first reagents%rowtype;
  v_lot reagents%rowtype;
  v_log consumption_logs%rowtype;
  v_unit text;
  v_measured boolean;
  v_has_device boolean;
  v_changed boolean := false;
  v_prev uuid := null;
  v_new numeric;
  v_auto boolean := false;
  v_flag boolean := false;
begin
  -- ── Input (nothing read or written yet) ──
  if p_log_id is null then return jsonb_build_object('status', 'invalid_input', 'reason', 'log_id'); end if;
  if p_reagent_id is null then return jsonb_build_object('status', 'invalid_input', 'reason', 'reagent_id'); end if;
  if p_amount is null or p_amount = 'NaN'::numeric or p_amount <= 0 or p_amount > c_max or p_amount <> round(p_amount, 2) then
    return jsonb_build_object('status', 'invalid_input', 'reason', 'amount');
  end if;
  if p_date is null then return jsonb_build_object('status', 'invalid_input', 'reason', 'date'); end if;
  if coalesce(btrim(p_used_by), '') = '' then return jsonb_build_object('status', 'invalid_input', 'reason', 'used_by'); end if;
  if lower(btrim(p_used_by)) = lower(c_reserved) then return jsonb_build_object('status', 'reserved_user'); end if;
  if coalesce(btrim(p_actor), '') = '' then return jsonb_build_object('status', 'invalid_input', 'reason', 'actor'); end if;

  -- ── Lock the Lot's group (same name and device) in id order, then re-read ──
  select * into v_first from reagents where id = p_reagent_id;
  if not found then return jsonb_build_object('status', 'lot_not_found'); end if;
  perform 1 from reagents
   where name = v_first.name and coalesce(device, '') = coalesce(v_first.device, '')
   order by id
   for update;
  select * into v_lot from reagents where id = p_reagent_id;
  if not found then return jsonb_build_object('status', 'lot_not_found'); end if;
  if v_lot.name is distinct from v_first.name or coalesce(v_lot.device, '') <> coalesce(v_first.device, '') then
    return jsonb_build_object('status', 'lot_changed');
  end if;

  -- ── Idempotency: is this submission already saved? ──
  select * into v_log from consumption_logs where id = p_log_id;
  if found then
    if v_log.reagent_id is not distinct from p_reagent_id and v_log.amount = p_amount and v_log.date = p_date
       and v_log.used_by = p_used_by and coalesce(v_log.note, '') = coalesce(p_note, '')
       and v_log.tested_by_qc = coalesce(p_tested_by_qc, false)
       and v_log.date_provenance is not distinct from 'manual' and v_log.source_count_item_id is null then
      return jsonb_build_object('status', 'already_saved', 'log_id', v_log.id, 'log_deleted', v_log.deleted,
        'lot', jsonb_build_object('id', v_lot.id, 'current_quantity', v_lot.current_quantity, 'deleted', v_lot.deleted));
    end if;
    return jsonb_build_object('status', 'mismatch', 'log_id', v_log.id);
  end if;

  -- ── Lot state and amount (still nothing written) ──
  if v_lot.deleted then return jsonb_build_object('status', 'lot_removed'); end if;
  v_unit := lower(regexp_replace(regexp_replace(coalesce(v_lot.unit, ''), '^\s+|\s+$', '', 'g'), '\s+', ' ', 'g'));
  v_measured := v_unit in ('ml', 'l', 'ul', 'g', 'mg', 'kg', 'mls', 'millilitre', 'milliliter', 'millilitres', 'milliliters',
    'litre', 'liter', 'litres', 'liters', 'µl', 'μl', 'microlitre', 'microliter', 'gram', 'grams', 'gm', 'gms',
    'milligram', 'milligrams', 'kilogram', 'kilograms');
  if not v_measured and p_amount <> trunc(p_amount) then
    return jsonb_build_object('status', 'invalid_input', 'reason', 'amount_not_whole');
  end if;
  if p_amount > v_lot.current_quantity then
    return jsonb_build_object('status', 'insufficient', 'available', v_lot.current_quantity);
  end if;

  -- Device state recorded on the log (as App.jsx did): the Lot becomes the
  -- active one on its device; the one it replaces is remembered for undo.
  v_has_device := coalesce(v_lot.device, '') <> '';
  if v_has_device and not v_lot.active_on_device then
    v_changed := true;
    if coalesce(p_replace_on_device, true) then
      select id into v_prev from reagents
       where id <> v_lot.id and name = v_lot.name and device = v_lot.device and not deleted and active_on_device
       order by id limit 1;
    end if;
  end if;

  -- ── Writes ──
  begin
    insert into consumption_logs (id, reagent_id, amount, date, used_by, note, tested_by_qc, active_device_changed, previous_active_lot_id, date_provenance)
    values (p_log_id, v_lot.id, p_amount, p_date, p_used_by, p_note, coalesce(p_tested_by_qc, false), v_changed, v_prev, 'manual');
  exception when unique_violation then
    -- the same id was saved meanwhile for another Lot (a different submission)
    return jsonb_build_object('status', 'mismatch', 'log_id', p_log_id);
  end;

  update reagents set current_quantity = current_quantity - p_amount where id = v_lot.id returning current_quantity into v_new;

  -- Auto-remove (same rule as before and as stock_count_resolve).
  if v_new <= 0 and exists (select 1 from reagents r
                             where r.id <> v_lot.id and r.name = v_lot.name
                               and coalesce(r.device, '') = coalesce(v_lot.device, '')
                               and not r.deleted and r.current_quantity > 0) then
    update reagents
       set deleted = true, deleted_by = 'Auto (lot depleted, alternate lot available)', deleted_at = now()
     where id = v_lot.id;
    insert into audit_log (action, entity, description, performed_by)
    values ('delete', 'reagent', format('%s — Lot %s (auto-removed, depleted)', v_lot.name, v_lot.lot_number), 'System');
    v_auto := true;
  end if;

  if v_has_device then
    if coalesce(p_replace_on_device, true) then
      update reagents set active_on_device = false
       where name = v_lot.name and device = v_lot.device and id <> v_lot.id and not deleted and active_on_device;
    end if;
    if not v_lot.active_on_device then
      update reagents set active_on_device = true where id = v_lot.id;
    end if;
  end if;

  if coalesce(p_lot_to_lot, false) then
    if p_confirm_ltl_id is not null then
      update lot_to_lot_pending set confirmed = true, confirmed_by = p_actor, confirmed_at = now() where id = p_confirm_ltl_id;
    end if;
    if v_new <= 0 and exists (select 1 from reagents r
                               where r.id <> v_lot.id and r.name = v_lot.name and r.device = v_lot.device
                                 and not r.deleted and r.current_quantity > 0) then
      insert into lot_to_lot_pending (reagent_name, device, depleted_lot_number, confirmed, confirmed_by, confirmed_at, created_at)
      values (v_lot.name, v_lot.device, v_lot.lot_number, false, null, null, now())
      on conflict (reagent_name, device) do update
        set depleted_lot_number = excluded.depleted_lot_number, confirmed = false, confirmed_by = null, confirmed_at = null, created_at = excluded.created_at;
      v_flag := true;
    end if;
  end if;

  return jsonb_build_object('status', 'ok', 'log_id', p_log_id, 'auto_removed', v_auto, 'lot_to_lot_flagged', v_flag,
    'lot', jsonb_build_object('id', v_lot.id, 'current_quantity', v_new, 'deleted', v_auto or v_lot.deleted));
end;
$$;

-- Only the app's role may call it (the same grants as the Stock Count
-- functions: Supabase grants new functions to anon/authenticated by default;
-- the app uses the anon key only).
revoke all on function log_use(uuid, uuid, numeric, date, text, text, boolean, boolean, boolean, uuid, text) from public, authenticated;
grant execute on function log_use(uuid, uuid, numeric, date, text, text, boolean, boolean, boolean, uuid, text) to anon;
