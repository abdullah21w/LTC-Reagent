-- Read-only check after ADD_ATOMIC_LOG_EDIT.sql. Changes nothing.
-- Every row should say PASS; the last row (99) is the overall result.
with
fn as (
  select p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('log_edit', 'log_undo', 'log_use')
),
checks as (
  select 1 as ord, 'log_edit and log_undo exist exactly once each' as check_name,
         case when (select count(*) from fn where proname = 'log_edit') = 1 and (select count(*) from fn where proname = 'log_undo') = 1 then 'PASS' else 'FAIL' end as result
  union all
  select 2, 'log_edit signature',
         case when (select args from fn where proname = 'log_edit') = 'p_request_id uuid, p_log_id uuid, p_seen_amount numeric, p_seen_date date, p_seen_used_by text, p_seen_note text, p_seen_tested_by_qc boolean, p_amount numeric, p_date date, p_used_by text, p_note text, p_tested_by_qc boolean, p_actor text' then 'PASS' else 'FAIL' end
  union all
  select 3, 'log_undo signature',
         case when (select args from fn where proname = 'log_undo') = 'p_request_id uuid, p_log_id uuid, p_seen_amount numeric, p_seen_date date, p_actor text' then 'PASS' else 'FAIL' end
  union all
  select 4, 'both security invoker, volatile, search_path pinned',
         case when (select bool_and(not prosecdef and provolatile = 'v' and array_to_string(proconfig, ',') like '%search_path=pg_catalog, public, pg_temp%') from fn where proname in ('log_edit', 'log_undo')) then 'PASS' else 'FAIL' end
  union all
  select 5, 'anon may execute both; authenticated may not',
         case when (select bool_and(has_function_privilege('anon', oid, 'execute') and not has_function_privilege('authenticated', oid, 'execute')) from fn where proname in ('log_edit', 'log_undo')) then 'PASS' else 'FAIL' end
  union all
  select 6, 'log_use present (same locking order; apply ADD_ATOMIC_LOG_USE.sql first)',
         case when (select count(*) from fn where proname = 'log_use') = 1 then 'PASS' else 'FAIL' end
  union all
  select 7, 'audit_log.id is a uuid primary key (request ids of edits and undos)',
         case when exists (select 1 from pg_constraint where conrelid = 'public.audit_log'::regclass and contype = 'p')
               and (select atttypid = 'uuid'::regtype from pg_attribute where attrelid = 'public.audit_log'::regclass and attname = 'id') then 'PASS' else 'FAIL' end
  union all
  select 8, 'consumption_logs evidence guard present (count-derived logs stay protected)',
         case when exists (select 1 from pg_trigger where tgname = 'consumption_logs_evidence_guard' and tgenabled <> 'D') then 'PASS' else 'FAIL' end
)
select ord, check_name, result from checks
union all
select 99, 'OVERALL', case when (select count(*) from checks where result <> 'PASS') = 0 then 'PASS' else 'FAIL' end
order by ord;
