-- Run this only if your project doesn't have this table yet.

create table if not exists login_snapshots (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  critical_keys jsonb not null default '[]'::jsonb,
  low_stock_keys jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table login_snapshots enable row level security;
create policy "allow all login_snapshots" on login_snapshots for all using (true) with check (true);
