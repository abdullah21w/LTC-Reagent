-- Run this only if your reagents table doesn't have these columns yet.

alter table reagents add column if not exists discard_reason text;
alter table reagents add column if not exists discard_note text;
