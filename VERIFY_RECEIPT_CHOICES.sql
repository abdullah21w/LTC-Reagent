-- Read-only check after MIGRATE_RECEIPT_CHOICES.sql. Changes nothing.
-- Rows 1–8 must say PASS; row 99 is the overall result; rows 100–102 are information.
with
con as (select pg_get_constraintdef(oid) def, convalidated from pg_constraint
         where conrelid = 'public.reagents'::regclass and conname = 'reagents_receipt_choices'),
seq as (select pg_get_serial_sequence('public.reagents', 'receipt_seq') name),
checks as (
  select 1 as ord, 'columns device_choice and expiry_choice exist (text, nullable)' as check_name,
         case when (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'reagents'
                     and column_name in ('device_choice', 'expiry_choice') and data_type = 'text' and is_nullable = 'YES') = 2 then 'PASS' else 'FAIL' end as result
  union all
  select 2, 'receipt_seq is a GENERATED ALWAYS identity column (the app can''t set or change it)',
         case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'reagents'
                            and column_name = 'receipt_seq' and is_identity = 'YES' and identity_generation = 'ALWAYS') then 'PASS' else 'FAIL' end
  union all
  select 3, 'its sequence is closed to PUBLIC / anon / authenticated (no setval / nextval)',
         case when (select name from seq) is not null
               and not has_sequence_privilege('anon', (select name from seq), 'usage') and not has_sequence_privilege('anon', (select name from seq), 'update')
               and not has_sequence_privilege('authenticated', (select name from seq), 'usage') and not has_sequence_privilege('authenticated', (select name from seq), 'update')
               and not exists (select 1 from pg_class c, aclexplode(c.relacl) a where c.oid = (select name from seq)::regclass and a.grantee = 0)
              then 'PASS' else 'FAIL' end
  union all
  select 4, 'check constraint reagents_receipt_choices exists and is validated (every existing row satisfies it)',
         case when (select count(*) from con where convalidated) = 1 then 'PASS' else 'FAIL' end
  union all
  select 5, 'the rule: legacy (both choices NULL) only up to a fixed receipt_seq cut-off; otherwise both choices, each matching its data',
         case when (select def from con) ~ 'device_choice IS NULL.*expiry_choice IS NULL.*receipt_seq <= [0-9]+'
               and (select def from con) not like '%created_at%'
               and (select def from con) like '%''device''%''none''%' and (select def from con) like '%''date''%''none''%' then 'PASS' else 'FAIL' end
  union all
  select 6, 'no Lot has a choice that contradicts its data, or only one of the two choices',
         case when not exists (select 1 from public.reagents where
                 (device_choice is null) <> (expiry_choice is null)
                 or (device_choice is not null and ((device_choice = 'device') <> (btrim(coalesce(device, '')) <> '') or device_choice not in ('device', 'none')))
                 or (expiry_choice is not null and ((expiry_choice = 'date') <> (expiry_date is not null) or expiry_choice not in ('date', 'none'))))
              then 'PASS' else 'FAIL' end
  union all
  select 7, 'no INSERT trigger on reagents (row level — Receive''s retry safety)',
         case when not exists (select 1 from pg_trigger where tgrelid = 'public.reagents'::regclass and not tgisinternal and (tgtype & 4) <> 0 and (tgtype & 1) = 1)
              then 'PASS' else 'FAIL' end
  union all
  select 8, 'the app (anon) may write the two choice columns',
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
select 101, 'info: legacy cut-off (Lots numbered up to it may stay without choices) / highest number now',
       coalesce((select substring(def from 'receipt_seq <= ([0-9]+)') from con), 'none') || ' / '
       || coalesce((select max(receipt_seq)::text from public.reagents), 'none')
union all
select 102, 'info: pg_graphql installed (if yes: re-assess this rule on Staging — see the migration''s note)',
       case when exists (select 1 from pg_extension where extname = 'pg_graphql') then 'YES — re-assess' else 'no' end
order by ord;
