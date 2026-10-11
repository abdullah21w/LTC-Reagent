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
