-- U2a pre-check — READ ONLY (a single SELECT; it changes nothing).
-- Run in the Supabase SQL editor immediately before ADD_PACKAGING_FOUNDATION.sql.
-- Every row must show PASS; the five fingerprint rows are recorded, then must
-- be identical in VERIFY_PACKAGING.sql afterwards.
with
fp as (
  select 'audit_log' as tbl, count(*) as rows, md5(string_agg(row(action, description, entity, id, (performed_at at time zone 'UTC'), performed_by)::text, '|' order by id)) as business_fp from audit_log
  union all
  select 'consumption_logs', count(*), md5(string_agg(row(active_device_changed, trim_scale(amount), (created_at at time zone 'UTC'), date, deleted, (deleted_at at time zone 'UTC'), deleted_by, (edited_at at time zone 'UTC'), edited_by, id, note, previous_active_lot_id, reagent_id, tested_by_qc, used_by)::text, '|' order by id)) from consumption_logs
  union all
  select 'inventory_count_items', count(*), md5(string_agg(row(consumption_log_ids, count_id, trim_scale(counted_quantity), (created_at at time zone 'UTC'), department, trim_scale(expected_quantity), id, lot_number, reagent_id, reagent_name, resolution_note, resolved, unit)::text, '|' order by id)) from inventory_count_items
  union all
  select 'inventory_counts', count(*), md5(string_agg(row((completed_at at time zone 'UTC'), completed_by, department, id, (started_at at time zone 'UTC'), started_by, status)::text, '|' order by id)) from inventory_counts
  union all
  select 'reagents', count(*), md5(string_agg(row(active_on_device, added_by, complete_compound, (created_at at time zone 'UTC'), trim_scale(current_quantity), date_added, deleted, (deleted_at at time zone 'UTC'), deleted_by, department, device, discard_note, discard_reason, (edited_at at time zone 'UTC'), edited_by, expiration_validity, expiry_date, id, inspection_notes, intact_container, item_type, lot_matches_kit, lot_number, trim_scale(low_stock_threshold), name, trim_scale(quantity_received), receiving_notes, storage_condition_ok, tested_by_qc, unit, trim_scale(units_per_carton))::text, '|' order by id)) from reagents
),
checks(ord, check_name, actual, expected) as (
  select 1, 'open Stock Counts (must be 0 — maintenance window)', (select count(*) from inventory_counts where status = 'in_progress')::text, '0'
  union all select 2, 'Evidence Guard triggers present and enabled', (select count(*) from pg_trigger where tgname in ('consumption_logs_evidence_guard', 'inventory_count_items_evidence_guard') and tgenabled <> 'D')::text, '2'
  union all select 3, 'stock_count_start present (v1, no snapshot yet)', (select case when to_regprocedure('public.stock_count_start(text, text)') is null then 'missing' when pg_get_functiondef(to_regprocedure('public.stock_count_start(text, text)')) like '%packaging_snapshot%' then 'v2' else 'v1' end), 'v1'
  union all select 4, 'reagents.pack_unit not yet present', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'reagents' and column_name = 'pack_unit')::text, '0'
  union all select 5, 'count-line packaging columns not yet present', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'inventory_count_items' and column_name in ('packaging_snapshot', 'pack_unit', 'units_per_carton'))::text, '0'
  union all select 6, 'lot packaging guard and snapshot guard not yet present', (select count(*) from pg_trigger where tgname in ('reagents_packaging_guard', 'inventory_count_items_snapshot_guard'))::text, '0'
  union all select 7, 'lots with a blank unit', (select count(*) from reagents where btrim(unit) = '')::text, '0'
  union all select 8, 'units_per_carton values that are not a whole number ≥ 1 (informational; not enforced in U2a)', (select count(*) from reagents where units_per_carton is not null and (units_per_carton < 1 or units_per_carton <> trunc(units_per_carton)))::text, '0'
  union all select 31, 'fingerprint audit_log (record)', (select rows || ' ' || business_fp from fp where tbl = 'audit_log'), (select rows || ' ' || business_fp from fp where tbl = 'audit_log')
  union all select 32, 'fingerprint consumption_logs (record)', (select rows || ' ' || business_fp from fp where tbl = 'consumption_logs'), (select rows || ' ' || business_fp from fp where tbl = 'consumption_logs')
  union all select 33, 'fingerprint inventory_count_items (record)', (select rows || ' ' || business_fp from fp where tbl = 'inventory_count_items'), (select rows || ' ' || business_fp from fp where tbl = 'inventory_count_items')
  union all select 34, 'fingerprint inventory_counts (record)', (select rows || ' ' || business_fp from fp where tbl = 'inventory_counts'), (select rows || ' ' || business_fp from fp where tbl = 'inventory_counts')
  union all select 35, 'fingerprint reagents (record)', (select rows || ' ' || business_fp from fp where tbl = 'reagents'), (select rows || ' ' || business_fp from fp where tbl = 'reagents')
)
select ord, check_name, actual, expected, case when actual is not distinct from expected then 'PASS' else 'FAIL' end as result
from checks
union all
select 99, 'OVERALL', (select count(*) filter (where actual is not distinct from expected) || ' of ' || count(*) || ' pass' from checks), (select count(*) || ' of ' || count(*) || ' pass' from checks),
       case when (select bool_and(actual is not distinct from expected) from checks) then 'PASS' else 'FAIL' end
order by ord;
