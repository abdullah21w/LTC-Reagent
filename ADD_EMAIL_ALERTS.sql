-- Run this only if your app_config table doesn't have these columns yet.

alter table app_config add column if not exists alert_email text not null default '';
alter table app_config add column if not exists expiry_alert_days jsonb not null default '[3, 1]'::jsonb;
