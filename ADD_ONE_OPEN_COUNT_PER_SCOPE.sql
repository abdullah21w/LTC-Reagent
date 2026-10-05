-- Prevents conflicting in-progress stock counts. Run once in the Supabase SQL
-- editor (like the other ADD_*.sql files). Safe to re-run.
--
-- Rules, only while a count's status is 'in_progress' (completed and deleted
-- counts never conflict):
--   1. At most one open count per ordinary department ("Chemistry",
--      "Hematology", "All lab", …). Different departments may be open at once.
--   2. A Whole lab count (department IS NULL — every active lot in every
--      department) can't be open alongside ANY other open count, and only one
--      Whole lab count can be open.
--
-- How it holds under concurrency (two tabs / devices / users at once):
--   - The trigger below takes a transaction-scoped advisory lock on one fixed
--     key before checking. Two count starts can't check at the same time: the
--     second waits until the first transaction commits or rolls back, and its
--     check then runs as a new statement with a fresh snapshot (READ
--     COMMITTED, PostgREST's default), so it sees the first count and refuses.
--     Conflicts raise SQLSTATE P0001 with message 'stock_count_scope_conflict'.
--   - The two partial unique indexes enforce rule 1 and "one open Whole lab"
--     at the index level as well (SQLSTATE 23505), independently of the
--     trigger. NULL (Whole lab) gets its own index, so no placeholder value
--     can ever collide with a real department name.
--
-- Production had no open counts when this was written, so the indexes can be
-- created without touching any existing row.

create unique index if not exists inventory_counts_one_open_per_department
  on inventory_counts (department)
  where status = 'in_progress' and department is not null;

create unique index if not exists inventory_counts_one_open_whole_lab
  on inventory_counts ((true))
  where status = 'in_progress' and department is null;

create or replace function inventory_counts_check_open_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conflict record;
begin
  if new.status is distinct from 'in_progress' then
    return new;
  end if;

  -- Serialize every attempt to open a count (released at commit/rollback).
  perform pg_advisory_xact_lock(hashtext('inventory_counts:open_scope'));

  select id, department into conflict
  from inventory_counts
  where status = 'in_progress'
    and id <> new.id
    and (new.department is null or department is null or department = new.department)
  limit 1;

  if found then
    raise exception using
      errcode = 'P0001',
      message = 'stock_count_scope_conflict',
      detail = case
        when conflict.department is null then 'whole_lab_open'
        when new.department is null then 'department_open'
        else 'same_department_open'
      end,
      hint = conflict.id::text;
  end if;

  return new;
end;
$$;

drop trigger if exists inventory_counts_open_scope on inventory_counts;
create trigger inventory_counts_open_scope
  before insert or update of status, department on inventory_counts
  for each row execute function inventory_counts_check_open_scope();
