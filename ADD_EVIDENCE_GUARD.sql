-- Evidence foundation for Stock Count reconciliation (part 2 of 2: guards).
-- Requires ADD_EVIDENCE_FOUNDATION.sql. Safe to re-run.
--
-- APPLY ONLY AFTER the app version that keeps the generic log editor / undo
-- away from count-derived logs is live. Older app versions update the lot's
-- stock BEFORE updating the log, so a refusal here would leave that stock
-- change behind without the matching log change.
--
-- consumption_logs — a row is count-derived when it is linked to a count line
-- (source_count_item_id) or written as a Stock Count correction (used_by).
--   * count-derived rows: amount, reagent_id, used_by, deleted and date can't
--     change. Edit dates (stock_count_redate) inserts replacement rows and
--     deletes the old ones in one transaction, which stays allowed.
--   * every row: source_count_item_id and date_provenance are write-once —
--     NULL → value is allowed; value → other value or NULL is refused. The one
--     exception is the foreign key's own ON DELETE SET NULL, which runs only
--     after the linked count line no longer exists.
-- inventory_count_items
--   * resolution_details, resolved_at, resolved_by are write-once (NULL → value
--     allowed; any later change, including back to NULL, refused).
--   * a resolved line stays resolved (true → false refused; nothing reopens one).
--   * a resolved line's physical count is final: counted_quantity can't change;
--     counted_at / counted_by can't change or be cleared (NULL → value stays
--     allowed, for recording history that was never captured).
--   * unresolved lines, and every other column, stay freely updatable.
--
-- UPDATE only. Hard DELETE is not guarded here: Edit dates removes replaced
-- correction rows, and deleting an in-progress count cascades to its lines.
-- The app refuses generic purge of count-derived rows; a direct DELETE through
-- the API is not prevented by this file.
--
-- Refusals raise SQLSTATE P0001 with message 'evidence_field_protected' and
-- the column name in DETAIL. Comparisons are NULL-safe (IS DISTINCT FROM).

create or replace function consumption_logs_guard_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bad text := null;
begin
  if old.source_count_item_id is not null or old.used_by = 'Unlogged (physical count)' then
    if new.amount is distinct from old.amount then bad := 'amount';
    elsif new.reagent_id is distinct from old.reagent_id then bad := 'reagent_id';
    elsif new.used_by is distinct from old.used_by then bad := 'used_by';
    elsif new.deleted is distinct from old.deleted then bad := 'deleted';
    elsif new.date is distinct from old.date then bad := 'date';
    end if;
  end if;

  if bad is null and old.source_count_item_id is not null
     and new.source_count_item_id is distinct from old.source_count_item_id then
    -- Allowed only as the FK's ON DELETE SET NULL (the linked line is gone).
    if new.source_count_item_id is not null
       or exists (select 1 from inventory_count_items where id = old.source_count_item_id) then
      bad := 'source_count_item_id';
    end if;
  end if;

  if bad is null and old.date_provenance is not null
     and new.date_provenance is distinct from old.date_provenance then
    bad := 'date_provenance';
  end if;

  if bad is not null then
    raise exception using errcode = 'P0001', message = 'evidence_field_protected', detail = bad, hint = old.id::text;
  end if;
  return new;
end;
$$;

drop trigger if exists consumption_logs_evidence_guard on consumption_logs;
create trigger consumption_logs_evidence_guard
  before update on consumption_logs
  for each row execute function consumption_logs_guard_evidence();

create or replace function inventory_count_items_guard_evidence()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  bad text := null;
begin
  if old.resolution_details is not null and new.resolution_details is distinct from old.resolution_details then bad := 'resolution_details';
  elsif old.resolved_at is not null and new.resolved_at is distinct from old.resolved_at then bad := 'resolved_at';
  elsif old.resolved_by is not null and new.resolved_by is distinct from old.resolved_by then bad := 'resolved_by';
  elsif old.resolved and new.resolved is distinct from old.resolved then bad := 'resolved';
  elsif old.resolved and new.counted_quantity is distinct from old.counted_quantity then bad := 'counted_quantity';
  elsif old.resolved and old.counted_at is not null and new.counted_at is distinct from old.counted_at then bad := 'counted_at';
  elsif old.resolved and old.counted_by is not null and new.counted_by is distinct from old.counted_by then bad := 'counted_by';
  end if;
  if bad is not null then
    raise exception using errcode = 'P0001', message = 'evidence_field_protected', detail = bad, hint = old.id::text;
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_count_items_evidence_guard on inventory_count_items;
create trigger inventory_count_items_evidence_guard
  before update on inventory_count_items
  for each row execute function inventory_count_items_guard_evidence();
