// manual_spread provenance (ADD_EVIDENCE_FOUNDATION.sql CHECK) on real PostgreSQL:
// a fresh install, and an upgrade from the earlier committed Foundation (c482054, copied to
// tests/fixtures/historical-sql so no git history is needed); then guard compatibility.
// Ported from runMS.mjs; its review-time git check is listed in the coverage matrix.
import { readFileSync } from "node:fs";
import { suite, check, readRoot, rootPath } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, ensureRoles } from "../helpers/pg.mjs";

const OLD_FOUNDATION = readFileSync(rootPath("tests", "fixtures", "historical-sql", "ADD_EVIDENCE_FOUNDATION.pre-manual-spread.c482054.sql"), "utf8");
const BASE = `
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create table reagents (id uuid primary key default gen_random_uuid(), name text not null, lot_number text not null, device text not null default '', current_quantity numeric not null default 0, deleted boolean not null default false, date_added date, created_at timestamptz default now());
  create table staff_accounts (id uuid primary key default gen_random_uuid(), permissions jsonb not null default '{}'::jsonb);
  create table consumption_logs (id uuid primary key default gen_random_uuid(), reagent_id uuid references reagents(id) on delete cascade, amount numeric not null, date date not null, used_by text not null, note text, tested_by_qc boolean not null default false, deleted boolean not null default false, deleted_by text, deleted_at timestamptz, edited_by text, edited_at timestamptz, created_at timestamptz not null default now());
  create table audit_log (id uuid primary key default gen_random_uuid(), action text not null, entity text not null, description text not null, performed_by text not null, performed_at timestamptz not null default now());
  grant all on reagents, staff_accounts, consumption_logs, audit_log to anon, authenticated;`;
const PRE = ["ADD_INVENTORY_COUNTS.sql", "ADD_COUNT_LOG_LINKS.sql", "ADD_ONE_OPEN_COUNT_PER_SCOPE.sql"];
const ALL7 = ["manual", "manual_spread", "count_exact", "count_exact_default", "count_spread_window", "count_redated", "historical_unknown"];

for (const version of PG_VERSIONS) suite(`manual_spread · provenance CHECK fresh + upgrade, guard compatibility (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const dbFresh = await server.createDatabase(), dbUp = await server.createDatabase();
    const prep = async (db) => { const c = await server.connect(db); await ensureRoles(c); await c.query(BASE); for (const f of PRE) await c.query(readRoot(f)); await c.query("grant all on inventory_counts, inventory_count_items to anon, authenticated;"); return c; };
    const allowed = async (c) => (await c.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'consumption_logs_date_provenance_check'")).rows.map((r) => [...r.d.matchAll(/'(\w+)'/g)].map((m) => m[1]));
    const FOUNDATION = readRoot("ADD_EVIDENCE_FOUNDATION.sql");
    const F = await prep(dbFresh);
    let errs = []; for (let i = 0; i < 2; i++) { try { await F.query(FOUNDATION); } catch (e) { errs.push(e.message); } }
    check("fresh: Foundation runs twice without error", errs, []);
    check("fresh: exactly one provenance CHECK, allowing the 7 final values", await allowed(F), [ALL7]);
    const Up = await prep(dbUp);
    await Up.query(OLD_FOUNDATION);
    const old = await allowed(Up);
    errs = []; for (let i = 0; i < 2; i++) { try { await Up.query(FOUNDATION); } catch (e) { errs.push(e.message); } }
    check("upgrade: committed Foundation had 6 values; re-running the new file converges on the 7 (one constraint)", [old[0].length, old[0].includes("manual_spread"), errs, await allowed(Up)], [6, false, [], [ALL7]]);
    for (const c of [F, Up]) { await c.query(readRoot("ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql")); await c.query(readRoot("ADD_EVIDENCE_GUARD.sql")); }
    for (const [label, c, db] of [["fresh", F, dbFresh], ["upgrade", Up, dbUp]]) {
      const A = await server.connect(db); await A.query("set role anon");
      await c.query("truncate consumption_logs, inventory_count_items, inventory_counts, reagents cascade");
      const lot = (await c.query("insert into reagents (name, lot_number, current_quantity, date_added) values ('Alpha', 'A1', 10, '2026-07-01') returning id")).rows[0].id;
      const ins = async (prov, used = "staff-a") => { try { return (await A.query("insert into consumption_logs (reagent_id, amount, date, used_by, date_provenance) values ($1, 1, '2026-10-01', $2, $3) returning id", [lot, used, prov])).rows[0].id; } catch (e) { return `ERR ${e.code}`; } };
      const ids = []; for (const p of ALL7) ids.push(await ins(p));
      check(`${label}: all 7 values accepted (incl. manual_spread)`, ids.map((x) => !String(x).startsWith("ERR")), ALL7.map(() => true));
      check(`${label}: invalid values still rejected by the CHECK (23514)`, [await ins("spread"), await ins("manual-spread"), await ins("MANUAL_SPREAD")], ["ERR 23514", "ERR 23514", "ERR 23514"]);
      const ms = ids[1];
      const t = async (sql) => { try { await A.query(sql, [ms]); return "OK"; } catch (e) { return `${e.message}/${e.detail}`; } };
      check(`${label} + guard: a manual_spread row is a normal manual log (edit, re-date, undo allowed)`, await t("update consumption_logs set amount = 2, date = '2026-10-02', used_by = 'staff-b', deleted = true where id = $1"), "OK");
      check(`${label} + guard: its provenance is write-once like every row`, [await t("update consumption_logs set date_provenance = 'manual' where id = $1"), await t("update consumption_logs set date_provenance = null where id = $1")], ["evidence_field_protected/date_provenance", "evidence_field_protected/date_provenance"]);
      await A.end();
    }
    await F.end(); await Up.end();
  } finally { await server.stop(); }
}, { expectedChecks: 11 });
