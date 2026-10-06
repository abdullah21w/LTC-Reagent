-- Stock Count readiness check — READ ONLY (a single SELECT; it changes nothing).
-- Run it in the Supabase SQL editor before deciding to start a real count.
-- It works on any schema state: checks that need the evidence columns only
-- run once those columns exist.
--
-- result:   ok          the requirement holds
--           BLOCKER     the next real Stock Count must not start
--           warning     needs attention, does not block (e.g. older history)
--           limitation  known, accepted gap in older history
-- The last row is the overall status:
--           READY | READY_WITH_HISTORICAL_WARNINGS | BLOCKED
--
-- Deliberately NOT checked here (see reconciliationEvidence.js validateEvidence
-- for the full per-row report): count windows and evidence-era rules, which
-- need the rollout date.
with
f as (
  select
    exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'consumption_logs' and column_name = 'date_provenance')
    and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'consumption_logs' and column_name = 'source_count_item_id')
    and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'inventory_count_items'
          and column_name in ('counted_at', 'counted_by', 'resolved_at', 'resolved_by', 'resolution_details')) = 5 as foundation
),
fn(name, sig) as (values
  ('stock_count_window', 'public.stock_count_window(uuid, uuid)'),
  ('stock_count_resolve', 'public.stock_count_resolve(uuid, text, text, numeric, numeric, date, jsonb)'),
  ('stock_count_redate', 'public.stock_count_redate(uuid, text, uuid[], text, date, date, date, jsonb)'),
  ('stock_count_start', 'public.stock_count_start(text, text)')
),
-- counts that need the evidence columns (run only when they exist)
n(key, v) as (
  select key, case when (select foundation from f) then (xpath('/row/n/text()', query_to_xml(q, false, true, '')))[1]::text::int end
  from (values
    ('new_count_rows_unlinked', $q$select count(*) as n from consumption_logs where date_provenance in ('count_exact', 'count_exact_default', 'count_spread_window') and source_count_item_id is null$q$),
    ('manual_prov_on_correction', $q$select count(*) as n from consumption_logs where date_provenance in ('manual', 'manual_spread') and (used_by = 'Unlogged (physical count)' or source_count_item_id is not null)$q$),
    ('count_prov_on_manual', $q$select count(*) as n from consumption_logs where (date_provenance like 'count%' or date_provenance = 'historical_unknown') and used_by <> 'Unlogged (physical count)' and source_count_item_id is null$q$),
    ('invalid_prov', $q$select count(*) as n from consumption_logs where date_provenance is not null and date_provenance not in ('manual', 'manual_spread', 'count_exact', 'count_exact_default', 'count_spread_window', 'count_redated', 'historical_unknown')$q$),
    ('link_lot_mismatch', $q$select count(*) as n from consumption_logs l join inventory_count_items i on i.id = l.source_count_item_id where l.reagent_id is distinct from i.reagent_id$q$),
    ('link_to_non_usage', $q$select count(*) as n from consumption_logs l join inventory_count_items i on i.id = l.source_count_item_id where not i.resolved or coalesce(i.resolution_note, '') not like 'Logged as usage%'$q$),
    ('unclassified_rows', $q$select count(*) as n from consumption_logs where date_provenance is null$q$),
    ('legacy_corrections_unlinked', $q$select count(*) as n from consumption_logs where used_by = 'Unlogged (physical count)' and source_count_item_id is null$q$),
    ('allocation_mismatch_lines', $q$select count(*) as n from inventory_count_items i where i.resolved and i.resolution_note like 'Logged as usage%' and i.counted_quantity < i.expected_quantity and coalesce((select sum(l.amount) from consumption_logs l where l.source_count_item_id = i.id and not l.deleted), 0) <> i.expected_quantity - i.counted_quantity$q$),
    ('corrections_before_received', $q$select count(*) as n from consumption_logs l join reagents r on r.id = l.reagent_id where (l.used_by = 'Unlogged (physical count)' or l.source_count_item_id is not null) and l.date < r.date_added$q$),
    ('historical_unknown_rows', $q$select count(*) as n from consumption_logs where date_provenance = 'historical_unknown'$q$),
    ('lines_without_modern_metadata', $q$select count(*) as n from inventory_count_items where resolved and resolved_at is null and resolved_by is null and resolution_details is null$q$)
  ) as x(key, q)
),
v as (select jsonb_object_agg(key, v) j from n),
checks(ord, area, check_name, result, detail) as (
  select 1, 'schema', 'Evidence Foundation columns (2 log + 5 count-line)', case when foundation then 'ok' else 'BLOCKER' end, case when foundation then 'present' else 'ADD_EVIDENCE_FOUNDATION.sql not applied' end from f
  union all
  select 2, 'schema', 'Provenance CHECK allows exactly the 7 values',
         case when coalesce((select pg_get_constraintdef(oid) like all (array['%''manual''%', '%''manual_spread''%', '%''count_exact''%', '%''count_exact_default''%', '%''count_spread_window''%', '%''count_redated''%', '%''historical_unknown''%'])
                             from pg_constraint where conname = 'consumption_logs_date_provenance_check'), false) then 'ok' else 'BLOCKER' end,
         coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname = 'consumption_logs_date_provenance_check'), 'constraint missing')
  union all
  select 2 + row_number() over (order by name), 'functions', name || ' present and callable by anon',
         case when to_regprocedure(sig) is not null and has_function_privilege('anon', to_regprocedure(sig), 'execute') then 'ok' else 'BLOCKER' end,
         case when to_regprocedure(sig) is null then 'missing' when not has_function_privilege('anon', to_regprocedure(sig), 'execute') then 'anon cannot execute' else 'present' end
  from fn
  union all
  select 7, 'guards', 'Open-count scope rule (trigger + 2 unique indexes)',
         case when exists (select 1 from pg_trigger where tgname = 'inventory_counts_open_scope' and tgenabled <> 'D')
               and to_regclass('public.inventory_counts_one_open_per_department') is not null
               and to_regclass('public.inventory_counts_one_open_whole_lab') is not null then 'ok' else 'BLOCKER' end, 'ADD_ONE_OPEN_COUNT_PER_SCOPE.sql'
  union all
  select 8, 'guards', 'Evidence Guard enabled (final B2 rules)',
         case when exists (select 1 from pg_trigger where tgname = 'consumption_logs_evidence_guard' and tgenabled <> 'D')
               and exists (select 1 from pg_trigger where tgname = 'inventory_count_items_evidence_guard' and tgenabled <> 'D')
               and coalesce(pg_get_functiondef(to_regprocedure('public.consumption_logs_guard_evidence()')) like '%bad := ''date''%', false)
               and coalesce(pg_get_functiondef(to_regprocedure('public.inventory_count_items_guard_evidence()')) like '%bad := ''counted_quantity''%', false)
              then 'ok' else 'BLOCKER' end, 'ADD_EVIDENCE_GUARD.sql (enable only once every device runs the new app)'
  union all
  select 9, 'state', 'No Stock Count currently open',
         case when (select count(*) from inventory_counts where status = 'in_progress') = 0 then 'ok' else 'BLOCKER' end,
         (select count(*) from inventory_counts where status = 'in_progress') || ' open'
  union all
  select 10 + o, 'structure', label,
         case when (select foundation from f) is not true then 'BLOCKER' when (j ->> key)::int = 0 then 'ok' else 'BLOCKER' end,
         coalesce((j ->> key) || ' rows', 'needs the Foundation')
  from v, (values (0, 'new_count_rows_unlinked', 'No new-style count correction without source_count_item_id'),
                  (1, 'manual_prov_on_correction', 'No manual provenance on a Stock Count correction'),
                  (2, 'count_prov_on_manual', 'No Stock Count provenance on a normal log'),
                  (3, 'invalid_prov', 'No unknown provenance value'),
                  (4, 'link_lot_mismatch', 'Every link joins a correction to a line of the same lot'),
                  (5, 'link_to_non_usage', 'Every link points to a line resolved as usage')) as k(o, key, label)
  union all
  select 20 + o, 'history', label,
         case when (j ->> key) is null then 'warning' when (j ->> key)::int = 0 then 'ok' else kind end,
         coalesce((j ->> key) || note, 'needs the Foundation')
  from v, (values (0, 'unclassified_rows', 'Logs without provenance (classify with the regenerated Batch D)', 'warning', ' rows'),
                  (1, 'legacy_corrections_unlinked', 'Stock Count corrections without a count-line link', 'warning', ' rows'),
                  (2, 'allocation_mismatch_lines', 'Usage lines whose linked corrections differ from the physical shortage (e.g. kit3 / 0314)', 'warning', ' lines — the physical count stays authoritative'),
                  (3, 'corrections_before_received', 'Corrections dated before their lot was received', 'warning', ' rows'),
                  (4, 'historical_unknown_rows', 'Historical corrections with unknown timing provenance', 'limitation', ' rows'),
                  (5, 'lines_without_modern_metadata', 'Resolved lines without resolved_at / resolved_by / resolution_details', 'limitation', ' lines (history: not reconstructed)')) as k(o, key, label, kind, note)
),
overall as (
  select 99 as ord, 'overall' as area, 'Readiness' as check_name,
         case when bool_or(result = 'BLOCKER') then 'BLOCKED'
              when bool_or(result in ('warning', 'limitation')) then 'READY_WITH_HISTORICAL_WARNINGS'
              else 'READY' end as result,
         count(*) filter (where result = 'BLOCKER') || ' blocker(s), ' || count(*) filter (where result = 'warning') || ' warning(s), ' || count(*) filter (where result = 'limitation') || ' limitation(s)' as detail
  from checks
)
select ord, area, check_name, result, detail from checks
union all
select ord, area, check_name, result, detail from overall
order by ord;
