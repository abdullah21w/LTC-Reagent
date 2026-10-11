-- U2a atomic migration — ONE transaction. Generated from commit f23bd4e.
-- Run in the Supabase SQL editor as a single query, only after a fresh
-- PRECHECK_PACKAGING.sql passed. Either everything below is committed, or
-- nothing is: any error (including a lock wait over 5 s or the verification
-- block) aborts the whole transaction.
-- After ANY error: run "rollback;" once as its own query, then re-run
-- PRECHECK_PACKAGING.sql to confirm nothing was applied.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ═══ [1/3] ADD_PACKAGING_FOUNDATION.sql — verbatim from commit f23bd4e (sha256 a3189ec33d2c8dc3) ═══
-- Packaging foundation (U2a, part 1 of 3: schema). Run once in the Supabase SQL
-- editor. Safe to re-run. Additive only: every new column is nullable, existing
-- rows keep NULL, no stored quantity, unit or log changes, and nothing is
-- backfilled or inferred for history.
--
-- Requires ADD_INVENTORY_COUNTS.sql and ADD_CARTON_PACKAGING.sql.
-- Then apply ADD_STOCK_COUNT_START_V2.sql and ADD_PACKAGING_GUARDS.sql.
--
-- reagents
--   unit               (existing) the base unit: every stored quantity of the
--                      lot is in it.
--   units_per_carton   (existing) base units in one outer package; NULL = the
--                      lot isn't packaged. NOT constrained to a whole number
--                      here on purpose: that check comes with Receive validation
--                      in U2d (see the note at the end).
--   pack_unit          (new) the outer package's name (box, carton, pack …),
--                      saved on the lot. NULL = no name saved — screens use their
--                      legacy display fallback, which is never presented as
--                      verified packaging.
--
-- inventory_count_items — packaging as it was when the count started:
--   unit               (existing) the base-unit snapshot, already copied from
--                      the lot when the count starts.
--   packaging_snapshot (new) 1 = this line was created by stock_count_start v2
--                      and carries the snapshot below; NULL = a line created
--                      before U2a: its packaging is unknown and stays unknown.
--   pack_unit          (new) the lot's pack_unit at count start.
--   units_per_carton   (new) the lot's units_per_carton at count start.
-- ADD_PACKAGING_GUARDS.sql makes all four immutable once a line exists.

alter table reagents add column if not exists pack_unit text null;

-- A saved name needs a box size, can't be blank or over 40 characters, and
-- can't be the base unit itself ("1 box = 5 boxes"; the app also refuses
-- plural spellings). Rows without a pack_unit are not affected.
alter table reagents drop constraint if exists reagents_pack_unit_valid;
alter table reagents add constraint reagents_pack_unit_valid check (
  pack_unit is null or (
    btrim(pack_unit) <> ''
    and char_length(pack_unit) <= 40
    and units_per_carton is not null
    and lower(btrim(pack_unit)) <> lower(btrim(unit))
  )
);

alter table inventory_count_items
  add column if not exists packaging_snapshot smallint null,
  add column if not exists pack_unit text null,
  add column if not exists units_per_carton numeric null;

-- Legacy line: all three NULL. Snapshot line: packaging_snapshot = 1, and a
-- pack name only together with a box size. The box size is copied as stored
-- (no whole-number check — see the note below). Written as CASE so the check
-- can never evaluate to NULL (a CHECK that yields NULL would let the row in).
alter table inventory_count_items drop constraint if exists inventory_count_items_packaging_snapshot_valid;
alter table inventory_count_items add constraint inventory_count_items_packaging_snapshot_valid check (
  case
    when packaging_snapshot is null then pack_unit is null and units_per_carton is null
    else packaging_snapshot = 1 and (pack_unit is null or units_per_carton is not null)
  end
);

-- Deferred (decision D2): "units_per_carton is a whole number ≥ 1" is NOT added
-- here, nor hidden in any other constraint or trigger. Today's Receive screen
-- sends the box size unvalidated and ignores database errors, so such a check
-- would make a mistyped receipt disappear silently. It is added in U2d, after
-- Receive validates the value and shows database errors, by a separate file:
--   1. read-only check that every stored value is already whole and ≥ 1
--      (all 18 are, as of 2026-10-11);
--   2. alter table reagents add constraint reagents_units_per_carton_whole
--        check (units_per_carton is null or (units_per_carton >= 1
--               and units_per_carton = trunc(units_per_carton))) not valid;
--   3. alter table reagents validate constraint reagents_units_per_carton_whole;
-- The count-line snapshot copies whatever the lot holds, so it needs no change.

-- ═══ [2/3] ADD_STOCK_COUNT_START_V2.sql — verbatim from commit f23bd4e (sha256 a3721f3c626b1b72) ═══
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

-- ═══ [3/3] ADD_PACKAGING_GUARDS.sql — verbatim from commit f23bd4e (sha256 80c35bdb7e3e2c66) ═══
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

-- ═══ In-transaction verification — any problem raises an error, which rolls
-- back EVERYTHING above (columns, constraints, functions, triggers). Nothing is
-- ever committed half-done, so the snapshot guard can't be left absent. ═══
do $verify$
declare
  problems text[] := '{}';
  line_guard text := pg_get_functiondef(to_regprocedure('public.inventory_count_items_guard_evidence()'));
  snap_guard text := pg_get_functiondef(to_regprocedure('public.inventory_count_items_guard_snapshot()'));
  start_def  text := pg_get_functiondef(to_regprocedure('public.stock_count_start(text, text)'));
begin
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'reagents' and column_name = 'pack_unit') <> 1 then problems := array_append(problems, 'reagents.pack_unit missing'); end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'inventory_count_items' and column_name in ('packaging_snapshot', 'pack_unit', 'units_per_carton')) <> 3 then problems := array_append(problems, 'count-line packaging columns missing'); end if;
  if (select count(*) from pg_constraint where conname in ('reagents_pack_unit_valid', 'inventory_count_items_packaging_snapshot_valid') and convalidated) <> 2 then problems := array_append(problems, 'packaging constraints missing'); end if;
  if (select count(*) from pg_trigger where tgname = 'inventory_count_items_snapshot_guard' and tgenabled <> 'D') <> 1 then problems := array_append(problems, 'snapshot guard trigger missing'); end if;
  if snap_guard is null or snap_guard not like '%bad := ''unit''%' or snap_guard not like '%bad := ''packaging_snapshot''%' or snap_guard not like '%bad := ''pack_unit''%' or snap_guard not like '%bad := ''units_per_carton''%' then problems := array_append(problems, 'snapshot guard function incomplete'); end if;
  if (select count(*) from pg_trigger where tgname = 'reagents_packaging_guard' and tgenabled <> 'D') <> 1 then problems := array_append(problems, 'lot packaging guard missing'); end if;
  if (select count(*) from pg_trigger where tgname in ('consumption_logs_evidence_guard', 'inventory_count_items_evidence_guard') and tgenabled <> 'D') <> 2 then problems := array_append(problems, 'Evidence Guard triggers missing'); end if;
  if line_guard is null or line_guard like '%packaging_snapshot%' or line_guard not like '%bad := ''counted_quantity''%' then problems := array_append(problems, 'Evidence Guard function not as before'); end if;
  if start_def is null or start_def not like '%packaging_snapshot, pack_unit, units_per_carton%' then problems := array_append(problems, 'stock_count_start is not v2'); end if;
  if (select count(*) from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname in ('reagents', 'inventory_count_items') and c.contype = 'c' and pg_get_constraintdef(c.oid) ~* 'trunc\(\s*units_per_carton|units_per_carton\s*>=?\s*1') <> 0 then problems := array_append(problems, 'unexpected whole-number constraint (deferred to U2d)'); end if;
  if (select count(*) from reagents where pack_unit is not null) <> 0 then problems := array_append(problems, 'a lot has a pack_unit (nothing may be backfilled)'); end if;
  if (select count(*) from inventory_count_items where packaging_snapshot is not null or pack_unit is not null or units_per_carton is not null) <> 0 then problems := array_append(problems, 'a count line has a snapshot (nothing may be inferred)'); end if;
  if (select count(*) from inventory_counts where status = 'in_progress') <> 0 then problems := array_append(problems, 'a Stock Count is open'); end if;
  if cardinality(problems) > 0 then
    raise exception 'U2a verification failed — nothing has been applied: %', array_to_string(problems, '; ');
  end if;
  raise notice 'U2a verified inside the transaction — committing';
end
$verify$;

commit;
