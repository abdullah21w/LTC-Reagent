-- Reagent Log — full schema. Run this once in a NEW Supabase project's SQL Editor.

create table if not exists reagents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  department text not null,
  item_type text not null default 'Reagent',
  device text not null default '',
  lot_number text not null,
  unit text not null,
  quantity_received numeric not null,
  current_quantity numeric not null,
  expiry_date date not null,
  date_added date not null default current_date,
  added_by text not null,
  low_stock_threshold numeric not null default 0,
  active_on_device boolean not null default false,
  -- Receiving inspection checklist (yes/no)
  intact_container boolean not null default true,
  complete_compound boolean not null default true,
  expiration_validity boolean not null default true,
  lot_matches_kit boolean not null default true,
  storage_condition_ok boolean not null default true,
  -- QC testing
  tested_by_qc boolean not null default false,
  receiving_notes text not null default '',
  inspection_notes text not null default '',
  deleted boolean not null default false,
  deleted_by text,
  deleted_at timestamptz,
  edited_by text,
  edited_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists consumption_logs (
  id uuid primary key default gen_random_uuid(),
  reagent_id uuid references reagents(id) on delete cascade,
  amount numeric not null,
  date date not null,
  used_by text not null,
  note text,
  tested_by_qc boolean not null default false,
  deleted boolean not null default false,
  deleted_by text,
  deleted_at timestamptz,
  edited_by text,
  edited_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists app_config (
  id int primary key default 1,
  owner_username text not null default '',
  owner_password text not null default '',
  low_stock_default_percent numeric not null default 15,
  expiry_warning_days int not null default 30,
  alert_email text not null default '',
  expiry_alert_days jsonb not null default '[3, 1]'::jsonb,
  departments jsonb not null default '["Chemistry","Hematology","Blood Bank","Microbiology"]'::jsonb
);

-- IMPORTANT: replace the CHANGE_ME placeholders below with your own owner
-- username/password BEFORE running this file. This is the ONLY built-in
-- login — every other account is created by the owner from Settings, with
-- custom permissions per account.
insert into app_config (id, owner_username, owner_password)
values (1, 'CHANGE_ME_owner_user', 'CHANGE_ME_owner_pass')
on conflict (id) do nothing;

create table if not exists reagent_presets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  department text not null,
  unit text not null default 'mL',
  created_at timestamptz default now()
);

create table if not exists staff_accounts (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password text not null,
  permissions jsonb not null default '{"dashboard":true,"reports":true,"charts":false,"settings":false,"receive":false,"log_use":false,"edit":false,"delete":false}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists devices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  department text not null,
  created_at timestamptz default now()
);

create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  entity text not null,
  description text not null,
  performed_by text not null,
  performed_at timestamptz not null default now()
);

-- Tracks the Lot-to-Lot verification step required on the Vitros when one lot
-- of a reagent runs out and staff move on to the next lot on the same device.
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

alter table reagents enable row level security;
alter table consumption_logs enable row level security;
alter table app_config enable row level security;
alter table reagent_presets enable row level security;
alter table staff_accounts enable row level security;
alter table audit_log enable row level security;
alter table devices enable row level security;
alter table lot_to_lot_pending enable row level security;

create policy "allow all reagents" on reagents for all using (true) with check (true);
create policy "allow all consumption_logs" on consumption_logs for all using (true) with check (true);
create policy "allow all app_config" on app_config for all using (true) with check (true);
create policy "allow all reagent_presets" on reagent_presets for all using (true) with check (true);
create policy "allow all staff_accounts" on staff_accounts for all using (true) with check (true);
create policy "allow all audit_log" on audit_log for all using (true) with check (true);
create policy "allow all devices" on devices for all using (true) with check (true);
create policy "allow all lot_to_lot_pending" on lot_to_lot_pending for all using (true) with check (true);

-- Note: this is an open (RLS "allow all") setup — fine for an internal lab tool
-- with no patient data. Anyone with the app link and Supabase keys can read/write.
