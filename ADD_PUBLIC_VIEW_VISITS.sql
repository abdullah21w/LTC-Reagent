-- Run this only if your project doesn't have this table yet.

create table if not exists public_view_visits (
  id uuid primary key default gen_random_uuid(),
  viewed_at timestamptz not null default now()
);

alter table public_view_visits enable row level security;
create policy "allow all public_view_visits" on public_view_visits for all using (true) with check (true);
