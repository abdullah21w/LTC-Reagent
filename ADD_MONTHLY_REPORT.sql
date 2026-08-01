-- Run this only if your app_config table doesn't have these columns yet.

alter table app_config add column if not exists monthly_report_enabled boolean not null default false;
alter table app_config add column if not exists monthly_report_email text not null default '';
alter table app_config add column if not exists monthly_report_last_sent text;
