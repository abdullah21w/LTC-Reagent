-- Rollback of U2a APPLICATION BEHAVIOUR (ADD_STOCK_COUNT_START_V2.sql and the
-- lot packaging guard). Safe to re-run. Changes no row.
--
-- What it does:
--   1. removes the lot packaging guard (reagents_packaging_guard trigger +
--      reagents_guard_packaging function), so lot packaging is again governed
--      only by the app's Edit Lot rules (U0);
--   2. restores stock_count_start exactly as in ADD_STOCK_COUNT_START.sql (v1):
--      new count lines are created without a packaging snapshot (NULL), as
--      before U2a.
--
-- What it deliberately does NOT do — historical evidence stays protected:
--   • The count-line snapshot guard (inventory_count_items_snapshot_guard) is
--     PERMANENT and stays: unit, packaging_snapshot, pack_unit and
--     units_per_carton on every count line — snapshots taken while U2a was
--     active, legacy lines, and lines v1 creates after this rollback — still
--     can't be changed or backfilled.
--   • The Evidence Guard is untouched (U2a never changed it).
--   • The new nullable columns and their constraints are kept (decision D5).
--
-- Removing the snapshot guard is not part of any rollback; it would need its
-- own explicit, reviewed decision.

drop trigger if exists reagents_packaging_guard on reagents;
drop function if exists reagents_guard_packaging();

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

  insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity)
  select v_count.id, r.id, r.name, r.lot_number, r.department, r.unit, r.current_quantity
    from reagents r
   where r.id = any(v_lots);

  select coalesce(jsonb_agg(to_jsonb(i) order by i.department, i.reagent_name, i.id), '[]'::jsonb) into v_items
    from inventory_count_items i where i.count_id = v_count.id;

  return jsonb_build_object('status', 'ok', 'count', to_jsonb(v_count), 'items', v_items);
end;
$$;

revoke all on function stock_count_start(text, text) from public, authenticated;
grant execute on function stock_count_start(text, text) to anon;
