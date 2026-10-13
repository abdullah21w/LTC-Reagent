// B1 client replay: the exact writes the B1 Stock Count client issued (recorded by
// the review harness on a synthetic seed: tests/fixtures/golden/b1-client-writes.json)
// replayed as the anon role on real PostgreSQL —
//   A. Foundation + Functions: every write succeeds; lines, details, links, provenance,
//      stock and Edit-dates replacement rows are exactly as written;
//   B. + Evidence Guard: still compatible; written evidence becomes immutable;
//   C. no Foundation: documents the partial write (why the Foundation must come first).
// Ported from runB1F.mjs (runB1.mjs was the same suite before the Functions existed).
import { readFileSync } from "node:fs";
import { suite, check, readRoot, rootPath } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, ensureRoles } from "../helpers/pg.mjs";
import { uuidOf, canon } from "../helpers/uuid.mjs";

const RUNS = JSON.parse(readFileSync(rootPath("tests", "fixtures", "golden", "b1-client-writes.json"), "utf8"));
const BASE = `
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create table reagents (id uuid primary key default gen_random_uuid(), name text, lot_number text, department text, unit text, device text,
    current_quantity numeric not null default 0, deleted boolean not null default false, deleted_by text, deleted_at timestamptz,
    expiry_date date, date_added date, created_at timestamptz default now());
  create table staff_accounts (id uuid primary key default gen_random_uuid(), permissions jsonb not null default '{}'::jsonb);
  create table consumption_logs (id uuid primary key default gen_random_uuid(), reagent_id uuid references reagents(id) on delete cascade,
    amount numeric not null, date date not null, used_by text not null, note text, tested_by_qc boolean not null default false,
    active_device_changed boolean not null default false, previous_active_lot_id uuid, deleted boolean not null default false,
    deleted_by text, deleted_at timestamptz, edited_by text, edited_at timestamptz, created_at timestamptz not null default now());
  create table audit_log (id uuid primary key default gen_random_uuid(), action text, entity text, description text, performed_by text, performed_at timestamptz default now());
  grant all on reagents, staff_accounts, consumption_logs, audit_log to anon, authenticated;`;
const MIGRATIONS = ["ADD_INVENTORY_COUNTS.sql", "ADD_COUNT_LOG_LINKS.sql", "ADD_ONE_OPEN_COUNT_PER_SCOPE.sql"];

for (const version of PG_VERSIONS) suite(`B1 · recorded Stock Count client writes replayed (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
  async function prepare(files) {
    const c = await server.connect(await server.createDatabase());
    await ensureRoles(c);
    await c.query(BASE);
    for (const f of [...MIGRATIONS, ...files]) await c.query(readRoot(f));
    await c.query("grant all on inventory_counts, inventory_count_items to anon, authenticated;");
    return c;
  }
  const dbs = {
    foundation: await prepare(["ADD_EVIDENCE_FOUNDATION.sql", "ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql"]),
    guard: await prepare(["ADD_EVIDENCE_FOUNDATION.sql", "ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql", "ADD_EVIDENCE_GUARD.sql"]),
    noschema: await prepare([]),
  };
  // Replays one harness run: seed, then every recorded write in order (as anon).
  async function replay(admin, run, { onWrite } = {}) {
    await admin.query("truncate audit_log, consumption_logs, inventory_count_items, inventory_counts, reagents cascade");
    const ids = new Map();
    const s = run.seed;
    for (const t of ["reagents", "inventory_counts", "inventory_count_items", "consumption_logs"]) for (const r of s[t]) ids.set(r.id, uuidOf(r.id));
    const mapv = (v) => { if (typeof v === "string") { if (/^\w+#\d+$/.test(v) && !ids.has(v)) throw Object.assign(new Error("skip"), { skip: true }); return ids.get(v) ?? v; } return Array.isArray(v) ? v.map(mapv) : v; };
    const val = (v) => (v && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : mapv(v));
    const ins = async (c, table, row) => { const cols = Object.keys(row); const r = await c.query(`insert into ${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, cols.map((k) => val(row[k]))); return r.rows[0].id; };
    for (const t of ["reagents", "inventory_counts", "inventory_count_items", "consumption_logs"]) for (const r of s[t]) await ins(admin, t, r);
    const A = admin; await A.query("set role anon");
    let seq = 0; const errors = []; const skipped = [];
    try {
      for (const [n, w] of run.writes.entries()) {
        try {
          if (w.op === "insert") {
            for (const row of Array.isArray(w.payload) ? w.payload : [w.payload]) { seq++; const id = await ins(A, w.table, row); ids.set(`${w.table}#${seq}`, id); }
          } else {
            const params = []; const p = (v) => (params.push(val(v)), `$${params.length}`);
            const set = w.op === "update" ? Object.entries(w.payload).map(([k, v]) => `${k} = ${p(v)}`).join(", ") : "";
            const where = w.filters.map(([k, c, v]) => (k === "eq" ? `${c} = ${p(v)}` : k === "in" ? `${c} = any(${p(v)})` : k === "gte" ? `${c} >= ${p(v)}` : `${c} <= ${p(v)}`)).join(" and ") || "true";
            await A.query(w.op === "update" ? `update ${w.table} set ${set} where ${where}` : `delete from ${w.table} where ${where}`, params);
          }
        } catch (e) { if (e.skip) { skipped.push(`${n}:${w.table}.${w.op}`); continue; } errors.push(`${n}:${w.table}.${w.op}:${e.code}:${e.message}`); }
        if (onWrite) await onWrite(n, w, ids);
      }
    } finally { await A.query("reset role"); }
    return { ids, errors, skipped, id: (k) => ids.get(k) };
  }
  const lineRow = async (c, id) => (await c.query("select resolved, resolution_note, resolved_at, resolved_by, resolution_details, counted_quantity::float8 cq, counted_at, counted_by, consumption_log_ids from inventory_count_items where id = $1", [id])).rows[0];
  const logRows = async (c, itemId) => (await c.query("select id, to_char(date, 'YYYY-MM-DD') date, amount::float8 amount, used_by, date_provenance, source_count_item_id from consumption_logs where source_count_item_id = $1 order by date, id", [itemId])).rows;
  const qtyOf = async (c, id) => Number((await c.query("select current_quantity from reagents where id = $1", [id])).rows[0].current_quantity);
  const ms = (t) => (t == null ? null : new Date(t).getTime());

  // ── A. Foundation schema only (B1 as designed) ──
  const F = dbs.foundation;
  const lines = { exact_default: "i-alpha", exact_changed: "i-alpha", exact_changed_then_back: "i-alpha", spread: "i-alpha", spread_remainder: "i-alpha", spread_received_window: "i-beta", corrected_shortage: "i-alpha", apply_surplus: "i-gamma", kept: "i-beta" };
  const shortages = { exact_default: 2, exact_changed: 2, exact_changed_then_back: 2, spread: 2, spread_remainder: 0.07, spread_received_window: 2 };
  const prov = { exact_default: "count_exact_default", exact_changed: "count_exact", exact_changed_then_back: "count_exact_default", spread: "count_spread_window", spread_remainder: "count_spread_window", spread_received_window: "count_spread_window" };
  for (const [name, itemKey] of Object.entries(lines)) {
    const run = RUNS[name];
    const r = await replay(F, run);
    check(`A ${name}: every recorded B1 write succeeds on real PG (foundation schema)`, r.errors, []);
    const itemId = r.id(itemKey);
    const L = await lineRow(F, itemId), logs = await logRows(F, itemId);
    const mock = run.line;
    check(`A ${name}: line resolved, note, resolved_by as written`, [L.resolved, L.resolution_note, L.resolved_by], [true, mock.resolution_note, "TESTER"]);
    check(`A ${name}: resolved_at stored as timestamptz = the written instant`, ms(L.resolved_at), ms(mock.resolved_at));
    check(`A ${name}: resolution_details stored = the written v1 snapshot`, canon(L.resolution_details), canon(mock.resolution_details));
    check(`A ${name}: lot stock after resolution (${name === "kept" ? "unchanged" : "= counted"})`, await qtyOf(F, r.id("r-" + itemKey.slice(2))), name === "kept" ? 4 : Number(run.seed.inventory_count_items.find((i) => i.id === itemKey).counted_quantity));
    if (shortages[name] != null) {
      check(`A ${name}: every correction row linked to its line (source_count_item_id) and marked ${prov[name]}`, logs.map((l) => [l.source_count_item_id, l.date_provenance, l.used_by]), logs.map(() => [itemId, prov[name], "Unlogged (physical count)"]));
      check(`A ${name}: rows = allocation in details; total = shortage ${shortages[name]}`, [logs.map((l) => ({ date: l.date, amount: l.amount })), Math.round(logs.reduce((s, l) => s + l.amount, 0) * 100) / 100], [L.resolution_details.allocation, shortages[name]]);
      check(`A ${name}: consumption_log_ids still maintained = the linked rows`, [...L.consumption_log_ids].sort(), logs.map((l) => l.id).sort());
    } else {
      check(`A ${name}: no correction rows; allocation [] / window null / provenance null`, [logs.length, L.resolution_details.allocation, L.resolution_details.window, L.resolution_details.date_provenance], [0, [], null, null]);
    }
  }
  check("A exact_default vs exact_changed: changed date preserved in details", [RUNS.exact_default.line.resolution_details.allocation[0].date, RUNS.exact_changed.line.resolution_details.allocation[0].date, RUNS.exact_changed.line.resolution_details.date_provenance], ["2026-09-30", "2026-09-25", "count_exact"]);
  check("A methods are distinct per resolution path", ["exact_default", "spread", "corrected_shortage", "apply_surplus", "kept"].map((k) => RUNS[k].line.resolution_details.method), ["usage_exact", "usage_spread", "corrected", "corrected", "kept"]);
  check("A discrepancy sign: shortage negative, surplus positive", [RUNS.corrected_shortage.line.resolution_details.discrepancy.difference, RUNS.apply_surplus.line.resolution_details.discrepancy.difference], [-2, 1]);

  // Edit dates after a B1 spread: details byte-identical, rows replaced, link + count_redated, total kept.
  {
    const run = RUNS.edit_dates_after_spread; let first = null; const snaps = [];
    const r = await replay(F, run, { onWrite: async (n, w, ids) => { const id = ids.get("i-alpha"); const row = await lineRow(F, id); if (w.table === "inventory_count_items" && row.resolution_details && !first) first = { d: JSON.stringify(row.resolution_details), at: ms(row.resolved_at), by: row.resolved_by }; if (w.table === "audit_log" && w.payload.action === "edit" && w.payload.entity === "log") snaps.push({ row, logs: await logRows(F, id) }); } });
    check("A edit_dates_after_spread: every write succeeds (resolve, finish, 2 × Edit dates)", r.errors, []);
    check("A edit_dates: two Edit-dates applies observed", snaps.length, 2);
    check("A edit_dates: resolution_details / resolved_at / resolved_by unchanged after each edit", snaps.map((s) => [JSON.stringify(s.row.resolution_details) === first.d, ms(s.row.resolved_at) === first.at, s.row.resolved_by === first.by]), [[true, true, true], [true, true, true]]);
    check("A edit_dates: replacement rows linked to the same line, all count_redated", snaps.map((s) => s.logs.map((l) => [l.source_count_item_id, l.date_provenance])), [[[r.id("i-alpha"), "count_redated"]], [[r.id("i-alpha"), "count_redated"], [r.id("i-alpha"), "count_redated"]]]);
    check("A edit_dates: dates follow the edit; total amount preserved (2)", snaps.map((s) => [s.logs.map((l) => l.date), s.logs.reduce((a, l) => a + l.amount, 0)]), [[["2026-09-22"], 2], [["2026-09-21", "2026-09-28"], 2]]);
    check("A edit_dates: original spread rows gone; only current rows remain for the line", (await F.query("select count(*)::int n from consumption_logs where source_count_item_id = $1", [r.id("i-alpha")])).rows[0].n, 2);
    check("A edit_dates: details still record the ORIGINAL spread allocation", JSON.parse(first.d).allocation, [{ date: "2026-09-20", amount: 1 }, { date: "2026-09-27", amount: 1 }]);
  }
  {
    const r = await replay(F, RUNS.edit_dates_historical);
    const L = await lineRow(F, r.id("i-done")), logs = await logRows(F, r.id("i-done"));
    check("A edit_dates_historical: succeeds; replacement row linked + count_redated", [r.errors, logs.map((l) => [l.date, l.amount, l.date_provenance])], [[], [["2026-08-15", 2, "count_redated"]]]);
    check("A edit_dates_historical: nothing invented on the historical line (details/resolved_at/by stay NULL)", [L.resolution_details, L.resolved_at, L.resolved_by], [null, null, null]);
  }
  {
    const states = [];
    const r = await replay(F, RUNS.counted_quantity, { onWrite: async (n, w, ids) => { if (w.table === "inventory_count_items") { const id = w.filters[0][2]; const row = await lineRow(F, ids.get(id)); states.push([id, row.cq, row.counted_at && ms(row.counted_at), row.counted_by]); } } });
    const s = RUNS.counted_quantity.steps;
    check("A counted: every write succeeds", r.errors, []);
    check("A counted: historical unchanged re-save → counted_at/by stay NULL", states[0], ["i-alpha", 3, null, null]);
    check("A counted: first save → at/by set", states[1], ["i-hemo", 2, ms(s.first.counted_at), "TESTER"]);
    check("A counted: unchanged re-save → counted_at NOT moved", states[2], ["i-hemo", 2, ms(s.first.counted_at), "TESTER"]);
    check("A counted: changed → counted_at moves forward", [states[3][1], states[3][2] > states[2][2], states[3][3]], [1, true, "TESTER"]);
    check("A counted: cleared → quantity/at/by NULL; cleared again stays NULL", [states[4], states[5]], [["i-hemo", null, null, null], ["i-hemo", null, null, null]]);
  }

  // ── B. Future guard enabled: B1 writes stay compatible; evidence is immutable ──
  const G = dbs.guard;
  for (const name of [...Object.keys(lines), "edit_dates_after_spread", "edit_dates_historical", "counted_quantity"]) {
    const r = await replay(G, RUNS[name]);
    check(`B ${name}: every B1 write succeeds with the guard enabled`, r.errors, []);
  }
  {
    const r = await replay(G, RUNS.spread); const id = r.id("i-alpha");
    await G.query("set role anon");
    const tryQ = async (sql, p = []) => { try { await G.query(sql, p); return "OK"; } catch (e) { return `${e.code}:${e.message}/${e.detail}`; } };
    check("B guard: resolution_details change refused", await tryQ(`update inventory_count_items set resolution_details = '{"v":1,"method":"kept"}' where id = $1`, [id]), "P0001:evidence_field_protected/resolution_details");
    check("B guard: resolved_at change refused", await tryQ("update inventory_count_items set resolved_at = now() where id = $1", [id]), "P0001:evidence_field_protected/resolved_at");
    check("B guard: resolved_by change refused", await tryQ("update inventory_count_items set resolved_by = 'X' where id = $1", [id]), "P0001:evidence_field_protected/resolved_by");
    check("B guard: clearing details refused", await tryQ("update inventory_count_items set resolution_details = null where id = $1", [id]), "P0001:evidence_field_protected/resolution_details");
    check("B guard: a second resolution of the same line (another device's B1 payload) refused", await tryQ(`update inventory_count_items set resolved = true, resolution_note = 'Kept system value', resolved_at = now(), resolved_by = 'OTHER', resolution_details = '{"v":1,"method":"kept"}' where id = $1`, [id]), "P0001:evidence_field_protected/resolution_details");
    check("B guard: B1 correction row amount / undo refused", [await tryQ("update consumption_logs set amount = 9 where source_count_item_id = $1", [id]), await tryQ("update consumption_logs set deleted = true where source_count_item_id = $1", [id])], ["P0001:evidence_field_protected/amount", "P0001:evidence_field_protected/deleted"]);
    check("B guard: counted_at / counted_by still updatable", await tryQ("update inventory_count_items set counted_at = now(), counted_by = 'TESTER' where id = $1", [id]), "OK");
    await G.query("reset role");
  }

  // ── C. Rollout order: B1 app against a database WITHOUT the foundation schema ──
  const N = dbs.noschema;
  {
    const r = await replay(N, RUNS.exact_default);
    check("C no schema: B1 log insert and resolve update are rejected (unknown columns)", r.errors.map((e) => e.split(":").slice(1, 3).join(":")), ["consumption_logs.insert:42703", "inventory_count_items.update:42703"]);
    const L = (await N.query("select resolved from inventory_count_items where id = $1", [r.id("i-alpha")])).rows[0];
    check("C no schema: resulting state = PARTIAL WRITE (stock lowered to 3, no log, line unresolved) → foundation must precede B1", [await qtyOf(N, r.id("r-alpha")), (await N.query("select count(*)::int n from consumption_logs where used_by = 'Unlogged (physical count)' and reagent_id = $1 and date = '2026-09-30'", [r.id("r-alpha")])).rows[0].n, L.resolved, r.skipped.length], [3, 0, false, 1]);
    const r2 = await replay(N, RUNS.counted_quantity);
    check("C no schema: B1 counted-quantity saves that carry counted_at/by are rejected", r2.errors.length, 3);
  }
  for (const c of Object.values(dbs)) await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 106 });
