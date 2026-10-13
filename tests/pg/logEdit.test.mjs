// Atomic edit / undo of manual consumption logs (ADD_ATOMIC_LOG_EDIT.sql) on real
// PostgreSQL, post-Gate-A3 schema + Atomic Log Use, called as the app's anon role:
// exact stock differences, no clamping, stale detection, undo exactly once, request
// ids that identify each operation (its activity entry), the conservative
// completed-count boundary (incl. backdated logs, logs recorded during a count and
// the Asia/Riyadh lab day), unchanged device / Lot restoration rules, full
// rollback, and Stock Count evidence and history untouched.
import { randomUUID } from "node:crypto";
import { suite, check, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, buildBaseSchema, applyU2a, applyLogUse, applyLogEdit, faultTriggers } from "../helpers/pg.mjs";
import { seed } from "../fixtures/pgSeed.mjs";

for (const version of PG_VERSIONS) suite(`Atomic log edit / undo (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const db = await server.createDatabase();
    const c = await server.connect(db);
    await buildBaseSchema(c); await seed(c); await applyU2a(c);
    await c.query("grant select, insert, update, delete on all tables in schema public to anon");
    await applyLogUse(c);
    const ids0 = (await c.query("select array_agg(id) a from reagents")).rows[0].a;
    const logIds0 = (await c.query("select coalesce(array_agg(id), '{}') a from consumption_logs")).rows[0].a;
    const hist = async () => JSON.stringify([(await c.query("select * from reagents where id = any($1) order by id", [ids0])).rows, (await c.query("select * from consumption_logs where id = any($1) order by id", [logIds0])).rows, (await c.query("select * from inventory_count_items order by id")).rows, (await c.query("select * from inventory_counts order by id")).rows]);
    const history0 = await hist();
    await applyLogEdit(c);
    check("VERIFY_ATOMIC_LOG_EDIT.sql: every check PASS", (await c.query(readRoot("VERIFY_ATOMIC_LOG_EDIT.sql"))).rows.map((r) => r.result), ["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    check("migration added only the two functions: history byte-identical", await hist() === history0, true);

    const anon = await server.connect(db); await anon.query("set role anon");
    const lot = async (name, lotNo, unit, qty, extra = {}) => (await c.query(
      "insert into reagents (name, department, item_type, device, lot_number, unit, quantity_received, current_quantity, date_added, added_by, low_stock_threshold, active_on_device, deleted) values ($1, 'EditLab', 'Reagent', $2, $3, $4, $5, $5, '2026-08-01', 'tester', 0, $6, false) returning id",
      [name, extra.device ?? "", lotNo, unit, qty, extra.active ?? false])).rows[0].id;
    const use = async (reagent, amount, extra = {}) => {
      const id = randomUUID();
      const r = (await anon.query("select log_use($1, $2, $3, $4, 'tester', '', false, $5, false, null, 'tester') r", [id, reagent, amount, extra.date ?? "2026-10-13", extra.replace ?? true])).rows[0].r;
      if (r.status !== "ok") throw new Error(JSON.stringify(r));
      return id;
    };
    const logOf = async (id) => (await c.query("select amount, date::text, used_by, note, tested_by_qc, deleted, deleted_by, edited_by, edited_at is not null as edited, date_provenance, active_device_changed, previous_active_lot_id from consumption_logs where id = $1", [id])).rows[0];
    const qty = async (id) => (await c.query("select current_quantity from reagents where id = $1", [id])).rows[0].current_quantity;
    const edit = async (conn, logId, ch = {}, seen = null) => {
      const s = seen || await logOf(logId);
      const p = { req: randomUUID(), amount: s.amount, date: s.date, usedBy: s.used_by, note: s.note, qc: s.tested_by_qc, actor: "editor", ...ch };
      try { return { ...(await conn.query("select log_edit($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) r", [p.req, logId, s.amount, s.date, s.used_by, s.note, s.tested_by_qc, p.amount, p.date, p.usedBy, p.note, p.qc, p.actor])).rows[0].r, _req: p.req }; }
      catch (e) { return { error: e.message, _req: p.req }; }
    };
    const undo = async (conn, logId, ch = {}, seen = null) => {
      const s = seen || await logOf(logId);
      const p = { req: randomUUID(), actor: "undoer", ...ch };
      try { return { ...(await conn.query("select log_undo($1, $2, $3, $4, $5) r", [p.req, logId, s.amount, s.date, p.actor])).rows[0].r, _req: p.req }; }
      catch (e) { return { error: e.message, _req: p.req }; }
    };
    const audit = async (req) => (await c.query("select action, entity, description, performed_by from audit_log where id = $1", [req])).rows[0] || null;

    // ── 1. Edits after the latest count (or with no count): exact stock difference ──
    const A = await lot("Reagent E", "TE-901", "piece", 10);
    const l1 = await use(A, 3);
    const up = await edit(anon, l1, { amount: 5 });
    check("edit 3 → 5: ok; stock 7 → exactly 5; log updated with who/when; provenance and device fields unchanged", [up.status, await qty(A), await logOf(l1)], ["ok", "5", { amount: "5", date: "2026-10-13", used_by: "tester", note: "", tested_by_qc: false, deleted: false, deleted_by: null, edited_by: "editor", edited: true, date_provenance: "manual", active_device_changed: false, previous_active_lot_id: null }]);
    check("its activity entry is written in the same transaction, with the request id as its id and the usual text", await audit(up._req), { action: "edit", entity: "log", description: "Reagent E — 5 used by tester on 2026-10-13", performed_by: "editor" });
    const down = await edit(anon, l1, { amount: 2 });
    check("edit 5 → 2: stock 5 → exactly 8", [down.status, await qty(A)], ["ok", "8"]);
    const desc = await edit(anon, l1, { usedBy: "someone", note: "fixed", qc: true });
    const dated = await edit(anon, l1, { date: "2026-10-12" });
    check("descriptive edit (used by / note / QC) and a date-only edit change no stock", [desc.status, dated.status, await qty(A), (await logOf(l1)).amount], ["ok", "ok", "8", "2"]);
    const M = await lot("Diluent E", "TE-902", "mL", 100);
    const lm = await use(M, 0.5);
    check("measured unit: 0.5 → 0.75 mL leaves exactly 99.25", [(await edit(anon, lm, { amount: 0.75 })).status, await qty(M)], ["ok", "99.25"]);

    // ── 2. Refusals write nothing ──
    const audits0 = Number((await c.query("select count(*) from audit_log")).rows[0].count);
    const s1 = await logOf(l1);
    const refused = [
      await edit(anon, l1, { amount: 11 }), await edit(anon, l1, { amount: 0 }), await edit(anon, l1, { amount: -1 }), await edit(anon, l1, { amount: 2.5 }),
      await edit(anon, lm, { amount: 0.125 }), await edit(anon, l1, { amount: "NaN" }), await edit(anon, l1, { amount: 1000000001 }), await edit(anon, l1, { usedBy: " " }),
      await edit(anon, l1, { usedBy: "Unlogged (physical count)" }), await edit(anon, l1, { actor: "" }), await edit(anon, l1, { amount: 3 }, { ...s1, amount: "9" }), await edit(anon, l1, {}),
      await edit(anon, randomUUID(), {}, s1),
    ].map((r) => r.status + (r.reason ? `:${r.reason}` : "") + (r.available !== undefined ? `:${r.available}/${r.max_amount}` : ""));
    check("increase beyond stock (11, max 10), invalid amounts, blank / reserved used by, no actor, stale values, no change, missing log — each refused", refused, ["insufficient:8/10", "invalid_input:amount", "invalid_input:amount", "invalid_input:amount_not_whole", "invalid_input:amount", "invalid_input:amount", "invalid_input:amount", "invalid_input:used_by", "reserved_user", "invalid_input:actor", "stale", "unchanged", "log_not_found"]);
    check("…nothing written: stock, log and activity log unchanged", [await qty(A), JSON.stringify(await logOf(l1)) === JSON.stringify(s1), Number((await c.query("select count(*) from audit_log")).rows[0].count) - audits0], ["8", true, 0]);
    const all = await edit(anon, l1, { amount: 10 });
    check("increasing by exactly what is left is allowed: stock → 0 (no clamping anywhere)", [all.status, await qty(A)], ["ok", "0"]);
    const cd = (await c.query("select id from consumption_logs where source_count_item_id is not null limit 1")).rows[0].id;
    check("a Stock Count correction log can be neither edited nor undone here", [(await edit(anon, cd, { note: "x" })).status, (await undo(anon, cd)).status], ["count_derived", "count_derived"]);

    // ── 3. Retry identification and conflicting edits ──
    const B = await lot("Kit E", "TE-903", "piece", 20);
    const lb = await use(B, 4);
    const sb = await logOf(lb);
    const req = randomUUID();
    const e1 = await edit(anon, lb, { req, amount: 6 }, sb);
    const e2 = await edit(anon, lb, { req, amount: 6 }, sb);
    const e3 = await edit(anon, lb, { req, amount: 7 }, sb);
    check("same request again (response lost) → already_saved, applied once (16 → 14); same request id with other details → mismatch, nothing changed", [e1.status, e2.status, e3.status, await qty(B), (await logOf(lb)).amount], ["ok", "already_saved", "mismatch", "14", "6"]);
    check("a NEW request built on the old values is stale (never applied twice, never claimed as success)", (await edit(anon, lb, { amount: 6 }, sb)).status, "stale");
    const anon2 = await server.connect(db); await anon2.query("set role anon");
    const sb2 = await logOf(lb);
    const [x1, x2] = await Promise.all([edit(anon, lb, { amount: 8 }, sb2), edit(anon2, lb, { amount: 9 }, sb2)]);
    const won = [x1, x2].find((r) => r.status === "ok");
    check("two editors with the same view at once: one ok, one stale; stock moved by exactly the winner's difference", [[x1.status, x2.status].sort(), await qty(B), (await logOf(lb)).amount], [["ok", "stale"], String(14 - (Number(won === x1 ? 8 : 9) - 6)), won === x1 ? "8" : "9"]);

    // ── 4. Concurrency with Atomic Log Use (no lost updates, no deadlocks) ──
    const C = await lot("Cup E", "TE-904", "piece", 100, { device: "Analyzer E" });
    const C2 = await lot("Cup E", "TE-905", "piece", 100, { device: "Analyzer E" });
    const base = [];
    for (let i = 0; i < 10; i++) base.push(await use(i % 2 ? C : C2, 2));
    const before = Number(await qty(C)) + Number(await qty(C2));
    const conns = await Promise.all(Array.from({ length: 20 }, async () => { const k = await server.connect(db); await k.query("set role anon"); return k; }));
    const seenB = await Promise.all(base.map((id) => logOf(id)));
    const mixed = await Promise.all(conns.map(async (k, i) => {
      if (i < 10) { const id = randomUUID(); return (await k.query("select log_use($1, $2, 1, '2026-10-13', 'tester', '', false, true, false, null, 'tester') r", [id, i % 2 ? C : C2])).rows[0].r; }
      if (i < 15) return edit(k, base[i - 10], { amount: 3 }, seenB[i - 10]);
      return undo(k, base[i - 10], {}, seenB[i - 10]);
    }));
    const after = Number(await qty(C)) + Number(await qty(C2));
    check("20 devices at once on sibling Lots (10 uses of 1, 5 edits 2 → 3, 5 undos of 2): all ok, no errors or deadlocks; total stock moves by exactly −10 −5 +10", [mixed.filter((r) => r.status === "ok").length, mixed.filter((r) => r.error).length, before - after], [20, 0, 5]);

    // ── 5. Undo: exactly once; existing Lot and device rules ──
    const U = await lot("Gel E", "TE-906", "piece", 10);
    const lu = await use(U, 4);
    const su = await logOf(lu);
    const [u1, u2] = await Promise.all([undo(anon, lu, {}, su), undo(anon2, lu, {}, su)]);
    check("two undos at once: one ok, one already_undone; stock restored ONCE (6 → 10); log undone by the winner", [[u1.status, u2.status].sort(), await qty(U), (await logOf(lu)).deleted], [["already_undone", "ok"], "10", true]);
    const okUndo = [u1, u2].find((r) => r.status === "ok");
    check("undo activity entry: same transaction, request id as its id, the usual text", await audit(okUndo._req), { action: "delete", entity: "log", description: "Gel E — 4 used by tester on 2026-10-13", performed_by: "undoer" });
    check("retrying that same undo request (response lost) → already_saved; still restored once", [(await undo(anon, lu, { req: okUndo._req }, su)).status, await qty(U)], ["already_saved", "10"]);
    const lu2 = await use(U, 1);
    check("undo with values the person didn't see (edited meanwhile) → stale, nothing restored", [(await undo(anon, lu2, {}, { amount: "2", date: "2026-10-13" })).status, await qty(U)], ["stale", "9"]);
    check("an undone log can't be edited", (await edit(anon, lu, { note: "x" }, su)).status, "undone");
    const D = await lot("Buffer E", "TE-907", "piece", 2), D2 = await lot("Buffer E", "TE-908", "piece", 5);
    const ld = await use(D, 2);
    check("(setup) using the last 2 auto-removed the Lot (another Lot available)", (await c.query("select deleted from reagents where id = $1", [D])).rows[0].deleted, true);
    const ud = await undo(anon, ld);
    check("undo restores 2 and brings the auto-removed Lot back (as before)", [ud.status, await qty(D), (await c.query("select deleted, deleted_by from reagents where id = $1", [D])).rows[0]], ["ok", "2", { deleted: false, deleted_by: null }]);
    const P = await lot("Calib E", "TE-909", "piece", 5, { device: "Analyzer F" }), Q = await lot("Calib E", "TE-910", "piece", 5, { device: "Analyzer F", active: true });
    const lp = await use(P, 1);
    check("(setup) using Lot P made it active and recorded Q as the Lot it replaced", [(await logOf(lp)).active_device_changed, (await logOf(lp)).previous_active_lot_id, (await c.query("select array_agg(active_on_device order by lot_number) a from reagents where name = 'Calib E'")).rows[0].a], [true, Q, [true, false]]);
    const lp2 = await use(P, 1);
    await undo(anon, lp2);
    check("undo while another log of P remains: device state unchanged (as before)", (await c.query("select array_agg(active_on_device order by lot_number) a from reagents where name = 'Calib E'")).rows[0].a, [true, false]);
    await c.query("update reagents set deleted = true, deleted_by = 'Auto (lot depleted, alternate lot available)', deleted_at = now() where id = $1", [Q]);
    const up2 = await undo(anon, lp);
    check("undo of the log that made P active (no other log left): P inactive, Q active again and brought back (as before)", [up2.status, up2.device_reverted, (await c.query("select lot_number, active_on_device, deleted from reagents where name = 'Calib E' order by lot_number")).rows.map((r) => [r.lot_number, r.active_on_device, r.deleted])], ["ok", true, [["TE-909", false, false], ["TE-910", true, false]]]);

    // ── 6. Completed-count boundary ──
    const K = await lot("Strip K", "TE-911", "piece", 50);
    const mk = async (date, createdAt, amount = 1) => (await c.query("insert into consumption_logs (reagent_id, amount, date, used_by, note, tested_by_qc, date_provenance, created_at) values ($1, $2, $3, 'tester', '', false, 'manual', $4) returning id", [K, amount, date, createdAt])).rows[0].id;
    const count = async (started, completed, status = "completed", dept = "EditLab") => {
      const id = (await c.query("insert into inventory_counts (department, status, started_by, started_at, completed_by, completed_at) values ($1, $2, 'tester', $3, $4, $5) returning id", [dept, status, started, status === "completed" ? "tester" : null, completed])).rows[0].id;
      await c.query("insert into inventory_count_items (count_id, reagent_id, reagent_name, lot_number, department, unit, expected_quantity, counted_quantity) values ($1, $2, 'Strip K', 'TE-911', 'EditLab', 'piece', 50, 50)", [id, K]);
      return id;
    };
    await count("2026-08-01T06:00:00Z", "2026-08-01T09:00:00Z");                    // older completed count
    await count("2026-09-09T22:30:00Z", "2026-09-12T07:00:00Z", "completed", null);  // LATEST completed (Whole lab scope): starts 2026-09-10 01:30 Riyadh (still the 9th in UTC)
    await count("2026-10-01T06:00:00Z", null, "in_progress");                       // newer, but not completed: ignored
    const covered = await mk("2026-09-05", "2026-09-05T08:00:00Z");
    const onStartDay = await mk("2026-09-10", "2026-09-10T05:00:00Z");
    const duringBefore = await mk("2026-09-09", "2026-09-11T08:00:00Z");
    const duringAfter = await mk("2026-09-11", "2026-09-11T08:00:00Z");
    const backdated = await mk("2026-09-05", "2026-09-20T08:00:00Z");
    const later = await mk("2026-09-25", "2026-09-25T08:00:00Z");
    const counts0 = JSON.stringify([(await c.query("select * from inventory_counts order by id")).rows, (await c.query("select * from inventory_count_items order by id")).rows]);
    const k0 = await qty(K);
    check("covered log (dated before the count, recorded before it): amount, date and undo refused for everyone, with the count's start day", [await edit(anon, covered, { amount: 2 }), await edit(anon, covered, { date: "2026-09-20" }), await undo(anon, covered)].map((r) => [r.status, r.count_start_day]), [["covered", "2026-09-10"], ["covered", "2026-09-10"], ["covered", "2026-09-10"]]);
    check("…but used by / note / QC can be corrected, and no stock changes", [(await edit(anon, covered, { usedBy: "real person", note: "name fixed", qc: true })).status, await qty(K), (await logOf(covered)).amount], ["ok", k0, "1"]);
    check("the count's start day is the Asia/Riyadh lab day (2026-09-10), not the UTC date (09-09): a log dated 2026-09-10 is covered", (await undo(anon, onStartDay)).status, "covered");
    check("recorded DURING the count, dated on/before its start day → covered (conservative)", (await edit(anon, duringBefore, { amount: 2 })).status, "covered");
    const da = await edit(anon, duringAfter, { amount: 2 });
    check("recorded during the count but dated after its start day → not covered: edit applies (stock −1)", [da.status, await qty(K)], ["ok", String(Number(k0) - 1)]);
    check("…but moving its date into the covered period is refused", (await edit(anon, duringAfter, { date: "2026-09-08" })).status, "covered");
    const bd = await edit(anon, backdated, { amount: 3 });
    check("backdated log recorded AFTER the count was completed → not covered: edit applies normally (stock −2)", [bd.status, await qty(K)], ["ok", String(Number(k0) - 3)]);
    check("logs after the count: edit and undo apply (undo restores 1)", [(await undo(anon, later)).status, await qty(K)], ["ok", String(Number(k0) - 2)]);
    check("the latest COMPLETED count is used, whatever its scope (Whole lab) — the newer in-progress one is ignored", (await edit(anon, covered, { amount: 3 })).status, "covered");
    await c.query("update consumption_logs set created_at = null where id = $1", [duringAfter]);
    check("missing timestamp → the stock-affecting change is refused as unclassifiable (never guessed); descriptive edits still work", [(await edit(anon, duringAfter, { amount: 3 })).status, (await undo(anon, duringAfter)).status, (await edit(anon, duringAfter, { note: "ok" })).status], ["unclassifiable", "unclassifiable", "ok"]);
    check("no count evidence was written by any of this (counts and lines byte-identical)", JSON.stringify([(await c.query("select * from inventory_counts order by id")).rows, (await c.query("select * from inventory_count_items order by id")).rows]) === counts0, true);

    // ── 7. Rollback on injected failures ──
    await c.query(faultTriggers(["consumption_logs", "reagents", "audit_log"]));
    const F = await lot("Foil E", "TE-912", "piece", 10);
    const lf = await use(F, 2);
    const sf = await logOf(lf);
    const res = [];
    for (const [k, fn] of [["audit_log_insert_before_1", () => edit(anon, lf, { amount: 4 }, sf)], ["reagents_update_after_1", () => edit(anon, lf, { amount: 4 }, sf)], ["audit_log_insert_before_1", () => undo(anon, lf, {}, sf)], ["consumption_logs_update_after_1", () => undo(anon, lf, {}, sf)]]) {
      await anon.query(`set test.fault = '${k}'`);
      const r = await fn();
      res.push([k, /injected fault/.test(r.error || ""), await qty(F), JSON.stringify(await logOf(lf)) === JSON.stringify(sf), await audit(r._req)]);
    }
    await anon.query("reset test.fault");
    check("a failure at any step (activity entry, stock, log) rolls back the whole edit or undo: stock 8, log unchanged, no activity entry", res, [["audit_log_insert_before_1", true, "8", true, null], ["reagents_update_after_1", true, "8", true, null], ["audit_log_insert_before_1", true, "8", true, null], ["consumption_logs_update_after_1", true, "8", true, null]]);

    // ── 8. Compatibility ──
    const old = await (async () => { try { await anon.query("update consumption_logs set amount = 3, edited_by = 'x', edited_at = now() where id = $1", [lf]); await anon.query("update reagents set current_quantity = 7 where id = $1", [F]); return "ok"; } catch (e) { return e.message; } })();
    check("an old open tab's edit statements still work alongside the functions (until every device reloads)", old, "ok");
    check("no pre-existing Lot, log, count or count line changed by any of this", await (async () => { const [r, l, i, k] = JSON.parse(history0); return JSON.stringify([(await c.query("select * from reagents where id = any($1) order by id", [ids0])).rows, (await c.query("select * from consumption_logs where id = any($1) order by id", [logIds0])).rows, (await c.query("select * from inventory_count_items where id = any($1) order by id", [i.map((x) => x.id)])).rows, (await c.query("select * from inventory_counts where id = any($1) order by id", [k.map((x) => x.id)])).rows]) === JSON.stringify([r, l, i, k]); })(), true);
    for (const k of conns) await k.end();
    await anon.end(); await anon2.end(); await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 39 });
