-- Run this only if your app_config table doesn't have these columns yet.

alter table app_config add column if not exists backup_enabled boolean not null default false;
alter table app_config add column if not exists backup_email text not null default '';
alter table app_config add column if not exists backup_frequency_days int not null default 7;
alter table app_config add column if not exists backup_last_sent date;
