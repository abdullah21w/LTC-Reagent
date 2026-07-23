-- Run this only if your reagents table doesn't have units_per_carton yet.

alter table reagents add column if not exists units_per_carton numeric;
