-- Run this only if your app_config table doesn't have expiry_warning_days yet
-- (i.e. you ran supabase_schema.sql before this setting existed).

alter table app_config add column if not exists expiry_warning_days int not null default 30;
