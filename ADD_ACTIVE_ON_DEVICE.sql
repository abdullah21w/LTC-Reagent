-- Run this only if your reagents table doesn't have active_on_device yet.

alter table reagents add column if not exists active_on_device boolean not null default false;
