// Atomic Log Use (ADD_ATOMIC_LOG_USE.sql) on real PostgreSQL, post-Gate-A3 schema,
// called as the app's anon role with the existing grants: one transaction per use,
// exact deduction, no overdraw, strict amounts, idempotency by the log id, row locks
// against lost updates, the previous rules (auto-remove + activity entry, device
// activation, Lot-to-Lot) and full rollback; Stock Count and history untouched.
import { randomUUID } from "node:crypto";
import { suite, check, load, readRoot } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, buildBaseSchema, applyU2a, applyLogUse, faultTriggers, waitForLock } from "../helpers/pg.mjs";
import { seed } from "../fixtures/pgSeed.mjs";

const U = await load("units.js");

for (const version of PG_VERSIONS) suite(`Atomic Log Use (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const db = await server.createDatabase();
    const c = await server.connect(db);
    await buildBaseSchema(c); await seed(c); await applyU2a(c);
    await c.query("grant select, insert, update, delete on all tables in schema public to anon");
    const ids0 = (await c.query("select array_agg(id) a from reagents")).rows[0].a;
    const snap = async () => JSON.stringify([(await c.query("select * from reagents where id = any($1) order by id", [ids0])).rows, (await c.query("select * from consumption_logs order by id")).rows, (await c.query("select * from inventory_count_items order by id")).rows]);
    const history0 = await snap();
    await applyLogUse(c);
    check("VERIFY_ATOMIC_LOG_USE.sql: every check PASS (signature, security invoker, search_path, grants, PK, provenance, Lot-to-Lot key)", (await c.query(readRoot("VERIFY_ATOMIC_LOG_USE.sql"))).rows.map((r) => r.result), ["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS"]);
    check("migration added only the function: pre-existing Lots, logs and count lines byte-identical", await snap() === history0, true);

    const lot = async (name, lotNo, unit, qty, extra = {}) => (await c.query(
      "insert into reagents (name, department, item_type, device, lot_number, unit, quantity_received, current_quantity, date_added, added_by, low_stock_threshold, active_on_device, deleted) values ($1, 'UseLab', 'Reagent', $2, $3, $4, $5, $5, '2026-10-01', 'tester', 0, $6, $7) returning id",
      [name, extra.device ?? "", lotNo, unit, qty, extra.active ?? false, extra.deleted ?? false])).rows[0].id;
    const A = await lot("Reagent U", "TU-901", "piece", 10, { device: "Analyzer 9" });
    const A2 = await lot("Reagent U", "TU-902", "piece", 5, { device: "Analyzer 9", active: true });
    const M = await lot("Diluent U", "TU-903", "mL", 100.5);
    const R = await lot("Swab U", "TU-904", "piece", 4, { deleted: true });
    const anon = await server.connect(db); await anon.query("set role anon");
    const call = async (conn, a) => {
      const p = { id: randomUUID(), reagent: A, amount: 1, date: "2026-10-13", usedBy: "tester", note: "", qc: false, replace: true, ltl: false, ltlId: null, actor: "tester", ...a };
      try {
        const r = (await conn.query("select log_use($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) r", [p.id, p.reagent, p.amount, p.date, p.usedBy, p.note, p.qc, p.replace, p.ltl, p.ltlId, p.actor])).rows[0].r;
        return { ...r, _id: p.id };
      } catch (e) { return { error: e.message, _id: p.id }; }
    };
    const qty = async (id) => (await c.query("select current_quantity from reagents where id = $1", [id])).rows[0].current_quantity;
    const logs = async () => Number((await c.query("select count(*) from consumption_logs")).rows[0].count);
    const logRow = async (id) => (await c.query("select reagent_id, amount, date::text, used_by, note, tested_by_qc, active_device_changed, previous_active_lot_id, date_provenance, deleted, source_count_item_id from consumption_logs where id = $1", [id])).rows[0];

    // ── 1. One use: log + deduction + device activation, in one call ──
    const u1 = await call(anon, { amount: 3, note: "run 1", qc: true });
    check("use 3 of 10: status ok, Lot now exactly 7 (returned and stored)", [u1.status, String(u1.lot.current_quantity), await qty(A)], ["ok", "7", "7"]);
    check("the log is exactly what the app wrote before: amount, date, used by, note, QC, device change, replaced Lot, 'manual' provenance", await logRow(u1._id), { reagent_id: A, amount: "3", date: "2026-10-13", used_by: "tester", note: "run 1", tested_by_qc: true, active_device_changed: true, previous_active_lot_id: A2, date_provenance: "manual", deleted: false, source_count_item_id: null });
    check("device switching: this Lot active, the replaced sibling no longer active", (await c.query("select id = $1 as me, active_on_device from reagents where id in ($1, $2) order by 1 desc", [A, A2])).rows.map((r) => r.active_on_device), [true, false]);
    const u1b = await call(anon, { amount: 1 });
    check("next use of the now-active Lot: no device change recorded", [u1b.status, (await logRow(u1b._id)).active_device_changed, (await logRow(u1b._id)).previous_active_lot_id, await qty(A)], ["ok", false, null, "6"]);
    const u2 = await call(anon, { reagent: M, amount: 0.25 });
    check("measured unit: 0.25 mL from 100.5 → exactly 100.25 (database arithmetic)", [u2.status, await qty(M), (await logRow(u2._id)).amount], ["ok", "100.25", "0.25"]);

    // ── 2. Refusals write nothing ──
    const n0 = await logs(), q0 = [await qty(A), await qty(M)];
    const refused = [
      await call(anon, { amount: 0 }), await call(anon, { amount: -1 }), await call(anon, { reagent: M, amount: 1.234 }), await call(anon, { amount: "NaN" }),
      await call(anon, { amount: 1000000001 }), await call(anon, { amount: 2.5 }), await call(anon, { usedBy: "  " }), await call(anon, { usedBy: " unlogged (PHYSICAL count) " }),
      await call(anon, { date: null }), await call(anon, { actor: "" }), await call(anon, { id: null }), await call(anon, { reagent: randomUUID() }), await call(anon, { reagent: R }), await call(anon, { amount: 7 }),
    ].map((r) => r.status + (r.reason ? `:${r.reason}` : "") + (r.available !== undefined ? `:${r.available}` : ""));
    check("invalid amounts (0, negative, 3 decimals, NaN, over 1e9, 2.5 pieces), blank / reserved used-by, no date, no actor, no id, missing Lot, removed Lot, more than available — each refused", refused, ["invalid_input:amount", "invalid_input:amount", "invalid_input:amount", "invalid_input:amount", "invalid_input:amount", "invalid_input:amount_not_whole", "invalid_input:used_by", "reserved_user", "invalid_input:date", "invalid_input:actor", "invalid_input:log_id", "lot_not_found", "lot_removed", "insufficient:6"]);
    const inf = await call(anon, { amount: "Infinity" });
    check("…and Infinity refused (or rejected by the numeric type itself) — never saved", [inf.status === "invalid_input" || /infinity|numeric/i.test(inf.error || ""), await logs() - n0, [await qty(A), await qty(M)]], [true, 0, q0]);
    const exact = await call(anon, { amount: 6 });
    check("using exactly what is left is allowed: 6 of 6 → 0 (no clamping anywhere)", [exact.status, await qty(A)], ["ok", "0"]);

    // ── 3. Idempotency by the log id ──
    const B = await lot("Kit B", "TU-905", "piece", 20);
    const idem = randomUUID();
    const i1 = await call(anon, { id: idem, reagent: B, amount: 2, note: "n" });
    const i2 = await call(anon, { id: idem, reagent: B, amount: 2, note: "n" });
    check("same id + same submission again → already_saved; one log, deducted once (18)", [i1.status, i2.status, Number((await c.query("select count(*) from consumption_logs where id = $1", [idem])).rows[0].count), await qty(B)], ["ok", "already_saved", 1, "18"]);
    const mis = await Promise.all([{ amount: 3 }, { note: "other" }, { date: "2026-10-12" }, { usedBy: "someone" }, { qc: true }, { reagent: M, amount: 2 }].map((d) => call(anon, { id: idem, reagent: B, amount: 2, note: "n", ...d })));
    check("same id with a different amount / note / date / used by / QC flag / Lot → mismatch every time, never a success; nothing changed", [mis.map((r) => r.status), await qty(B), await qty(M)], [["mismatch", "mismatch", "mismatch", "mismatch", "mismatch", "mismatch"], "18", "100.25"]);
    const anon2 = await server.connect(db); await anon2.query("set role anon");
    const same = randomUUID();
    const [p1, p2] = await Promise.all([call(anon, { id: same, reagent: B, amount: 1 }), call(anon2, { id: same, reagent: B, amount: 1 })]);
    check("the same submission sent twice at the same moment → one ok + one already_saved, one log, deducted once (17)", [[p1.status, p2.status].sort(), Number((await c.query("select count(*) from consumption_logs where id = $1", [same])).rows[0].count), await qty(B)], [["already_saved", "ok"], 1, "17"]);

    // ── 4. Concurrency: no lost updates ──
    const C = await lot("Cup C", "TU-906", "piece", 10);
    const conns = await Promise.all(Array.from({ length: 20 }, async () => { const k = await server.connect(db); await k.query("set role anon"); return k; }));
    const race = await Promise.all(conns.map((k) => call(k, { reagent: C, amount: 1 })));
    const sum = (await c.query("select coalesce(sum(amount), 0)::text s from consumption_logs where reagent_id = $1", [C])).rows[0].s;
    check("20 devices each use 1 of 10 at once: exactly 10 ok, 10 insufficient, stock 0, logs sum to 10 (nothing lost, nothing extra)", [race.filter((r) => r.status === "ok").length, race.filter((r) => r.status === "insufficient").length, race.filter((r) => r.error).length, await qty(C), sum], [10, 10, 0, "0", "10"]);
    const S1 = await lot("Strip S", "TU-907", "piece", 50, { device: "Analyzer 8", active: true });
    const S2 = await lot("Strip S", "TU-908", "piece", 50, { device: "Analyzer 8" });
    const swap = await Promise.all(conns.map((k, i) => call(k, { reagent: i % 2 ? S1 : S2, amount: 1 })));
    check("sibling Lots on one device used alternately by 20 devices (each switching the other off): no deadlock, all ok, 80 left in total, exactly one active", [swap.filter((r) => r.status === "ok").length, swap.filter((r) => r.error).length, Number(await qty(S1)) + Number(await qty(S2)), (await c.query("select count(*)::int n from reagents where id in ($1, $2) and active_on_device", [S1, S2])).rows[0].n], [20, 0, 80, 1]);
    const lockConn = await server.connect(db);
    await lockConn.query("begin"); await lockConn.query("select 1 from reagents where id = $1 for update", [B]);
    const pid = (await anon.query("select pg_backend_pid() p")).rows[0].p;
    const waiting = call(anon, { reagent: B, amount: 1 });
    const w = await waitForLock(c, pid);
    await lockConn.query("update reagents set current_quantity = 5 where id = $1", [B]); await lockConn.query("commit");
    const after = await waiting;
    check("a use waits for a concurrent change to the Lot, then deducts from the committed value (5 → 4), not from what it read before", [w.waited, after.status, await qty(B)], [true, "ok", "4"]);
    await lockConn.end();

    // ── 5. Auto-remove, activity entry, Lot-to-Lot ──
    const D = await lot("Buffer D", "TU-909", "piece", 2), D2 = await lot("Buffer D", "TU-910", "piece", 4);
    const audit0 = Number((await c.query("select count(*) from audit_log where performed_by = 'System'")).rows[0].count);
    const ar = await call(anon, { reagent: D, amount: 2 });
    check("depleted with an alternate Lot: auto-removed (same text as before) + one System activity entry, in the same call", [ar.status, ar.auto_removed, (await c.query("select deleted, deleted_by from reagents where id = $1", [D])).rows[0], Number((await c.query("select count(*) from audit_log where performed_by = 'System' and description = 'Buffer D — Lot TU-909 (auto-removed, depleted)' and action = 'delete'")).rows[0].count) , await qty(D2)], ["ok", true, { deleted: true, deleted_by: "Auto (lot depleted, alternate lot available)" }, 1, "4"]);
    const again = await call(anon, { id: ar._id, reagent: D, amount: 2 });
    check("a retry after that is already_saved (not 'removed'), nothing changes", [again.status, Number((await c.query("select count(*) from audit_log where performed_by = 'System'")).rows[0].count) - audit0], ["already_saved", 1]);
    const E = await lot("Gel E", "TU-911", "piece", 1);
    const ne = await call(anon, { reagent: E, amount: 1 });
    check("depleted without an alternate: stays (not removed), no activity entry", [ne.auto_removed, (await c.query("select deleted from reagents where id = $1", [E])).rows[0].deleted, await qty(E)], [false, false, "0"]);
    const L = await lot("Calib T", "TU-912", "piece", 2, { device: "Cobas" }), L2 = await lot("Calib T", "TU-913", "piece", 3, { device: "Cobas" });
    const pend = (await c.query("insert into lot_to_lot_pending (reagent_name, device, depleted_lot_number) values ('Calib T', 'Cobas', 'TU-900') returning id")).rows[0].id;
    const lt1 = await call(anon, { reagent: L, amount: 1, ltl: true, ltlId: pend, actor: "owner1" });
    check("Lot-to-Lot: confirming the pending check records who confirmed it", [lt1.status, lt1.lot_to_lot_flagged, (await c.query("select confirmed, confirmed_by from lot_to_lot_pending where id = $1", [pend])).rows[0]], ["ok", false, { confirmed: true, confirmed_by: "owner1" }]);
    const lt2 = await call(anon, { reagent: L, amount: 1, ltl: true });
    check("Lot-to-Lot: this Lot ran out and another is waiting → the next use needs a check (flag reset to unconfirmed for this Lot)", [lt2.status, lt2.lot_to_lot_flagged, (await c.query("select depleted_lot_number, confirmed, confirmed_by from lot_to_lot_pending where reagent_name = 'Calib T' and device = 'Cobas'")).rows], ["ok", true, [{ depleted_lot_number: "TU-912", confirmed: false, confirmed_by: null }]]);
    const L3 = await lot("Calib V", "TU-914", "piece", 1, { device: "Other" }), L4 = await lot("Calib V", "TU-915", "piece", 3, { device: "Other" });
    const lt3 = await call(anon, { reagent: L3, amount: 1, ltl: false });
    check("a device that doesn't need Lot-to-Lot: no flag even when depleted", [lt3.lot_to_lot_flagged, Number((await c.query("select count(*) from lot_to_lot_pending where reagent_name = 'Calib V'")).rows[0].count), await qty(L4)], [false, 0, "3"]);
    check("(known quirk, kept as before) the auto-removed, depleted Lot was still made active on its device", (await c.query("select deleted, active_on_device from reagents where id = $1", [L3])).rows[0], { deleted: true, active_on_device: true });
    const W1 = await lot("Calib W", "TU-919", "piece", 5, { device: "Other 2", active: true }), W2 = await lot("Calib W", "TU-920", "piece", 5, { device: "Other 2" });
    const keep = await call(anon, { reagent: W2, amount: 1, replace: false });
    check("replace = false: this Lot becomes active, the active sibling stays active, no replaced Lot recorded", [keep.status, (await logRow(keep._id)).active_device_changed, (await logRow(keep._id)).previous_active_lot_id, (await c.query("select array_agg(active_on_device order by lot_number) a from reagents where name = 'Calib W'")).rows[0].a], ["ok", true, null, [true, true]]);

    // ── 6. Rollback on any database error ──
    await c.query(faultTriggers(["consumption_logs", "reagents", "audit_log", "lot_to_lot_pending"]));
    const F = await lot("Foil F", "TU-916", "piece", 3), F2 = await lot("Foil F", "TU-917", "piece", 5);
    const before = [await logs(), await qty(F), Number((await c.query("select count(*) from audit_log")).rows[0].count)];
    const faults = [];
    for (const k of ["reagents_update_after_1", "audit_log_insert_before_1", "reagents_update_after_2"]) {
      await anon.query(`set test.fault = '${k}'`);
      const r = await call(anon, { reagent: F, amount: 3 });
      faults.push([k, /injected fault/.test(r.error || ""), [await logs(), await qty(F), Number((await c.query("select count(*) from audit_log")).rows[0].count)], (await c.query("select deleted from reagents where id = $1", [F])).rows[0].deleted]);
    }
    await anon.query("reset test.fault");
    check("a failure after the log insert (deduction, activity entry, auto-remove) rolls back everything: no log, quantity 3, no entry, not removed", faults, ["reagents_update_after_1", "audit_log_insert_before_1", "reagents_update_after_2"].map((k) => [k, true, before, false]));
    await c.query("revoke insert on consumption_logs from anon");
    const denied = await call(anon, { reagent: F, amount: 1 });
    await c.query("grant insert on consumption_logs to anon");
    check("without the insert privilege the call fails and nothing is deducted (runs with the caller's own rights)", [/permission denied/.test(denied.error || ""), await qty(F)], [true, "3"]);

    // ── 7. Stock Count and the previous client ──
    const G = await lot("Gauze G", "TU-918", "piece", 10);
    const start = (await anon.query("select stock_count_start('UseLab', 'tester') r")).rows[0].r;
    const lineG = start.items.find((i) => i.lot_number === "TU-918");
    const useG = await call(anon, { reagent: G, amount: 3 });
    await c.query("update inventory_count_items set counted_quantity = 8, counted_at = now(), counted_by = 'tester' where id = $1", [lineG.id]);
    const res = (await anon.query("select stock_count_resolve($1, 'corrected', 'tester', $2, $3) r", [lineG.id, lineG.expected_quantity, 8])).rows[0].r;
    check("Stock Count unchanged: a use during a count deducts (10 → 7); resolving 'corrected' then sets the counted 8; a later use deducts from 8", [useG.status, res.status, await qty(G), (await call(anon, { reagent: G, amount: 1 })).status, await qty(G)], ["ok", "ok", "8", "ok", "7"]);
    const resolveLock = await server.connect(db);
    await resolveLock.query("begin"); await resolveLock.query("select 1 from reagents where id = $1 for update", [G]);
    const pid2 = (await anon.query("select pg_backend_pid() p")).rows[0].p;
    const pendingUse = call(anon, { reagent: G, amount: 2 });
    check("…and a use waits while the Lot is locked by another transaction (e.g. a reconciliation)", (await waitForLock(c, pid2)).waited, true);
    await resolveLock.query("rollback"); await resolveLock.end();
    check("…then completes from the committed value (7 → 5)", [(await pendingUse).status, await qty(G)], ["ok", "5"]);
    const undo = await (async () => { try { await anon.query("update consumption_logs set deleted = true, deleted_by = 'tester', deleted_at = now() where id = $1", [useG._id]); await anon.query("update reagents set current_quantity = current_quantity + 3 where id = $1", [G]); return "ok"; } catch (e) { return e.message; } })();
    check("the existing undo statements still work on a log written by log_use (manual log, not evidence-protected)", [undo, await qty(G)], ["ok", "8"]);
    const old = await (async () => { try { await anon.query("update reagents set current_quantity = 4 where id = $1", [G]); await anon.query("insert into consumption_logs (reagent_id, amount, date, used_by, note, tested_by_qc, active_device_changed, previous_active_lot_id, date_provenance) values ($1, 4, current_date, 'tester', '', false, false, null, 'manual')", [G]); return "ok"; } catch (e) { return e.message; } })();
    check("an old open tab's statements still work alongside the function (until every device reloads)", old, "ok");

    // ── 8. Units vocabulary parity with units.js ──
    const spellings = ["ml", "mL", " ML ", "l", "L", "ul", "µL", "μl", "g", "mg", "kg", "mls", "millilitre", "milliliter", "millilitres", "milliliters", "litre", "liter", "litres", "liters", "microlitre", "microliter", "gram", "grams", "gm", "gms", "milligram", "milligrams", "kilogram", "kilograms", "piece", "box", "Bottle ", "pcs", "cassette", "gas", "units", "cylinder"];
    const parity = [];
    for (const u of spellings) {
      const id = await lot("Unit P", `TU-P-${parity.length}`, u, 10);
      const r = await call(anon, { reagent: id, amount: 0.5 });
      if ((r.status === "ok") !== !U.normalizeUnit(u).countable) parity.push([u, r.status]);
    }
    check("whole-number rule matches units.js for every spelling (measured units allow 0.5; countable and unknown words refuse it)", parity, []);

    check("no pre-existing Lot, log or count line changed by any of this", await (async () => { const [r, l, i] = JSON.parse(history0); return JSON.stringify([(await c.query("select * from reagents where id = any($1) order by id", [ids0])).rows, (await c.query("select * from consumption_logs where id = any($1) order by id", [l.map((x) => x.id)])).rows, (await c.query("select * from inventory_count_items where id = any($1) order by id", [i.map((x) => x.id)])).rows]) === JSON.stringify([r, l, i]); })(), true);
    for (const k of conns) await k.end();
    await anon.end(); await anon2.end(); await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 33 });
