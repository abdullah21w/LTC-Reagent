-- Read-only check after MIGRATE_RECEIPT_CHOICES.sql. Changes nothing.
-- Rows 1–6 must say PASS; row 99 is the overall result; rows 100–101 are information.
with
con as (select pg_get_constraintdef(oid) def, convalidated from pg_constraint
         where conrelid = 'public.reagents'::regclass and conname = 'reagents_receipt_choices'),
checks as (
  select 1 as ord, 'columns device_choice and expiry_choice exist (text, nullable)' as check_name,
         case when (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'reagents'
                     and column_name in ('device_choice', 'expiry_choice') and data_type = 'text' and is_nullable = 'YES') = 2 then 'PASS' else 'FAIL' end as result
  union all
  select 2, 'check constraint reagents_receipt_choices exists and is validated (every existing row satisfies it)',
         case when (select count(*) from con where convalidated) = 1 then 'PASS' else 'FAIL' end
  union all
  select 3, 'the rule: legacy (both NULL) only before the cut-off; otherwise both choices, each matching its data',
         case when (select def from con) like '%device_choice IS NULL%expiry_choice IS NULL%created_at <%'
               and (select def from con) like '%''device''%''none''%' and (select def from con) like '%''date''%''none''%' then 'PASS' else 'FAIL' end
  union all
  select 4, 'no Lot has a choice that contradicts its data, or only one of the two choices',
         case when not exists (select 1 from public.reagents where
                 (device_choice is null) <> (expiry_choice is null)
                 or (device_choice is not null and ((device_choice = 'device') <> (btrim(coalesce(device, '')) <> '') or device_choice not in ('device', 'none')))
                 or (expiry_choice is not null and ((expiry_choice = 'date') <> (expiry_date is not null) or expiry_choice not in ('date', 'none'))))
              then 'PASS' else 'FAIL' end
  union all
  select 5, 'no INSERT trigger on reagents (Receive''s retry safety)',
         case when not exists (select 1 from pg_trigger where tgrelid = 'public.reagents'::regclass and not tgisinternal and (tgtype & 4) <> 0 and (tgtype & 1) = 1)
              then 'PASS' else 'FAIL' end
  union all
  select 6, 'the app (anon) may write the two new columns',
         case when has_column_privilege('anon', 'public.reagents', 'device_choice', 'insert') and has_column_privilege('anon', 'public.reagents', 'expiry_choice', 'insert')
               and has_column_privilege('anon', 'public.reagents', 'device_choice', 'update') and has_column_privilege('anon', 'public.reagents', 'expiry_choice', 'update')
              then 'PASS' else 'FAIL' end
)
select ord, check_name, result from checks
union all
select 99, 'OVERALL', case when (select bool_and(result = 'PASS') from checks) then 'PASS' else 'FAIL' end
union all
select 100, 'info: Lots — legacy (no choices) / with choices',
       (select count(*) filter (where device_choice is null) || ' / ' || count(*) filter (where device_choice is not null) from public.reagents)
union all
select 101, 'info: legacy cut-off (Lots created before it may stay without choices)',
       coalesce((select substring(def from 'created_at < ''([^'']+)''') from con), 'none')
order by ord;
