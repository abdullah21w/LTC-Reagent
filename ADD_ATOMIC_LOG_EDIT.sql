-- Atomic edit and undo of manual consumption logs.
-- Requires ADD_EVIDENCE_FOUNDATION.sql, ADD_EVIDENCE_GUARD.sql and
-- ADD_ATOMIC_LOG_USE.sql (the same locking order). Safe to re-run. Adds TWO
-- functions only: no table, column, policy, trigger or existing function is
-- changed, nothing is backfilled, and the current app keeps working unchanged
-- until it is switched to call them.
--
-- Rollout order: ADD_ATOMIC_LOG_USE.sql → this file → VERIFY_ATOMIC_LOG_EDIT.sql
-- → the app that calls them. Rollback: ROLLBACK_ATOMIC_LOG_EDIT.sql.
--
--   log_edit(...)   change a manual log (amount, date, used by, note, QC flag)
--   log_undo(...)   undo a manual log (restores its amount to the Lot once)
--
-- One call is one transaction: the log change, the stock change, the existing
-- Lot / device restoration (undo) and the activity entry all commit, or none
-- does. Expected outcomes come back as { "status": ... } and are decided BEFORE
-- the first write, so any status other than "ok" means nothing was written.
-- Anything unexpected raises an error and rolls everything back.
--
-- Statuses (both functions unless noted):
--   ok              done by this request
--   already_saved   this request (p_request_id) was already done earlier; nothing
--                   written again. The request id is the id of the activity entry
--                   written in the same transaction, so it identifies exactly this
--                   operation (never inferred from values).
--   mismatch        this request id was already used with other details (edit)
--   already_undone  (undo) the log was undone earlier by another request
--   stale           the log no longer has the values the editor showed
--   unchanged       (edit) nothing to change
--   covered         the change would alter consumption covered by the Lot's latest
--                   completed Stock Count (see below); nothing written
--   unclassifiable  the needed timestamps are missing, so coverage can't be
--                   decided safely; the stock-affecting change is refused
--   count_derived   a Stock Count correction log: changed only from Stock Count
--   undone          (edit) the log is undone; it can't be edited
--   insufficient    (edit) the increase is more than the Lot holds ("available")
--   log_not_found / lot_changed / reserved_user / invalid_input
--
-- Concurrency: the Lot's name+device group is locked FOR UPDATE in id order —
-- exactly as log_use does (undo also includes the Lot the log replaced on its
-- device) — then the log row. Every stock change is computed here from the
-- locked rows. A second request waits, then sees the committed state: a second
-- undo finds the log undone (no second restore); a second edit built on old
-- values is "stale".
--
-- Completed-count boundary (temporary, conservative rule): a manual log is
-- COVERED by its Lot's latest completed Stock Count (the count with a line for
-- this Lot and the latest completed_at, whatever its scope) when it was recorded
-- (created_at) before that count was completed AND its date is on or before the
-- count's start day (started_at as an Asia/Riyadh calendar day — the same lab day
-- the Stock Count functions use). For a covered log — or a date change that
-- would move a log into the covered period — the amount, the date and undo are
-- refused for everyone; used by, note and QC flag stay editable and change no
-- stock. Stock Count evidence is never written here.
--
-- Amounts follow log_use: > 0, at most 2 decimals, at most 1,000,000,000, whole
-- unless the Lot's unit is a measured unit. No stock is ever clamped.
--
-- security invoker: runs with the caller's own privileges (the app's anon role,
-- which can already write these tables directly). It grants nothing new.
-- p_actor is the app's own login name (client-supplied text, like every
-- performed_by today); it is recorded, never used as proof of a role.

create or replace function log_edit(
  p_request_id uuid,
  p_log_id uuid,
  p_seen_amount numeric,
  p_seen_date date,
  p_seen_used_by text,
  p_seen_note text,
  p_seen_tested_by_qc boolean,
  p_amount numeric,
  p_date date,
  p_used_by text,
  p_note text,
  p_tested_by_qc boolean,
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
  v_first consumption_logs%rowtype;
  v_log consumption_logs%rowtype;
  v_lot0 reagents%rowtype;
  v_lot reagents%rowtype;
  v_unit text;
  v_qty_change boolean;
  v_delta numeric;
  v_new numeric;
  v_started timestamptz;
  v_completed timestamptz;
  v_start_day date;
  v_found boolean;
begin
  -- ── Input ──
  if p_request_id is null then return jsonb_build_object('status', 'invalid_input', 'reason', 'request_id'); end if;
  if p_log_id is null then return jsonb_build_object('status', 'invalid_input', 'reason', 'log_id'); end if;
  if p_amount is null or p_amount = 'NaN'::numeric or p_amount <= 0 or p_amount > c_max or p_amount <> round(p_amount, 2) then
    return jsonb_build_object('status', 'invalid_input', 'reason', 'amount');
  end if;
  if p_date is null then return jsonb_build_object('status', 'invalid_input', 'reason', 'date'); end if;
  if coalesce(btrim(p_used_by), '') = '' then return jsonb_build_object('status', 'invalid_input', 'reason', 'used_by'); end if;
  if coalesce(btrim(p_actor), '') = '' then return jsonb_build_object('status', 'invalid_input', 'reason', 'actor'); end if;
  if p_seen_amount is null or p_seen_date is null or p_seen_used_by is null then
    return jsonb_build_object('status', 'invalid_input', 'reason', 'seen');
  end if;

  -- ── Lock the Lot's group (as log_use), then the log ──
  select * into v_first from consumption_logs where id = p_log_id;
  if not found then return jsonb_build_object('status', 'log_not_found'); end if;
  select * into v_lot0 from reagents where id = v_first.reagent_id;
  if not found then return jsonb_build_object('status', 'log_not_found'); end if;
  perform 1 from reagents
   where name = v_lot0.name and coalesce(device, '') = coalesce(v_lot0.device, '')
   order by id
   for update;
  select * into v_log from consumption_logs where id = p_log_id for update;
  if not found then return jsonb_build_object('status', 'log_not_found'); end if;
  select * into v_lot from reagents where id = v_log.reagent_id;
  if not found or v_lot.name is distinct from v_lot0.name or coalesce(v_lot.device, '') <> coalesce(v_lot0.device, '') then
    return jsonb_build_object('status', 'lot_changed');
  end if;

  -- ── This request already done? (its activity entry has the request id) ──
  if exists (select 1 from audit_log where id = p_request_id) then
    if v_log.amount = p_amount and v_log.date = p_date and v_log.used_by = p_used_by
       and coalesce(v_log.note, '') = coalesce(p_note, '') and v_log.tested_by_qc = coalesce(p_tested_by_qc, false) and not v_log.deleted then
      return jsonb_build_object('status', 'already_saved', 'log_id', v_log.id);
    end if;
    return jsonb_build_object('status', 'mismatch');
  end if;

  -- ── What may change (still nothing written) ──
  if v_log.source_count_item_id is not null or v_log.used_by = c_reserved then
    return jsonb_build_object('status', 'count_derived');
  end if;
  if lower(btrim(p_used_by)) = lower(c_reserved) then return jsonb_build_object('status', 'reserved_user'); end if;
  if v_log.deleted then return jsonb_build_object('status', 'undone'); end if;
  if v_log.amount <> p_seen_amount or v_log.date <> p_seen_date or v_log.used_by <> p_seen_used_by
     or coalesce(v_log.note, '') <> coalesce(p_seen_note, '') or v_log.tested_by_qc <> coalesce(p_seen_tested_by_qc, false) then
    return jsonb_build_object('status', 'stale');
  end if;
  if v_log.amount = p_amount and v_log.date = p_date and v_log.used_by = p_used_by
     and coalesce(v_log.note, '') = coalesce(p_note, '') and v_log.tested_by_qc = coalesce(p_tested_by_qc, false) then
    return jsonb_build_object('status', 'unchanged');
  end if;

  v_qty_change := v_log.amount <> p_amount or v_log.date <> p_date;
  if v_qty_change then
    -- Completed-count boundary: the Lot's latest completed count (any scope).
    select c.started_at, c.completed_at into v_started, v_completed
      from inventory_count_items i join inventory_counts c on c.id = i.count_id
     where i.reagent_id = v_lot.id and c.status = 'completed'
     order by c.completed_at desc nulls first, c.started_at desc
     limit 1;
    v_found := found;
    if v_found then
      if v_started is null or v_completed is null or v_log.created_at is null then
        return jsonb_build_object('status', 'unclassifiable');
      end if;
      v_start_day := (v_started at time zone 'Asia/Riyadh')::date;
      if v_log.created_at < v_completed and (v_log.date <= v_start_day or p_date <= v_start_day) then
        return jsonb_build_object('status', 'covered', 'count_start_day', v_start_day, 'count_completed_at', v_completed);
      end if;
    end if;

    v_unit := lower(regexp_replace(regexp_replace(coalesce(v_lot.unit, ''), '^\s+|\s+$', '', 'g'), '\s+', ' ', 'g'));
    if v_unit not in ('ml', 'l', 'ul', 'g', 'mg', 'kg', 'mls', 'millilitre', 'milliliter', 'millilitres', 'milliliters',
        'litre', 'liter', 'litres', 'liters', 'µl', 'μl', 'microlitre', 'microliter', 'gram', 'grams', 'gm', 'gms',
        'milligram', 'milligrams', 'kilogram', 'kilograms') and p_amount <> trunc(p_amount) then
      return jsonb_build_object('status', 'invalid_input', 'reason', 'amount_not_whole');
    end if;
    v_delta := p_amount - v_log.amount;
    if v_delta > v_lot.current_quantity then
      return jsonb_build_object('status', 'insufficient', 'available', v_lot.current_quantity, 'max_amount', v_log.amount + v_lot.current_quantity);
    end if;
  end if;

  -- ── Writes ──
  update consumption_logs
     set amount = p_amount, date = p_date, used_by = p_used_by, note = p_note, tested_by_qc = coalesce(p_tested_by_qc, false),
         edited_by = p_actor, edited_at = now()
   where id = v_log.id;
  v_new := v_lot.current_quantity;
  if v_qty_change and v_delta <> 0 then
    update reagents set current_quantity = current_quantity - v_delta where id = v_lot.id returning current_quantity into v_new;
    -- As before: a removed Lot that has stock again is brought back.
    if v_lot.deleted and v_new > 0 then
      update reagents set deleted = false, deleted_by = null, deleted_at = null where id = v_lot.id;
    end if;
  end if;
  insert into audit_log (id, action, entity, description, performed_by)
  values (p_request_id, 'edit', 'log', format('%s — %s used by %s on %s', v_lot.name, trim_scale(p_amount), p_used_by, to_char(p_date, 'YYYY-MM-DD')), p_actor);

  return jsonb_build_object('status', 'ok', 'log_id', v_log.id, 'stock_change', coalesce(-v_delta, 0),
    'lot', jsonb_build_object('id', v_lot.id, 'current_quantity', v_new));
end;
$$;

create or replace function log_undo(
  p_request_id uuid,
  p_log_id uuid,
  p_seen_amount numeric,
  p_seen_date date,
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
  v_first consumption_logs%rowtype;
  v_log consumption_logs%rowtype;
  v_lot0 reagents%rowtype;
  v_lot reagents%rowtype;
  v_new numeric;
  v_revert boolean;
  v_started timestamptz;
  v_completed timestamptz;
  v_start_day date;
begin
  if p_request_id is null then return jsonb_build_object('status', 'invalid_input', 'reason', 'request_id'); end if;
  if p_log_id is null then return jsonb_build_object('status', 'invalid_input', 'reason', 'log_id'); end if;
  if p_seen_amount is null or p_seen_date is null then return jsonb_build_object('status', 'invalid_input', 'reason', 'seen'); end if;
  if coalesce(btrim(p_actor), '') = '' then return jsonb_build_object('status', 'invalid_input', 'reason', 'actor'); end if;

  -- ── Lock the Lot's group (+ the Lot this log replaced on its device), then the log ──
  select * into v_first from consumption_logs where id = p_log_id;
  if not found then return jsonb_build_object('status', 'log_not_found'); end if;
  select * into v_lot0 from reagents where id = v_first.reagent_id;
  if not found then return jsonb_build_object('status', 'log_not_found'); end if;
  perform 1 from reagents
   where (name = v_lot0.name and coalesce(device, '') = coalesce(v_lot0.device, '')) or id = v_first.previous_active_lot_id
   order by id
   for update;
  select * into v_log from consumption_logs where id = p_log_id for update;
  if not found then return jsonb_build_object('status', 'log_not_found'); end if;
  select * into v_lot from reagents where id = v_log.reagent_id;
  if not found or v_lot.name is distinct from v_lot0.name or coalesce(v_lot.device, '') <> coalesce(v_lot0.device, '') then
    return jsonb_build_object('status', 'lot_changed');
  end if;

  if exists (select 1 from audit_log where id = p_request_id) then
    return jsonb_build_object('status', case when v_log.deleted then 'already_saved' else 'mismatch' end, 'log_id', v_log.id);
  end if;
  if v_log.source_count_item_id is not null or v_log.used_by = c_reserved then
    return jsonb_build_object('status', 'count_derived');
  end if;
  if v_log.deleted then
    return jsonb_build_object('status', 'already_undone', 'deleted_by', v_log.deleted_by, 'deleted_at', v_log.deleted_at);
  end if;
  if v_log.amount <> p_seen_amount or v_log.date <> p_seen_date then
    return jsonb_build_object('status', 'stale');
  end if;

  -- Completed-count boundary (as in log_edit).
  select c.started_at, c.completed_at into v_started, v_completed
    from inventory_count_items i join inventory_counts c on c.id = i.count_id
   where i.reagent_id = v_lot.id and c.status = 'completed'
   order by c.completed_at desc nulls first, c.started_at desc
   limit 1;
  if found then
    if v_started is null or v_completed is null or v_log.created_at is null then
      return jsonb_build_object('status', 'unclassifiable');
    end if;
    v_start_day := (v_started at time zone 'Asia/Riyadh')::date;
    if v_log.created_at < v_completed and v_log.date <= v_start_day then
      return jsonb_build_object('status', 'covered', 'count_start_day', v_start_day, 'count_completed_at', v_completed);
    end if;
  end if;

  -- ── Writes (the rules App.jsx deleteLog applied, unchanged) ──
  -- The Lot stops being the active one on its device only if this log made it
  -- active and no other remaining log of this Lot exists.
  v_revert := v_log.active_device_changed and not exists (
    select 1 from consumption_logs where reagent_id = v_lot.id and id <> v_log.id and not deleted);
  update reagents set current_quantity = current_quantity + v_log.amount where id = v_lot.id returning current_quantity into v_new;
  if v_lot.deleted and v_new > 0 then
    update reagents set deleted = false, deleted_by = null, deleted_at = null where id = v_lot.id;
  end if;
  if v_revert then
    update reagents set active_on_device = false where id = v_lot.id;
    if v_log.previous_active_lot_id is not null then
      update reagents set active_on_device = true where id = v_log.previous_active_lot_id;
      update reagents set deleted = false, deleted_by = null, deleted_at = null where id = v_log.previous_active_lot_id and deleted;
    end if;
  end if;
  update consumption_logs set deleted = true, deleted_by = p_actor, deleted_at = now() where id = v_log.id;
  insert into audit_log (id, action, entity, description, performed_by)
  values (p_request_id, 'delete', 'log', format('%s — %s used by %s on %s', v_lot.name, trim_scale(v_log.amount), v_log.used_by, to_char(v_log.date, 'YYYY-MM-DD')), p_actor);

  return jsonb_build_object('status', 'ok', 'log_id', v_log.id, 'device_reverted', v_revert,
    'lot', jsonb_build_object('id', v_lot.id, 'current_quantity', v_new));
end;
$$;

-- The same grants as log_use and the Stock Count functions.
revoke all on function log_edit(uuid, uuid, numeric, date, text, text, boolean, numeric, date, text, text, boolean, text) from public, authenticated;
grant execute on function log_edit(uuid, uuid, numeric, date, text, text, boolean, numeric, date, text, text, boolean, text) to anon;
revoke all on function log_undo(uuid, uuid, numeric, date, text) from public, authenticated;
grant execute on function log_undo(uuid, uuid, numeric, date, text) to anon;
