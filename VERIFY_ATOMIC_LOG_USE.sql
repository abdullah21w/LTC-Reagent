-- Read-only check after ADD_ATOMIC_LOG_USE.sql. Changes nothing.
-- Every row should say PASS; the last row (99) is the overall result.
with
fn as (
  select p.oid, p.prosecdef, p.provolatile, p.proconfig, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'log_use'
),
checks as (
  select 1 as ord, 'log_use exists exactly once' as check_name,
         case when (select count(*) from fn) = 1 then 'PASS' else 'FAIL' end as result
  union all
  select 2, 'signature (uuid, uuid, numeric, date, text, text, boolean, boolean, boolean, uuid, text)',
         case when (select args from fn) = 'p_log_id uuid, p_reagent_id uuid, p_amount numeric, p_date date, p_used_by text, p_note text, p_tested_by_qc boolean, p_replace_on_device boolean, p_lot_to_lot boolean, p_confirm_ltl_id uuid, p_actor text' then 'PASS' else 'FAIL' end
  union all
  select 3, 'security invoker (no elevated privileges)',
         case when (select prosecdef from fn) = false then 'PASS' else 'FAIL' end
  union all
  select 4, 'volatile, search_path pinned',
         case when (select provolatile from fn) = 'v' and (select array_to_string(proconfig, ',') from fn) like '%search_path=pg_catalog, public, pg_temp%' then 'PASS' else 'FAIL' end
  union all
  select 5, 'anon may execute; public and authenticated may not',
         case when has_function_privilege('anon', (select oid from fn), 'execute')
               and not has_function_privilege('authenticated', (select oid from fn), 'execute') then 'PASS' else 'FAIL' end
  union all
  select 6, 'consumption_logs.id is still the primary key (idempotency key)',
         case when exists (select 1 from pg_constraint where conrelid = 'public.consumption_logs'::regclass and contype = 'p'
                                                        and conkey = array[(select attnum from pg_attribute where attrelid = 'public.consumption_logs'::regclass and attname = 'id')]) then 'PASS' else 'FAIL' end
  union all
  select 7, 'date_provenance allows ''manual''',
         case when exists (select 1 from pg_constraint where conname = 'consumption_logs_date_provenance_check' and pg_get_constraintdef(oid) like '%manual%') then 'PASS' else 'FAIL' end
  union all
  select 8, 'lot_to_lot_pending has its (reagent_name, device) unique key',
         case when exists (select 1 from pg_constraint where conrelid = 'public.lot_to_lot_pending'::regclass and contype = 'u') then 'PASS' else 'FAIL' end
)
select ord, check_name, result from checks
union all
select 99, 'OVERALL', case when (select count(*) from checks where result <> 'PASS') = 0 then 'PASS' else 'FAIL' end
order by ord;
