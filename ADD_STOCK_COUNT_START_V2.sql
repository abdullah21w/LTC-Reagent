-- Atomic Stock Count start, v2 (U2a, part 2 of 3). Identical to
-- ADD_STOCK_COUNT_START.sql except for one thing: each new line also stores the
-- lot's packaging at count start (packaging_snapshot = 1, pack_unit,
-- units_per_carton), next to the base unit (unit) it already stored.
-- Requires ADD_PACKAGING_FOUNDATION.sql. Same signature, same result shape
-- (lines simply carry the three extra fields). Safe to re-run.
-- To go back to v1, see ROLLBACK_PACKAGING.sql.
--
-- Everything below the header of ADD_STOCK_COUNT_START.sql applies unchanged:
--
--   Atomic Stock Count start: one transaction creates the count and its lines,
--   with each line's expected quantity read from the database at that moment.
--   Requires ADD_INVENTORY_COUNTS.sql, ADD_COUNT_LOG_LINKS.sql and
--   ADD_ONE_OPEN_COUNT_PER_SCOPE.sql. Safe to re-run. Adds one function only;
--   the current app keeps working unchanged until it calls it.
--   
--     stock_count_start(p_department text, p_actor text) → jsonb
--       p_department  an ordinary department (e.g. 'Chemistry', 'All lab'),
--                     or NULL for Whole lab (every department).
--   
--   Lots in the count (same rule as the app had): every lot not deleted, of
--   that exact department — or of any department for Whole lab. Lots at 0 are
--   included; device and item type don't matter.
--   
--   Snapshot: those lots are locked FOR SHARE before anything is written, so a
--   lot whose quantity is being changed by another transaction is read after
--   that change commits, and no lot's quantity can change until this count
--   commits. Each line's expected_quantity is therefore the lot's quantity at
--   the moment the count is created. (Lots received while it is being created
--   are not included, as before.) started_at is the database's now().
--   
--   The scope rule stays with ADD_ONE_OPEN_COUNT_PER_SCOPE.sql (trigger +
--   unique indexes); its refusal is returned as "scope_conflict".
--   
--   Result: { "status": ... } — any status but "ok" means nothing was written:
--     ok             { count, items }   (items ordered like the app reads them)
--     no_items       nothing to count in that scope
--     scope_conflict another open count blocks this scope
--     invalid_scope  blank department name
--     invalid_input  no actor
--   Anything unexpected raises an error and rolls everything back.
--   p_actor is client-supplied text (the app's own login), as started_by today.
--   SECURITY INVOKER: runs with the caller's own (anon) privileges and RLS.

create or replace function stock_count_start(p_department text, p_actor text)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_lots uuid[];
  v_count inventory_counts%rowtype;
  v_constraint text;
  v_items jsonb;
begin
  if coalesce(btrim(p_actor), '') = '' then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  if p_department is not null and btrim(p_department) = '' then
    return jsonb_build_object('status', 'invalid_scope');
  end if;

  v_lots := array(
    select id from reagents
     where not deleted and (p_department is null or department = p_department)
     order by id
       for share);
  if cardinality(v_lots) = 0 then
    return jsonb_build_object('status', 'no_items');
  end if;

  begin
    insert into inventory_counts (department, started_by)
    values (p_department, p_actor)
    returning * into v_count;
  exception
    when raise_exception then
      if sqlerrm = 'stock_count_scope_conflict' then
        return jsonb_build_object('status', 'scope_conflict');
      end if;
      raise;
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint in ('inventory_counts_one_open_per_department', 'inventory_counts_one_open_whole_lab') then
        return jsonb_build_object('status', 'scope_conflict');
      end if;
      raise;
  end;

  -- unit = base-unit snapshot; packaging_snapshot / pack_unit / units_per_carton
  -- = the lot's packaging at this moment (copied as stored, never inferred).
  insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity,
                                     packaging_snapshot, pack_unit, units_per_carton)
  select v_count.id, r.id, r.name, r.lot_number, r.department, r.unit, r.current_quantity,
         1, r.pack_unit, r.units_per_carton
    from reagents r
   where r.id = any(v_lots);

  select coalesce(jsonb_agg(to_jsonb(i) order by i.department, i.reagent_name, i.id), '[]'::jsonb) into v_items
    from inventory_count_items i where i.count_id = v_count.id;

  return jsonb_build_object('status', 'ok', 'count', to_jsonb(v_count), 'items', v_items);
end;
$$;

revoke all on function stock_count_start(text, text) from public, authenticated;
grant execute on function stock_count_start(text, text) to anon;
