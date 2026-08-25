-- Adds physical inventory count ("stock take") support. A count session
-- snapshots the expected quantity of every active lot in scope, staff enter
-- what they actually counted (manually or after locating the lot via
-- barcode scan), and only mismatches surface for review/correction.
-- No frequency limit is enforced anywhere — start as many sessions as you
-- like, any time.

create table if not exists inventory_counts (
  id uuid primary key default gen_random_uuid(),
  department text,                          -- null = whole lab
  status text not null default 'in_progress', -- 'in_progress' | 'completed'
  started_by text not null,
  started_at timestamptz not null default now(),
  completed_by text,
  completed_at timestamptz
);

create table if not exists inventory_count_items (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references inventory_counts(id) on delete cascade,
  reagent_id uuid references reagents(id) on delete set null,
  -- Snapshot fields so the row still reads correctly even if the reagent
  -- lot is later edited or deleted.
  reagent_name text not null,
  lot_number text not null,
  department text not null,
  unit text not null,
  expected_quantity numeric not null,
  counted_quantity numeric,                 -- null until staff enters it
  resolved boolean not null default false,
  resolution_note text,
  created_at timestamptz not null default now()
);

alter table inventory_counts enable row level security;
alter table inventory_count_items enable row level security;

create policy "allow all inventory_counts" on inventory_counts for all using (true) with check (true);
create policy "allow all inventory_count_items" on inventory_count_items for all using (true) with check (true);

-- New "stock_count" permission for staff accounts — existing accounts get
-- it off by default so nobody unexpectedly gains a new capability; the
-- owner can grant it per employee from Settings.
update staff_accounts
set permissions = permissions || '{"stock_count": false}'::jsonb
where not (permissions ? 'stock_count');
