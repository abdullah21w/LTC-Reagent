-- Release control: owner-controlled maintenance mode + forced updates, enforced
-- in the database. Safe to re-run. Applying it changes nothing for the app:
-- maintenance starts OFF and build enforcement starts OFF.
--
-- Rollout: this file → VERIFY_RELEASE_CONTROL.sql → deploy the app that sends its
-- build id → the owner checks the build was seen → ltc_maintenance_on /
-- ltc_release_open (see RELEASE_RUNBOOK.md). Rollback: ROLLBACK_RELEASE_CONTROL.sql.
--
-- How it works
--   * Every write the app makes (anon role, or authenticated) — direct table
--     writes AND writes inside the database functions (log_use, log_edit,
--     log_undo, stock_count_*) — passes a statement-level trigger on each of the
--     13 tables the app writes. It refuses:
--       ltc_maintenance       while maintenance is ON (a few non-inventory
--                             exemptions below), and
--       ltc_outdated_client   while enforcement is ON and the request's
--                             x-ltc-build header is missing or not the ONE
--                             approved build (old tabs send no header at all).
--     Statement-level: a refused write fails even if it would touch no row, so
--     nothing is ever filtered silently. TRUNCATE is covered too.
--   * Only the owner (postgres, in the SQL Editor), supabase_admin and the
--     server key (service_role) are not checked — every other role is (an
--     allowlist: an unexpected role is blocked, not let through). They can
--     always repair data, even during maintenance.
--   * Clean boundary: each guarded write takes a SHARED transaction-level advisory
--     lock; every owner change takes the EXCLUSIVE one. Switching maintenance on
--     (or changing the approved build) therefore waits until every in-flight app
--     transaction has committed or rolled back — each completes whole or not at
--     all — and every write after the switch is refused. The guard never WAITS
--     for its lock: while an owner change holds or waits for the exclusive lock,
--     a NEW app transaction is refused at once (it may already hold row locks,
--     and waiting could deadlock); a transaction that already holds the shared
--     lock keeps it and finishes.
--   * A build reported by ltc_hello is NOT proof of a deployment (anyone with
--     the public key can report any id). Approving a build therefore also needs
--     the owner's explicit confirmation (p_deployment_verified => true) after
--     checking Vercel shows the deployment Ready AND the live site's
--     /version.json shows this commit. "Reported" only catches typos.
--   * Only the owner can change the state: the app's roles can read the state
--     row but cannot write it, cannot read the audit trail, and cannot run the
--     owner functions. app_release_log is append-only for everyone.
--
-- Maintenance exemptions (version enforcement still applies to all of them):
--   audit_log INSERT              only sign-in entries (action 'login', entity 'user')
--   app_config UPDATE             only the bookkeeping columns owner_2fa_code,
--                                 owner_2fa_code_expires, backup_last_sent,
--                                 monthly_report_last_sent (owner 2FA sign-in and
--                                 the e-mail jobs); any other column is refused
--   login_snapshots INSERT, public_view_visits INSERT   (sign-in / visit records)
--   None of them touches inventory, and none can change the release state.

-- ── State, audit trail, builds seen ──
create table if not exists app_release (
  id smallint primary key default 1 check (id = 1),
  maintenance boolean not null default false,
  maintenance_message text not null default '',
  enforce_build boolean not null default false,
  approved_build text null check (approved_build is null or approved_build ~ '^[0-9a-f]{40}$'),
  changed_at timestamptz not null default now(),
  changed_by text not null default session_user
);
insert into app_release (id) values (1) on conflict (id) do nothing;

create table if not exists app_release_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  action text not null,
  approved_build text null,
  previous_build text null,
  maintenance boolean not null,
  enforce_build boolean not null,
  reason text not null,
  db_user text not null default session_user
);

create table if not exists app_release_seen (
  build text primary key check (build ~ '^[0-9a-f]{40}$'),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  hits bigint not null default 1
);

-- The app's roles: read the state row only. (Supabase's default privileges give
-- new tables to anon/authenticated, so everything is revoked first.)
revoke all on app_release, app_release_log, app_release_seen from public, anon, authenticated;
revoke all on sequence app_release_log_id_seq from public, anon, authenticated;
grant select on app_release to anon, authenticated;
alter table app_release enable row level security;
alter table app_release_log enable row level security;
alter table app_release_seen enable row level security;
drop policy if exists "read release state" on app_release;
create policy "read release state" on app_release for select to anon, authenticated using (true);

-- The audit trail can't be changed or deleted, by anyone.
create or replace function app_release_log_append_only()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  raise exception using errcode = 'P0001', message = 'app_release_log is append-only';
end;
$$;
drop trigger if exists app_release_log_append_only on app_release_log;
create trigger app_release_log_append_only before update or delete on app_release_log
  for each row execute function app_release_log_append_only();
drop trigger if exists app_release_log_no_truncate on app_release_log;
create trigger app_release_log_no_truncate before truncate on app_release_log
  for each statement execute function app_release_log_append_only();

-- ── The guard ──
create or replace function ltc_release_guard()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_maint boolean;
  v_msg text;
  v_enforce boolean;
  v_approved text;
  v_headers text;
  v_build text;
begin
  -- Only the owner, supabase_admin and the server key are never blocked.
  if current_user in ('postgres', 'supabase_admin', 'service_role') then return null; end if;
  -- Shared with every other app write; exclusive for owner changes (see above).
  -- Never wait: while an owner change holds or waits for the exclusive lock, a
  -- new app transaction is refused at once; one that already holds it keeps it.
  if not pg_try_advisory_xact_lock_shared(7401000001) then
    raise exception using errcode = 'P0001', message = 'ltc_maintenance', detail = 'A maintenance or release change is in progress. Try again in a moment.';
  end if;
  select maintenance, maintenance_message, enforce_build, approved_build
    into v_maint, v_msg, v_enforce, v_approved
    from public.app_release where id = 1;
  if not found then
    raise exception using errcode = 'P0001', message = 'ltc_release_missing';
  end if;
  if v_maint and not ((tg_table_name::text, tg_op::text) in (('audit_log', 'INSERT'), ('app_config', 'UPDATE'), ('login_snapshots', 'INSERT'), ('public_view_visits', 'INSERT'))) then
    raise exception using errcode = 'P0001', message = 'ltc_maintenance', detail = v_msg;
  end if;
  if v_enforce then
    v_headers := current_setting('request.headers', true);
    begin
      v_build := nullif(btrim((nullif(v_headers, '')::json) ->> 'x-ltc-build'), '');
    exception when others then
      v_build := null;
    end;
    if v_build is distinct from v_approved then
      raise exception using errcode = 'P0001', message = 'ltc_outdated_client', detail = coalesce(v_build, 'none');
    end if;
  end if;
  return null;
end;
$$;

-- Row-level checks for the two exemptions that depend on the row.
create or replace function ltc_release_guard_audit()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') then return new; end if;
  if (select maintenance from public.app_release where id = 1)
     and not (new.action = 'login' and new.entity = 'user') then
    raise exception using errcode = 'P0001', message = 'ltc_maintenance';
  end if;
  return new;
end;
$$;

create or replace function ltc_release_guard_config()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') then return new; end if;
  if (select maintenance from public.app_release where id = 1)
     and (to_jsonb(new) - array['owner_2fa_code', 'owner_2fa_code_expires', 'backup_last_sent', 'monthly_report_last_sent'])
         is distinct from (to_jsonb(old) - array['owner_2fa_code', 'owner_2fa_code_expires', 'backup_last_sent', 'monthly_report_last_sent']) then
    raise exception using errcode = 'P0001', message = 'ltc_maintenance';
  end if;
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['reagents', 'consumption_logs', 'inventory_counts', 'inventory_count_items', 'lot_to_lot_pending',
                           'low_stock_snoozes', 'reagent_presets', 'devices', 'staff_accounts', 'app_config', 'audit_log',
                           'login_snapshots', 'public_view_visits'] loop
    execute format('drop trigger if exists zz_ltc_release_guard on public.%I', t);
    execute format('create trigger zz_ltc_release_guard before insert or update or delete or truncate on public.%I for each statement execute function ltc_release_guard()', t);
  end loop;
end $$;
drop trigger if exists zz_ltc_release_guard_row on audit_log;
create trigger zz_ltc_release_guard_row before insert on audit_log for each row execute function ltc_release_guard_audit();
drop trigger if exists zz_ltc_release_guard_row on app_config;
create trigger zz_ltc_release_guard_row before update on app_config for each row execute function ltc_release_guard_config();

-- ── Client: report this build, read the state (no inventory access) ──
create or replace function ltc_hello()
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_build text;
  r public.app_release%rowtype;
begin
  begin
    v_build := nullif(btrim((nullif(current_setting('request.headers', true), '')::json) ->> 'x-ltc-build'), '');
  exception when others then
    v_build := null;
  end;
  if v_build ~ '^[0-9a-f]{40}$' then
    delete from public.app_release_seen where last_seen < now() - interval '30 days';
    -- At most 200 distinct builds are kept (anyone with the public key can report ids).
    if exists (select 1 from public.app_release_seen where build = v_build) or (select count(*) from public.app_release_seen) < 200 then
      insert into public.app_release_seen (build) values (v_build)
      on conflict (build) do update set last_seen = now(), hits = public.app_release_seen.hits + 1;
    end if;
  end if;
  select * into r from public.app_release where id = 1;
  return jsonb_build_object('your_build', v_build, 'maintenance', r.maintenance, 'maintenance_message', r.maintenance_message,
    'enforce_build', r.enforce_build, 'approved_build', r.approved_build);
end;
$$;

-- ── Owner functions (SQL Editor only) ──
create or replace function ltc_release_state()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'maintenance', r.maintenance, 'maintenance_message', r.maintenance_message, 'enforce_build', r.enforce_build,
    'approved_build', r.approved_build, 'changed_at', r.changed_at, 'changed_by', r.changed_by,
    'builds_seen', coalesce((select jsonb_agg(jsonb_build_object('build', s.build, 'last_seen', s.last_seen, 'hits', s.hits) order by s.last_seen desc)
                               from (select * from public.app_release_seen order by last_seen desc limit 10) s), '[]'::jsonb),
    'recent_log', coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'build', l.approved_build, 'reason', l.reason) order by l.id desc)
                              from (select * from public.app_release_log order by id desc limit 10) l), '[]'::jsonb))
  from public.app_release r where r.id = 1;
$$;

-- Internal: take the exclusive lock (waits for in-flight app writes), change, log.
-- p_maintenance / p_enforce / p_build NULL = keep the current value (read under the lock).
create or replace function ltc_release_change(p_action text, p_reason text, p_maintenance boolean, p_message text,
                                              p_enforce boolean, p_build text, p_wait interval)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare r public.app_release%rowtype;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'ltc: a reason is required'; end if;
  perform set_config('lock_timeout', greatest(1, (extract(epoch from coalesce(p_wait, interval '15 seconds')) * 1000)::bigint)::text || 'ms', true);
  perform pg_advisory_xact_lock(7401000001);
  select * into r from public.app_release where id = 1 for update;
  update public.app_release
     set maintenance = coalesce(p_maintenance, r.maintenance),
         maintenance_message = coalesce(p_message, r.maintenance_message),
         enforce_build = coalesce(p_enforce, r.enforce_build),
         approved_build = coalesce(p_build, r.approved_build),
         changed_at = now(), changed_by = session_user
   where id = 1;
  insert into public.app_release_log (action, approved_build, previous_build, maintenance, enforce_build, reason)
  values (p_action, coalesce(p_build, r.approved_build), r.approved_build, coalesce(p_maintenance, r.maintenance), coalesce(p_enforce, r.enforce_build), p_reason);
  return public.ltc_release_state();
end;
$$;

create or replace function ltc_maintenance_on(p_reason text, p_message text default null, p_wait interval default '15 seconds')
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  return public.ltc_release_change('maintenance_on', p_reason, true,
    coalesce(nullif(btrim(p_message), ''), 'LTC Lab Inventory is being updated. Please wait — the app will continue by itself when the update is finished.'),
    null, null, p_wait);
end;
$$;

create or replace function ltc_maintenance_off(p_reason text, p_wait interval default '15 seconds')
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  return public.ltc_release_change('maintenance_off', p_reason, false, null, null, null, p_wait);
end;
$$;

-- Approve exactly ONE build and reopen. Two separate safeguards:
--   p_deployment_verified => true   the owner confirms Vercel shows the deployment
--                                   Ready AND the live site's /version.json shows
--                                   this commit (the database can't see Vercel);
--   reported by the deployed app    a running copy of the app reported this build
--                                   in the last 2 hours (ltc_hello) — catches typos
--                                   and builds nobody has opened; NOT proof of a
--                                   deployment on its own. p_force skips only this.
drop function if exists ltc_release_open(text, text, boolean, interval);
drop function if exists ltc_release_rollback(text, text, boolean, interval);
create or replace function ltc_release_check_build(p_build text, p_deployment_verified boolean, p_force boolean)
returns void language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  if p_build is null or p_build !~ '^[0-9a-f]{40}$' then raise exception 'ltc: the build must be the full 40-character lowercase commit id'; end if;
  if not coalesce(p_deployment_verified, false) then
    raise exception 'ltc: confirm the deployment first — Vercel shows it Ready AND https://ltc-reagent.vercel.app/version.json shows build % — then pass p_deployment_verified => true', p_build;
  end if;
  if not coalesce(p_force, false) and not exists (select 1 from public.app_release_seen where build = p_build and last_seen > now() - interval '2 hours') then
    raise exception 'ltc: build % has not been reported by the deployed app in the last 2 hours — open the new version in a browser first (or use p_force => true)', p_build;
  end if;
end;
$$;

create or replace function ltc_release_open(p_build text, p_reason text, p_deployment_verified boolean default false, p_force boolean default false, p_wait interval default '15 seconds')
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  perform public.ltc_release_check_build(p_build, p_deployment_verified, p_force);
  return public.ltc_release_change('release_open', p_reason, false, null, true, p_build, p_wait);
end;
$$;

-- Same as release_open, recorded as a rollback (e.g. back to the previous build).
create or replace function ltc_release_rollback(p_build text, p_reason text, p_deployment_verified boolean default false, p_force boolean default false, p_wait interval default '15 seconds')
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  perform public.ltc_release_check_build(p_build, p_deployment_verified, p_force);
  return public.ltc_release_change('rollback', p_reason, false, null, true, p_build, p_wait);
end;
$$;

-- Emergency switch for the build check only (maintenance keeps working).
create or replace function ltc_enforcement_set(p_on boolean, p_reason text, p_wait interval default '15 seconds')
returns jsonb language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare r public.app_release%rowtype;
begin
  select * into r from public.app_release where id = 1;
  if p_on and r.approved_build is null then raise exception 'ltc: no approved build yet — use ltc_release_open'; end if;
  return public.ltc_release_change(case when p_on then 'enforcement_on' else 'enforcement_off' end, p_reason, null, null, p_on, null, p_wait);
end;
$$;

-- Owner functions and internals: never callable by the app's roles.
revoke all on function ltc_release_guard(), ltc_release_guard_audit(), ltc_release_guard_config(), app_release_log_append_only(),
  ltc_release_state(), ltc_release_change(text, text, boolean, text, boolean, text, interval),
  ltc_maintenance_on(text, text, interval), ltc_maintenance_off(text, interval),
  ltc_release_check_build(text, boolean, boolean),
  ltc_release_open(text, text, boolean, boolean, interval), ltc_release_rollback(text, text, boolean, boolean, interval),
  ltc_enforcement_set(boolean, text, interval) from public, anon, authenticated;
revoke all on function ltc_hello() from public, authenticated;
grant execute on function ltc_hello() to anon;
-- The server key needs none of this either: only the owner changes the state.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on app_release, app_release_log, app_release_seen from service_role;
    revoke all on function ltc_hello(), ltc_release_state(), ltc_release_change(text, text, boolean, text, boolean, text, interval),
      ltc_maintenance_on(text, text, interval), ltc_maintenance_off(text, interval), ltc_release_check_build(text, boolean, boolean),
      ltc_release_open(text, text, boolean, boolean, interval), ltc_release_rollback(text, text, boolean, boolean, interval),
      ltc_enforcement_set(boolean, text, interval) from service_role;
  end if;
end $$;

insert into app_release_log (action, approved_build, previous_build, maintenance, enforce_build, reason)
select 'installed', r.approved_build, r.approved_build, r.maintenance, r.enforce_build, 'ADD_RELEASE_CONTROL.sql applied'
  from app_release r where r.id = 1;
