-- Atomic Stock Count reconciliation (one database transaction per action).
-- Requires ADD_EVIDENCE_FOUNDATION.sql. Safe to re-run. Adds functions only:
-- no table, column, policy, trigger or existing function is changed, so the
-- current app keeps working unchanged until it is switched to call these.
--
-- Rollout order: Foundation → this file → the app that calls these functions
-- → generic log protection (B2) → ADD_EVIDENCE_GUARD.sql.
--
--   stock_count_window(reagent_id, count_id)    the frozen usage-date window
--   stock_count_resolve(...)                    resolve one discrepancy line
--   stock_count_redate(...)                     Edit dates for one line
--
-- One call is one transaction: every business write of the action commits, or
-- none does. Expected outcomes come back as { "status": ... } and are always
-- decided BEFORE the first write, so any status other than "ok" means nothing
-- was written. Anything unexpected raises an error and rolls everything back.
--
-- Statuses: ok, already_resolved, stale_line, stale_allocation, outside_window,
-- allocation_mismatch, invalid_allocation, allocation_unsafe, window_unavailable,
-- no_discrepancy, invalid_count_state, invalid_line_state, not_found, invalid_input.
--
-- Concurrency: the count is locked FOR SHARE, then the line FOR UPDATE (the
-- same order as deleting a count, which cascades to its lines). A second caller
-- waits, then re-reads the committed line: "already_resolved" (resolve) or
-- "stale_allocation" (Edit dates), with zero writes.
--
-- Quantities, the discrepancy, the window, provenance, resolved_at and
-- resolution_details are all derived here from locked rows; the client's
-- seen_expected / seen_counted are only compared. p_actor is client-supplied
-- text (the app's own login), exactly like started_by and audit performed_by
-- today — it is not verified by the database.
--
-- SECURITY INVOKER: runs with the caller's own (anon) privileges and RLS.

-- The usage-date window (mirror of countBounds.js usageInterval +
-- previousCompletedCounts). Lab days are Asia/Riyadh calendar days; times are
-- compared at millisecond precision, as the browser does.
create or replace function stock_count_window(p_reagent_id uuid, p_count_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_received date;
  v_started timestamptz;
  v_prev timestamptz;
  v_prev_day date;
  v_from date;
  v_to date;
begin
  if p_reagent_id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_lot');
  end if;
  select coalesce(date_added, (created_at at time zone 'Asia/Riyadh')::date) into v_received
    from reagents where id = p_reagent_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_lot');
  end if;
  select started_at into v_started from inventory_counts where id = p_count_id;

  select max(c.completed_at) into v_prev
    from inventory_count_items i
    join inventory_counts c on c.id = i.count_id
   where i.reagent_id = p_reagent_id
     and i.count_id is distinct from p_count_id
     and c.status = 'completed'
     and c.completed_at is not null
     and date_trunc('milliseconds', c.completed_at) < date_trunc('milliseconds', v_started);
  v_prev_day := (v_prev at time zone 'Asia/Riyadh')::date;

  v_from := case when v_prev_day is not null and (v_received is null or v_prev_day > v_received) then v_prev_day else v_received end;
  v_to := (v_started at time zone 'Asia/Riyadh')::date;
  if v_from is null or v_to is null then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;
  if v_from > v_to then
    return jsonb_build_object('ok', false, 'reason', 'empty', 'from', to_char(v_from, 'YYYY-MM-DD'), 'to', to_char(v_to, 'YYYY-MM-DD'));
  end if;
  return jsonb_build_object(
    'ok', true,
    'from', to_char(v_from, 'YYYY-MM-DD'),
    'to', to_char(v_to, 'YYYY-MM-DD'),
    'source', case when v_prev_day is not null and v_from = v_prev_day then 'previous_count' else 'received' end
  );
end;
$$;

-- Resolve one discrepancy line: usage_exact | usage_spread | corrected | kept.
--   p_date        usage_exact only: the chosen day
--   p_allocation  usage_spread only: [{ "date": "YYYY-MM-DD", "amount": n }, …]
--                 as built by the app's spread (validated here, never adjusted)
create or replace function stock_count_resolve(
  p_item_id uuid,
  p_method text,
  p_actor text,
  p_seen_expected numeric,
  p_seen_counted numeric,
  p_date date default null,
  p_allocation jsonb default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  c_used_by constant text := 'Unlogged (physical count)';
  v_count_id uuid;
  v_count inventory_counts%rowtype;
  v_item inventory_count_items%rowtype;
  v_lot reagents%rowtype;
  v_lot_found boolean := false;
  v_win jsonb;
  v_from date;
  v_to date;
  v_shortage numeric;
  v_dates date[] := '{}';
  v_amounts numeric[] := '{}';
  v_el jsonb;
  v_d date;
  v_a numeric;
  v_prov text;
  v_alloc jsonb := '[]'::jsonb;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_note text;
  v_log_note text;
  v_audit text;
  v_e numeric;
  v_c numeric;
  v_details jsonb;
  i int;
begin
  -- Input shape.
  if p_item_id is null or p_method is null or p_method not in ('usage_exact', 'usage_spread', 'corrected', 'kept')
     or coalesce(btrim(p_actor), '') = ''
     or (p_method = 'usage_exact' and (p_date is null or p_allocation is not null))
     or (p_method = 'usage_spread' and (p_allocation is null or p_date is not null))
     or (p_method in ('corrected', 'kept') and (p_date is not null or p_allocation is not null)) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  -- Lock: count (share) → line (update).
  select count_id into v_count_id from inventory_count_items where id = p_item_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select * into v_count from inventory_counts where id = v_count_id for share;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select * into v_item from inventory_count_items where id = p_item_id for update;
  if not found or v_item.count_id <> v_count_id then return jsonb_build_object('status', 'not_found'); end if;

  if v_item.resolved then
    return jsonb_build_object('status', 'already_resolved', 'line', to_jsonb(v_item));
  end if;
  -- Discrepancies are resolved while the count is in progress (Finish needs
  -- every discrepancy resolved first).
  if v_count.status <> 'in_progress' then
    return jsonb_build_object('status', 'invalid_count_state', 'count_status', v_count.status);
  end if;
  if p_seen_expected is distinct from v_item.expected_quantity or p_seen_counted is distinct from v_item.counted_quantity then
    return jsonb_build_object('status', 'stale_line', 'line', to_jsonb(v_item));
  end if;
  if v_item.counted_quantity is null or v_item.counted_quantity = v_item.expected_quantity then
    return jsonb_build_object('status', 'no_discrepancy', 'line', to_jsonb(v_item));
  end if;
  v_shortage := v_item.expected_quantity - v_item.counted_quantity;
  if p_method in ('usage_exact', 'usage_spread') and v_shortage <= 0 then
    return jsonb_build_object('status', 'invalid_input', 'reason', 'usage_needs_shortage');
  end if;

  if v_item.reagent_id is not null and p_method <> 'kept' then
    select * into v_lot from reagents where id = v_item.reagent_id for update;
    v_lot_found := found;
  end if;

  -- Usage: window, then the allocation (all checks before any write).
  if p_method in ('usage_exact', 'usage_spread') then
    v_win := stock_count_window(v_item.reagent_id, v_count.id);
    if not (v_win->>'ok')::boolean then
      return jsonb_build_object('status', 'window_unavailable', 'window', v_win);
    end if;
    v_from := (v_win->>'from')::date;
    v_to := (v_win->>'to')::date;

    if p_method = 'usage_exact' then
      if p_date < v_from or p_date > v_to then
        return jsonb_build_object('status', 'outside_window', 'window', v_win);
      end if;
      v_dates := array[p_date];
      v_amounts := array[v_shortage];
      v_prov := case when p_date = v_to then 'count_exact_default' else 'count_exact' end;
    else
      if jsonb_typeof(p_allocation) <> 'array' or jsonb_array_length(p_allocation) = 0 then
        return jsonb_build_object('status', 'invalid_allocation');
      end if;
      for v_el in select e.value from jsonb_array_elements(p_allocation) with ordinality as e(value, ord) order by e.ord loop
        if jsonb_typeof(v_el) <> 'object'
           or (select count(*) from jsonb_object_keys(v_el) k where k not in ('date', 'amount')) > 0
           or jsonb_typeof(v_el->'date') is distinct from 'string'
           or jsonb_typeof(v_el->'amount') is distinct from 'number'
           or (v_el->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then
          return jsonb_build_object('status', 'invalid_allocation');
        end if;
        begin
          v_d := (v_el->>'date')::date;
        exception when others then
          return jsonb_build_object('status', 'invalid_allocation');
        end;
        v_a := (v_el->>'amount')::numeric;
        if to_char(v_d, 'YYYY-MM-DD') <> (v_el->>'date') or v_a < 0 or v_a <> round(v_a, 2)
           or (cardinality(v_dates) > 0 and v_d <= v_dates[cardinality(v_dates)]) then
          return jsonb_build_object('status', 'invalid_allocation');
        end if;
        v_dates := v_dates || v_d;
        v_amounts := v_amounts || v_a;
      end loop;
      if v_dates[1] < v_from or v_dates[cardinality(v_dates)] > v_to then
        return jsonb_build_object('status', 'outside_window', 'window', v_win);
      end if;
      if (select sum(a) from unnest(v_amounts) a) <> v_shortage then
        return jsonb_build_object('status', 'allocation_mismatch', 'shortage', v_shortage);
      end if;
      v_prov := 'count_spread_window';
    end if;
  end if;

  -- ── Writes (no status return past this point) ──
  if p_method in ('usage_exact', 'usage_spread') then
    v_log_note := case when p_method = 'usage_exact'
      then 'Retroactively logged — found missing during a physical count.'
      else format('Retroactively logged — spread from %s to %s, found missing during a physical count.', to_char(v_from, 'YYYY-MM-DD'), to_char(v_to, 'YYYY-MM-DD')) end;
    for i in 1 .. cardinality(v_dates) loop
      insert into consumption_logs (reagent_id, amount, date, used_by, note, source_count_item_id, date_provenance)
      values (v_item.reagent_id, v_amounts[i], v_dates[i], c_used_by, v_log_note, v_item.id, v_prov)
      returning id into v_id;
      v_ids := v_ids || v_id;
      v_alloc := v_alloc || jsonb_build_array(jsonb_build_object('date', to_char(v_dates[i], 'YYYY-MM-DD'), 'amount', trim_scale(v_amounts[i])));
    end loop;
  end if;

  if p_method in ('usage_exact', 'usage_spread', 'corrected') and v_item.reagent_id is not null then
    update reagents set current_quantity = v_item.counted_quantity where id = v_item.reagent_id;
    v_audit := case p_method
      when 'usage_exact' then format('%s — Lot %s — Physical count found %s %s of unlogged usage, recorded as consumption dated %s: %s → %s',
        v_item.reagent_name, v_item.lot_number, trim_scale(v_shortage), v_item.unit, to_char(v_dates[1], 'YYYY-MM-DD'), trim_scale(v_item.expected_quantity), trim_scale(v_item.counted_quantity))
      when 'usage_spread' then format('%s — Lot %s — Physical count found %s %s of unlogged usage, spread as consumption from %s to %s: %s → %s',
        v_item.reagent_name, v_item.lot_number, trim_scale(v_shortage), v_item.unit, to_char(v_from, 'YYYY-MM-DD'), to_char(v_to, 'YYYY-MM-DD'), trim_scale(v_item.expected_quantity), trim_scale(v_item.counted_quantity))
      else format('%s — Lot %s — Physical count adjustment: %s → %s',
        v_item.reagent_name, v_item.lot_number, trim_scale(v_item.expected_quantity), trim_scale(v_item.counted_quantity)) end;
    insert into audit_log (action, entity, description, performed_by, performed_at)
    values ('edit', 'reagent', v_audit, p_actor, clock_timestamp());

    -- Auto-remove (same rule as StockCount autoRemoveIfDepleted / App.jsx
    -- recordConsumption), evaluated on current rows.
    if v_item.counted_quantity <= 0 and v_lot_found
       and exists (select 1 from reagents r
                    where r.id <> v_lot.id and r.name = v_lot.name
                      and coalesce(r.device, '') = coalesce(v_lot.device, '')
                      and not r.deleted and r.current_quantity > 0) then
      update reagents
         set deleted = true, deleted_by = 'Auto (lot depleted, alternate lot available)', deleted_at = now()
       where id = v_lot.id;
      insert into audit_log (action, entity, description, performed_by, performed_at)
      values ('delete', 'reagent', format('%s — Lot %s (auto-removed, depleted)', v_lot.name, v_lot.lot_number), 'System', clock_timestamp());
    end if;
  end if;

  -- resolution_details v1 (same shape as countEvidence.js resolutionDetails).
  v_e := round(v_item.expected_quantity, 2);
  v_c := round(v_item.counted_quantity, 2);
  v_details := jsonb_build_object(
    'v', 1,
    'method', p_method,
    'discrepancy', jsonb_build_object('expected', trim_scale(v_e), 'counted', trim_scale(v_c), 'difference', trim_scale(round(v_c - v_e, 2))),
    'window', case when p_method in ('usage_exact', 'usage_spread')
      then jsonb_build_object('from', v_win->'from', 'to', v_win->'to', 'source', v_win->'source') end,
    'allocation', v_alloc,
    'date_provenance', v_prov
  );
  v_note := case p_method
    when 'usage_exact' then 'Logged as usage on ' || to_char(v_dates[1], 'YYYY-MM-DD')
    when 'usage_spread' then format('Logged as usage spread from %s to %s', to_char(v_from, 'YYYY-MM-DD'), to_char(v_to, 'YYYY-MM-DD'))
    when 'corrected' then 'Corrected to match count'
    else 'Kept system value' end;

  update inventory_count_items
     set resolved = true,
         resolution_note = v_note,
         resolved_at = now(),
         resolved_by = p_actor,
         resolution_details = v_details,
         consumption_log_ids = case when cardinality(v_ids) > 0 then v_ids else consumption_log_ids end
   where id = v_item.id
  returning * into v_item;

  return jsonb_build_object('status', 'ok', 'line', to_jsonb(v_item), 'log_ids', to_jsonb(v_ids));
end;
$$;

-- Edit dates for one resolved usage line of a completed count. Replaces the
-- line's current correction rows with the new dates; the total, the stock and
-- the original resolution (resolved_at/by, resolution_details) never change.
--   p_current_log_ids  the rows the user saw (must still be the current ones)
--   p_mode             'exact' (p_date) | 'range' (p_from, p_to, p_allocation)
create or replace function stock_count_redate(
  p_item_id uuid,
  p_actor text,
  p_current_log_ids uuid[],
  p_mode text,
  p_date date default null,
  p_from date default null,
  p_to date default null,
  p_allocation jsonb default null
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  c_used_by constant text := 'Unlogged (physical count)';
  v_count_id uuid;
  v_count inventory_counts%rowtype;
  v_item inventory_count_items%rowtype;
  v_current uuid[];
  v_n int;
  v_bad text;
  v_total numeric;
  v_win jsonb;
  v_wfrom date;
  v_wto date;
  v_dates date[] := '{}';
  v_amounts numeric[] := '{}';
  v_old_dates date[];
  v_el jsonb;
  v_d date;
  v_a numeric;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_note text;
  v_res_note text;
  v_old_text text;
  i int;
begin
  if p_item_id is null or coalesce(btrim(p_actor), '') = '' or p_current_log_ids is null
     or p_mode is null or p_mode not in ('exact', 'range')
     or (p_mode = 'exact' and (p_date is null or p_from is not null or p_to is not null or p_allocation is not null))
     or (p_mode = 'range' and (p_from is null or p_to is null or p_allocation is null or p_date is not null)) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select count_id into v_count_id from inventory_count_items where id = p_item_id;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select * into v_count from inventory_counts where id = v_count_id for share;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select * into v_item from inventory_count_items where id = p_item_id for update;
  if not found or v_item.count_id <> v_count_id then return jsonb_build_object('status', 'not_found'); end if;

  if v_count.status <> 'completed' then
    return jsonb_build_object('status', 'invalid_count_state', 'count_status', v_count.status);
  end if;
  if not v_item.resolved or coalesce(v_item.resolution_note, '') not like 'Logged as usage%' then
    return jsonb_build_object('status', 'invalid_line_state', 'line', to_jsonb(v_item));
  end if;

  -- The line's current correction rows: its linked ids, or — for a line
  -- resolved before links existed — the app's existing match (same lot,
  -- correction rows created during the count, amounts adding up to the shortage).
  if cardinality(v_item.consumption_log_ids) > 0 then
    v_current := array(select distinct x from unnest(v_item.consumption_log_ids) x order by 1);
    perform 1 from consumption_logs where id = any(v_current) order by id for update;
    select count(*) into v_n from consumption_logs where id = any(v_current);
    if v_n <> cardinality(v_current) then
      return jsonb_build_object('status', 'stale_allocation', 'reason', 'linked_rows_missing', 'line', to_jsonb(v_item));
    end if;
  else
    v_current := array(
      select id from consumption_logs
       where used_by = c_used_by and reagent_id = v_item.reagent_id
         and created_at >= v_count.started_at
         and created_at <= date_trunc('milliseconds', v_count.completed_at) + interval '60 seconds'
       order by id);
    perform 1 from consumption_logs where id = any(v_current) order by id for update;
    if cardinality(v_current) = 0
       or abs((select sum(amount) from consumption_logs where id = any(v_current)) - (v_item.expected_quantity - v_item.counted_quantity)) >= 0.005 then
      return jsonb_build_object('status', 'allocation_unsafe', 'reason', 'no_exact_match');
    end if;
    if exists (select 1 from inventory_count_items o
                where o.id <> v_item.id and o.consumption_log_ids && v_current)
       or exists (select 1 from inventory_count_items o
                   where o.count_id = v_count.id and o.id <> v_item.id and o.reagent_id = v_item.reagent_id) then
      return jsonb_build_object('status', 'allocation_unsafe', 'reason', 'claimed_by_another_line');
    end if;
  end if;

  if array(select distinct x from unnest(p_current_log_ids) x order by 1) is distinct from v_current then
    return jsonb_build_object('status', 'stale_allocation', 'line', to_jsonb(v_item));
  end if;
  select case
           when bool_or(deleted) then 'deleted_row'
           when bool_or(reagent_id is distinct from v_item.reagent_id) then 'other_lot'
           when bool_or(used_by <> c_used_by) then 'not_a_correction'
           when bool_or(source_count_item_id is not null and source_count_item_id <> v_item.id) then 'linked_to_another_line'
         end,
         sum(amount),
         array_agg(date order by date)
    into v_bad, v_total, v_old_dates
    from consumption_logs where id = any(v_current);
  if v_bad is not null then
    return jsonb_build_object('status', 'allocation_unsafe', 'reason', v_bad);
  end if;

  v_win := stock_count_window(v_item.reagent_id, v_count.id);
  if not (v_win->>'ok')::boolean then
    return jsonb_build_object('status', 'window_unavailable', 'window', v_win);
  end if;
  v_wfrom := (v_win->>'from')::date;
  v_wto := (v_win->>'to')::date;

  if p_mode = 'exact' then
    if p_date < v_wfrom or p_date > v_wto then
      return jsonb_build_object('status', 'outside_window', 'window', v_win);
    end if;
    v_dates := array[p_date];
    v_amounts := array[v_total];
  else
    if p_from > p_to or p_from < v_wfrom or p_to > v_wto then
      return jsonb_build_object('status', 'outside_window', 'window', v_win);
    end if;
    if jsonb_typeof(p_allocation) <> 'array' or jsonb_array_length(p_allocation) = 0 then
      return jsonb_build_object('status', 'invalid_allocation');
    end if;
    for v_el in select e.value from jsonb_array_elements(p_allocation) with ordinality as e(value, ord) order by e.ord loop
      if jsonb_typeof(v_el) <> 'object'
         or (select count(*) from jsonb_object_keys(v_el) k where k not in ('date', 'amount')) > 0
         or jsonb_typeof(v_el->'date') is distinct from 'string'
         or jsonb_typeof(v_el->'amount') is distinct from 'number'
         or (v_el->>'date') !~ '^\d{4}-\d{2}-\d{2}$' then
        return jsonb_build_object('status', 'invalid_allocation');
      end if;
      begin
        v_d := (v_el->>'date')::date;
      exception when others then
        return jsonb_build_object('status', 'invalid_allocation');
      end;
      v_a := (v_el->>'amount')::numeric;
      if to_char(v_d, 'YYYY-MM-DD') <> (v_el->>'date') or v_a < 0 or v_a <> round(v_a, 2)
         or (cardinality(v_dates) > 0 and v_d <= v_dates[cardinality(v_dates)]) then
        return jsonb_build_object('status', 'invalid_allocation');
      end if;
      v_dates := v_dates || v_d;
      v_amounts := v_amounts || v_a;
    end loop;
    if v_dates[1] < p_from or v_dates[cardinality(v_dates)] > p_to then
      return jsonb_build_object('status', 'outside_window', 'window', v_win);
    end if;
    if (select sum(a) from unnest(v_amounts) a) <> v_total then
      return jsonb_build_object('status', 'allocation_mismatch', 'total', v_total);
    end if;
  end if;

  -- ── Writes ──
  v_note := case when p_mode = 'range'
    then format('Retroactively logged — spread from %s to %s, found missing during a physical count.', to_char(p_from, 'YYYY-MM-DD'), to_char(p_to, 'YYYY-MM-DD'))
    else 'Retroactively logged — found missing during a physical count.' end;
  for i in 1 .. cardinality(v_dates) loop
    insert into consumption_logs (reagent_id, amount, date, used_by, note, source_count_item_id, date_provenance)
    values (v_item.reagent_id, v_amounts[i], v_dates[i], c_used_by, v_note, v_item.id, 'count_redated')
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;

  delete from consumption_logs where id = any(v_current);
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_current) then
    raise exception 'stock_count_redate: expected to replace % rows, removed %', cardinality(v_current), v_n;
  end if;

  v_res_note := case when p_mode = 'range'
    then format('Logged as usage spread from %s to %s', to_char(p_from, 'YYYY-MM-DD'), to_char(p_to, 'YYYY-MM-DD'))
    else 'Logged as usage on ' || to_char(p_date, 'YYYY-MM-DD') end;
  update inventory_count_items
     set resolution_note = v_res_note, consumption_log_ids = v_ids
   where id = v_item.id
  returning * into v_item;

  v_old_text := case when cardinality(v_old_dates) > 1
    then to_char(v_old_dates[1], 'YYYY-MM-DD') || ' → ' || to_char(v_old_dates[cardinality(v_old_dates)], 'YYYY-MM-DD')
    else to_char(v_old_dates[1], 'YYYY-MM-DD') end;
  insert into audit_log (action, entity, description, performed_by, performed_at)
  values ('edit', 'log',
          format('Stock count edit: %s — Lot %s — %s %s of unlogged usage re-dated from %s to %s',
                 v_item.reagent_name, v_item.lot_number, trim_scale(v_total), v_item.unit, v_old_text,
                 case when p_mode = 'range' then format('spread %s → %s', to_char(p_from, 'YYYY-MM-DD'), to_char(p_to, 'YYYY-MM-DD')) else to_char(p_date, 'YYYY-MM-DD') end),
          p_actor, clock_timestamp());

  return jsonb_build_object('status', 'ok', 'line', to_jsonb(v_item), 'log_ids', to_jsonb(v_ids));
end;
$$;

-- Only the app's role may call these (Supabase grants new functions to
-- anon/authenticated by default; the app uses the anon key only).
revoke all on function stock_count_window(uuid, uuid) from public, authenticated;
revoke all on function stock_count_resolve(uuid, text, text, numeric, numeric, date, jsonb) from public, authenticated;
revoke all on function stock_count_redate(uuid, text, uuid[], text, date, date, date, jsonb) from public, authenticated;
grant execute on function stock_count_window(uuid, uuid) to anon;
grant execute on function stock_count_resolve(uuid, text, text, numeric, numeric, date, jsonb) to anon;
grant execute on function stock_count_redate(uuid, text, uuid[], text, date, date, date, jsonb) to anon;
