-- Run this only if your project doesn't have these yet.

alter table app_config add column if not exists reorder_coverage_days int not null default 30;

create table if not exists low_stock_snoozes (
  id uuid primary key default gen_random_uuid(),
  reagent_name text not null,
  device text not null,
  snoozed_until date not null,
  snoozed_by text not null,
  created_at timestamptz not null default now(),
  unique (reagent_name, device)
);

alter table low_stock_snoozes enable row level security;
create policy "allow all low_stock_snoozes" on low_stock_snoozes for all using (true) with check (true);
