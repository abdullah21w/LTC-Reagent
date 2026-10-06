-- Evidence foundation for Stock Count reconciliation (part 1 of 2: schema).
-- Run once in the Supabase SQL editor. Safe to re-run. Additive only: every
-- new column is nullable, existing rows keep NULL, no business value changes,
-- and the current app keeps working because it never writes these columns.
--
-- consumption_logs
--   source_count_item_id  the Stock Count line that created this correction
--                         log. Survives date edits (replacement rows carry the
--                         same link). Becomes NULL only if that line is deleted
--                         (an in-progress count deleted) — the log itself stays.
--   date_provenance       how THIS row's date was chosen. Only 'manual' is
--                         trusted as real timing; NULL = not yet classified.
--                           manual               logged by hand on its usage date
--                           manual_spread        manual quantity, dates spread over
--                                                a range by the log editor (estimated)
--                           count_exact          \
--                           count_exact_default   | Stock Count corrections
--                           count_spread_window   | (set by the atomic functions)
--                           count_redated        /
--                           historical_unknown   older row, provenance not recoverable
--
-- inventory_count_items
--   counted_at / counted_by     when / by whom the stored physical quantity
--                               was entered (latest entry; NULL if uncounted
--                               or unknown — never invented for history).
--   resolved_at / resolved_by   when / by whom the discrepancy was resolved.
--   resolution_details          write-once audit snapshot of what the
--                               reconciliation knew and decided at that moment.
--                               Never the source of current truth.
--
-- Write-once rules are enforced separately by ADD_EVIDENCE_GUARD.sql, which
-- must be applied only after the app version that stops the generic log
-- editor from changing count-derived logs is live.

alter table consumption_logs
  add column if not exists source_count_item_id uuid null
    references inventory_count_items(id) on delete set null;

alter table consumption_logs
  add column if not exists date_provenance text null;

-- Dropped and re-added so a re-run always ends with exactly this list.
alter table consumption_logs drop constraint if exists consumption_logs_date_provenance_check;
alter table consumption_logs
  add constraint consumption_logs_date_provenance_check
  check (date_provenance is null or date_provenance in (
    'manual', 'manual_spread', 'count_exact', 'count_exact_default', 'count_spread_window', 'count_redated', 'historical_unknown'
  ));

create index if not exists consumption_logs_source_count_item_idx
  on consumption_logs (source_count_item_id)
  where source_count_item_id is not null;

alter table inventory_count_items
  add column if not exists counted_at timestamptz null,
  add column if not exists counted_by text null,
  add column if not exists resolved_at timestamptz null,
  add column if not exists resolved_by text null,
  add column if not exists resolution_details jsonb null;
