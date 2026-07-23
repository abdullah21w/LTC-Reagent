-- Run this only if your consumption_logs table doesn't have these columns yet.

alter table consumption_logs add column if not exists active_device_changed boolean not null default false;
alter table consumption_logs add column if not exists previous_active_lot_id uuid;
