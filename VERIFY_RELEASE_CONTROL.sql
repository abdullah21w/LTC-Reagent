-- Read-only check after ADD_RELEASE_CONTROL.sql. Changes nothing.
-- Rows 1–10 must say PASS; row 99 is the overall result; row 100 shows the
-- current state (information only).
with
guarded(t) as (values ('reagents'), ('consumption_logs'), ('inventory_counts'), ('inventory_count_items'), ('lot_to_lot_pending'),
                      ('low_stock_snoozes'), ('reagent_presets'), ('devices'), ('staff_accounts'), ('app_config'), ('audit_log'),
                      ('login_snapshots'), ('public_view_visits')),
owner_fns(f) as (values ('ltc_release_state'), ('ltc_release_change'), ('ltc_maintenance_on'), ('ltc_maintenance_off'),
                        ('ltc_release_open'), ('ltc_release_rollback'), ('ltc_enforcement_set')),
checks as (
  select 1 as ord, 'state row exists (exactly one)' as check_name,
         case when (select count(*) from app_release) = 1 then 'PASS' else 'FAIL' end as result
  union all
  select 2, 'statement guard on all 13 app tables (insert/update/delete/truncate), enabled',
         case when (select count(*) from guarded g join pg_trigger tr on tr.tgrelid = ('public.' || g.t)::regclass
                     where tr.tgname = 'zz_ltc_release_guard' and tr.tgenabled <> 'D') = 13 then 'PASS' else 'FAIL' end
  union all
  select 3, 'row guards on audit_log (insert) and app_config (update), enabled',
         case when (select count(*) from pg_trigger where tgname = 'zz_ltc_release_guard_row' and tgenabled <> 'D'
                     and tgrelid in ('public.audit_log'::regclass, 'public.app_config'::regclass)) = 2 then 'PASS' else 'FAIL' end
  union all
  select 4, 'anon/authenticated can read the state row but not change it',
         case when has_table_privilege('anon', 'public.app_release', 'select')
               and not has_table_privilege('anon', 'public.app_release', 'insert') and not has_table_privilege('anon', 'public.app_release', 'update')
               and not has_table_privilege('anon', 'public.app_release', 'delete') and not has_table_privilege('authenticated', 'public.app_release', 'update') then 'PASS' else 'FAIL' end
  union all
  select 5, 'anon/authenticated have no access to the audit trail or the builds seen',
         case when not has_table_privilege('anon', 'public.app_release_log', 'select') and not has_table_privilege('anon', 'public.app_release_log', 'insert')
               and not has_table_privilege('anon', 'public.app_release_seen', 'select') and not has_table_privilege('anon', 'public.app_release_seen', 'insert')
               and not has_table_privilege('authenticated', 'public.app_release_log', 'select') then 'PASS' else 'FAIL' end
  union all
  select 6, 'audit trail append-only (update/delete/truncate refused)',
         case when (select count(*) from pg_trigger where tgrelid = 'public.app_release_log'::regclass and tgname in ('app_release_log_append_only', 'app_release_log_no_truncate') and tgenabled <> 'D') = 2 then 'PASS' else 'FAIL' end
  union all
  select 7, 'owner functions exist and anon/authenticated cannot run them',
         case when (select count(*) from owner_fns o join pg_proc p on p.proname = o.f join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public') = 7
               and (select bool_and(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
                      from owner_fns o join pg_proc p on p.proname = o.f join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public') then 'PASS' else 'FAIL' end
  union all
  select 8, 'ltc_hello: anon may run it (reports the build, returns the state)',
         case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
                            where p.proname = 'ltc_hello' and p.prosecdef and has_function_privilege('anon', p.oid, 'execute')) then 'PASS' else 'FAIL' end
  union all
  select 9, 'guard functions run with the caller''s privileges (security invoker)',
         case when (select bool_and(not prosecdef) from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
                     where p.proname in ('ltc_release_guard', 'ltc_release_guard_audit', 'ltc_release_guard_config')) then 'PASS' else 'FAIL' end
  union all
  select 10, 'approved build is empty or one full commit id',
         case when (select approved_build is null or approved_build ~ '^[0-9a-f]{40}$' from app_release where id = 1) then 'PASS' else 'FAIL' end
)
select ord, check_name, result from checks
union all
select 99, 'OVERALL', case when (select count(*) from checks where result <> 'PASS') = 0 then 'PASS' else 'FAIL' end
union all
select 100, 'current state (info)', (select format('maintenance=%s enforce_build=%s approved_build=%s', maintenance::text, enforce_build::text, coalesce(approved_build, 'none')) from app_release where id = 1)
order by ord;
