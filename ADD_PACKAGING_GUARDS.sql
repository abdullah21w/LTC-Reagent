-- Packaging guards (U2a, part 3 of 3). Requires ADD_PACKAGING_FOUNDATION.sql.
-- Safe to re-run. Changes no row. Two independent guards:
--
-- 1. Count-line snapshot guard (PERMANENT — ROLLBACK_PACKAGING.sql does not
--    remove it). Its own function and trigger, separate from the Evidence Guard:
--    a line's unit (the base-unit snapshot), packaging_snapshot, pack_unit and
--    units_per_carton can never change once the line exists — NULL → value
--    included, so a line created before U2a (all four NULL except unit) can
--    never be given an inferred packaging. Values are only ever set on INSERT
--    (stock_count_start). The Evidence Guard (ADD_EVIDENCE_GUARD.sql) is not
--    touched in any way: its function, trigger and rules stay exactly as they
--    are, and re-running that file doesn't affect this guard.
--
-- 2. Lot packaging guard (reagents). Once a lot has ANY usage log (undone ones
--    included) or ANY Stock Count line, its packaging is fixed:
--      unit              may not change, except for letter case and surrounding
--                        spaces ("Bottle " → "bottle"), exactly like Edit Lot (U0)
--      units_per_carton  may not change, including NULL ↔ value (packaging on/off)
--      pack_unit         may not change, including NULL → value (decision D3)
--    Lots without history stay freely editable. The trigger fires only when an
--    UPDATE names one of these columns, and refuses only a real change, so
--    resending unchanged values (Edit Lot sends unit and units_per_carton every
--    time) passes; quantity, consumption, undo, discard and restore updates
--    don't name these columns and are never affected.
--    Correcting packaging on a lot with history is left to a separate, audited
--    reconciliation design (not built); there is deliberately no bypass here.
--
-- Refusals raise SQLSTATE P0001: 'evidence_field_protected' (count lines, the
-- same message the Evidence Guard uses) or 'packaging_locked' (lots), with the
-- column in DETAIL and the row id in HINT.

create or replace function inventory_count_items_guard_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bad text := null;
begin
  if new.unit is distinct from old.unit then bad := 'unit';
  elsif new.packaging_snapshot is distinct from old.packaging_snapshot then bad := 'packaging_snapshot';
  elsif new.pack_unit is distinct from old.pack_unit then bad := 'pack_unit';
  elsif new.units_per_carton is distinct from old.units_per_carton then bad := 'units_per_carton';
  end if;
  if bad is not null then
    raise exception using errcode = 'P0001', message = 'evidence_field_protected', detail = bad, hint = old.id::text;
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_count_items_snapshot_guard on inventory_count_items;
create trigger inventory_count_items_snapshot_guard
  before update on inventory_count_items
  for each row execute function inventory_count_items_guard_snapshot();

create or replace function reagents_guard_packaging()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bad text := null;
begin
  -- Same unit comparison as Edit Lot (lotEdit.js normUnit): surrounding
  -- whitespace and letter case don't count as a change.
  if lower(regexp_replace(new.unit, '^[\s\u00a0\ufeff]+|[\s\u00a0\ufeff]+$', '', 'g'))
       is distinct from lower(regexp_replace(old.unit, '^[\s\u00a0\ufeff]+|[\s\u00a0\ufeff]+$', '', 'g')) then bad := 'unit';
  elsif new.units_per_carton is distinct from old.units_per_carton then bad := 'units_per_carton';
  elsif new.pack_unit is distinct from old.pack_unit then bad := 'pack_unit';
  end if;
  if bad is null then
    return new;
  end if;
  if exists (select 1 from consumption_logs where reagent_id = old.id)
     or exists (select 1 from inventory_count_items where reagent_id = old.id) then
    raise exception using errcode = 'P0001', message = 'packaging_locked', detail = bad, hint = old.id::text;
  end if;
  return new;
end;
$$;

drop trigger if exists reagents_packaging_guard on reagents;
create trigger reagents_packaging_guard
  before update of unit, units_per_carton, pack_unit on reagents
  for each row execute function reagents_guard_packaging();
