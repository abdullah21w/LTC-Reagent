-- U2a verification — READ ONLY (a single SELECT; it changes nothing).
-- Run in the Supabase SQL editor right after ADD_PACKAGING_GUARDS.sql (before
-- any new Stock Count is started). Every row must show PASS, and the five
-- fingerprint rows must equal those recorded by PRECHECK_PACKAGING.sql.
-- After ROLLBACK_PACKAGING.sql exactly checks 6, 10 and 11 fail (lot guard and
-- start v2 removed); check 9 — the permanent snapshot guard — must still PASS.
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
fdef as (
  select
    pg_get_functiondef(to_regprocedure('public.stock_count_start(text, text)')) as start_def,
    pg_get_functiondef(to_regprocedure('public.inventory_count_items_guard_evidence()')) as line_guard_def,
    pg_get_functiondef(to_regprocedure('public.inventory_count_items_guard_snapshot()')) as snapshot_guard_def,
    to_regprocedure('public.reagents_guard_packaging()') as lot_guard_fn
),
checks(ord, check_name, actual, expected) as (
  select 1, 'reagents.pack_unit present', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'reagents' and column_name = 'pack_unit')::text, '1'
  union all select 2, 'count-line packaging columns present (packaging_snapshot, pack_unit, units_per_carton)', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'inventory_count_items' and column_name in ('packaging_snapshot', 'pack_unit', 'units_per_carton'))::text, '3'
  union all select 3, 'constraint reagents_pack_unit_valid present and validated', (select count(*) from pg_constraint where conname = 'reagents_pack_unit_valid' and convalidated)::text, '1'
  union all select 4, 'constraint inventory_count_items_packaging_snapshot_valid present and validated', (select count(*) from pg_constraint where conname = 'inventory_count_items_packaging_snapshot_valid' and convalidated)::text, '1'
  union all select 5, 'no whole-number check on units_per_carton yet (deferred to U2d)', (select count(*) from pg_constraint c join pg_class t on t.oid = c.conrelid where t.relname in ('reagents', 'inventory_count_items') and c.contype = 'c' and pg_get_constraintdef(c.oid) ~* 'trunc\(\s*units_per_carton|units_per_carton\s*>=?\s*1|units_per_carton\s*%')::text, '0'
  union all select 6, 'lot packaging guard trigger present and enabled', (select count(*) from pg_trigger where tgname = 'reagents_packaging_guard' and tgenabled <> 'D')::text, '1'
  union all select 7, 'Evidence Guard triggers still present and enabled', (select count(*) from pg_trigger where tgname in ('consumption_logs_evidence_guard', 'inventory_count_items_evidence_guard') and tgenabled <> 'D')::text, '2'
  union all select 8, 'Evidence Guard count-line function untouched by U2a (every existing rule, no packaging rule)', (select (line_guard_def like '%bad := ''resolution_details''%' and line_guard_def like '%bad := ''resolved''%' and line_guard_def like '%bad := ''counted_quantity''%' and line_guard_def like '%bad := ''counted_by''%' and line_guard_def not like '%packaging_snapshot%')::text from fdef), 'true'
  union all select 9, 'permanent snapshot guard present and enabled; protects unit, packaging_snapshot, pack_unit, units_per_carton', (select ((select count(*) from pg_trigger where tgname = 'inventory_count_items_snapshot_guard' and tgenabled <> 'D') = 1 and snapshot_guard_def like '%bad := ''unit''%' and snapshot_guard_def like '%bad := ''packaging_snapshot''%' and snapshot_guard_def like '%bad := ''pack_unit''%' and snapshot_guard_def like '%bad := ''units_per_carton''%')::text from fdef), 'true'
  union all select 10, 'lot packaging guard function present', (select (lot_guard_fn is not null)::text from fdef), 'true'
  union all select 11, 'stock_count_start is v2 (stores the packaging snapshot)', (select (start_def like '%packaging_snapshot, pack_unit, units_per_carton%')::text from fdef), 'true'
  union all select 12, 'stock_count_start still SECURITY INVOKER, anon only', (select (not p.prosecdef and has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))::text from pg_proc p where p.oid = to_regprocedure('public.stock_count_start(text, text)')), 'true'
  union all select 13, 'no lot was given a pack_unit (nothing backfilled)', (select count(*) from reagents where pack_unit is not null)::text, '0'
  union all select 14, 'every existing count line is a legacy line (no snapshot inferred)', (select count(*) from inventory_count_items where packaging_snapshot is not null or pack_unit is not null or units_per_carton is not null)::text, '0'
  union all select 15, 'open Stock Counts', (select count(*) from inventory_counts where status = 'in_progress')::text, '0'
  union all select 31, 'fingerprint audit_log (must equal the pre-check)', (select rows || ' ' || business_fp from fp where tbl = 'audit_log'), (select rows || ' ' || business_fp from fp where tbl = 'audit_log')
  union all select 32, 'fingerprint consumption_logs (must equal the pre-check)', (select rows || ' ' || business_fp from fp where tbl = 'consumption_logs'), (select rows || ' ' || business_fp from fp where tbl = 'consumption_logs')
  union all select 33, 'fingerprint inventory_count_items (must equal the pre-check)', (select rows || ' ' || business_fp from fp where tbl = 'inventory_count_items'), (select rows || ' ' || business_fp from fp where tbl = 'inventory_count_items')
  union all select 34, 'fingerprint inventory_counts (must equal the pre-check)', (select rows || ' ' || business_fp from fp where tbl = 'inventory_counts'), (select rows || ' ' || business_fp from fp where tbl = 'inventory_counts')
  union all select 35, 'fingerprint reagents (must equal the pre-check)', (select rows || ' ' || business_fp from fp where tbl = 'reagents'), (select rows || ' ' || business_fp from fp where tbl = 'reagents')
)
select ord, check_name, actual, expected, case when actual is not distinct from expected then 'PASS' else 'FAIL' end as result
from checks
union all
select 99, 'OVERALL', (select count(*) filter (where actual is not distinct from expected) || ' of ' || count(*) || ' pass' from checks), (select count(*) || ' of ' || count(*) || ' pass' from checks),
       case when (select bool_and(actual is not distinct from expected) from checks) then 'PASS' else 'FAIL' end
order by ord;
