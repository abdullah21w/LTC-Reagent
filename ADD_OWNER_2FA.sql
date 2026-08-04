-- Run this only if your app_config table doesn't have these columns yet.

alter table app_config add column if not exists owner_2fa_enabled boolean not null default false;
alter table app_config add column if not exists owner_2fa_email text not null default '';
alter table app_config add column if not exists owner_2fa_code text;
alter table app_config add column if not exists owner_2fa_code_expires timestamptz;
