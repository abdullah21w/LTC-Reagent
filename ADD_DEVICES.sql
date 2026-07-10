-- Run this in your EXISTING Supabase project's SQL Editor.

alter table reagents add column if not exists device text not null default '';

create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  department text not null,
  created_at timestamptz default now()
);

alter table devices enable row level security;

create policy "allow all devices" on devices for all using (true) with check (true);
