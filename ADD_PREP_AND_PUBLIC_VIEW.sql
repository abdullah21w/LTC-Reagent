-- Run this only if your project doesn't have these yet.

alter table reagent_presets add column if not exists prep_instructions text;

alter table app_config add column if not exists public_view_enabled boolean not null default false;
alter table app_config add column if not exists public_view_token text not null default '';
