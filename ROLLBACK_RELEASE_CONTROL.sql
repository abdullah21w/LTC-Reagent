-- Rollback of ADD_RELEASE_CONTROL.sql: removes the guard and the release
-- functions. No inventory data is touched. app_release_log is KEPT (audit trail;
-- harmless without the rest). The app keeps working: it treats a missing release
-- state as "no release control".
--
-- Use only if the release control itself is faulty. To merely let people work
-- again, prefer:  select ltc_enforcement_set(false, '<reason>');  and/or
--                 select ltc_maintenance_off('<reason>');
do $$
declare t text;
begin
  foreach t in array array['reagents', 'consumption_logs', 'inventory_counts', 'inventory_count_items', 'lot_to_lot_pending',
                           'low_stock_snoozes', 'reagent_presets', 'devices', 'staff_accounts', 'app_config', 'audit_log',
                           'login_snapshots', 'public_view_visits'] loop
    execute format('drop trigger if exists zz_ltc_release_guard on public.%I', t);
  end loop;
end $$;
drop trigger if exists zz_ltc_release_guard_row on audit_log;
drop trigger if exists zz_ltc_release_guard_row on app_config;
drop function if exists ltc_release_guard();
drop function if exists ltc_release_guard_audit();
drop function if exists ltc_release_guard_config();
drop function if exists ltc_hello();
drop function if exists ltc_maintenance_on(text, text, interval);
drop function if exists ltc_maintenance_off(text, interval);
drop function if exists ltc_release_open(text, text, boolean, interval);
drop function if exists ltc_release_rollback(text, text, boolean, interval);
drop function if exists ltc_enforcement_set(boolean, text, interval);
drop function if exists ltc_release_change(text, text, boolean, text, boolean, text, interval);
drop function if exists ltc_release_state();
drop table if exists app_release_seen;
drop table if exists app_release;
