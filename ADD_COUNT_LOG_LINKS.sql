-- Links each stock-count line to the consumption_logs rows it created when
-- resolved as "Log as unrecorded usage" (an array, since "Spread over a
-- range" creates several rows). This is what lets a completed count edit the
-- dates of exactly those entries later.
--
-- Counts resolved before this migration have no link; the app falls back to
-- matching them by reagent + "Unlogged (physical count)" + the count's time
-- window, and refuses to edit anything it can't match exactly.

alter table inventory_count_items
  add column if not exists consumption_log_ids uuid[] not null default '{}';
