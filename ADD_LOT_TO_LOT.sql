-- Run this only if your project doesn't have the lot_to_lot_pending table yet.

create table if not exists lot_to_lot_pending (
  id uuid primary key default gen_random_uuid(),
  reagent_name text not null,
  device text not null,
  depleted_lot_number text not null,
  confirmed boolean not null default false,
  confirmed_by text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (reagent_name, device)
);

alter table lot_to_lot_pending enable row level security;
create policy "allow all lot_to_lot_pending" on lot_to_lot_pending for all using (true) with check (true);
