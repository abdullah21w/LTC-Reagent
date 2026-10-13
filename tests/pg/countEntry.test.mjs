// Stock Count package + loose entry on real PostgreSQL (post-Gate-A3 schema, anon role):
// a count started by stock_count_start v2 snapshots each Lot's packaging; what the
// screen saves (countEntry.planCount → the same update StockCount.saveCount sends)
// is the exact base-unit count; the snapshot and every historical line stay
// untouched; reconciliation (stock_count_resolve) is unchanged and uses that count.
import { suite, check, load } from "../helpers/core.mjs";
import { PG_VERSIONS, startPostgres, buildBaseSchema, applyU2a, pgClient, inTx } from "../helpers/pg.mjs";
import { seed } from "../fixtures/pgSeed.mjs";

const E = await load("countEntry.js");
const V = await load("countEvidence.js");

for (const version of PG_VERSIONS) suite(`Stock Count package + loose entry (PostgreSQL ${version})`, async () => {
  const server = await startPostgres(version);
  try {
    const db = await server.createDatabase();
    const c = await server.connect(db);
    await buildBaseSchema(c); await seed(c); await applyU2a(c);
    await c.query("grant select, insert, update, delete on all tables in schema public to anon");
    // synthetic Lots in their own department (no history): named box, measured bottle, box size without a name, unpackaged
    const lot = async (name, lotNo, unit, qty, upc, pack) => (await c.query(
      "insert into reagents (name, department, item_type, device, lot_number, unit, quantity_received, current_quantity, date_added, added_by, low_stock_threshold, units_per_carton, pack_unit) values ($1, 'Packaging', 'Reagent', '', $2, $3, $4, $4, '2026-10-01', 'tester', 0, $5, $6) returning id", [name, lotNo, unit, qty, upc, pack])).rows[0].id;
    await lot("Cassette K", "TK-901", "piece", 20, 5, "box");
    await lot("Diluent M", "TM-901", "mL", 2000, 500, "bottle");
    await lot("Strip S", "TS-901", "piece", 30, 10, null);
    await lot("Swab W", "TW-901", "piece", 9, null, null);
    const linesBefore = JSON.stringify((await c.query("select * from inventory_count_items order by id")).rows);
    const logsBefore = JSON.stringify((await c.query("select * from consumption_logs order by id")).rows);
    const anon = await server.connect(db); await anon.query("set role anon");
    const client = pgClient(anon);

    const start = (await anon.query("select stock_count_start('Packaging', 'tester') r")).rows[0].r;
    const byLot = Object.fromEntries(start.items.map((i) => [i.lot_number, i]));
    check("count started (v2): every line carries its Lot's packaging snapshot", start.items.map((i) => [i.lot_number, i.packaging_snapshot, i.pack_unit, i.units_per_carton === null ? null : Number(i.units_per_carton)]).sort(), [["TK-901", 1, "box", 5], ["TM-901", 1, "bottle", 500], ["TS-901", 1, null, 10], ["TW-901", 1, null, null]]);
    check("the screen's three cases from the snapshot: named (packages), unnamed (total by default, packages optional), none; never invents a name", ["TK-901", "TM-901", "TS-901", "TW-901"].map((l) => { const p = E.linePackaging(byLot[l]); return p.kind === "none" ? p.reason : [p.kind, p.perPackage, p.name, E.entryMode(byLot[l])]; }), [["named", 5, "box", "packages"], ["named", 500, "bottle", "packages"], ["unnamed", 10, null, "total"], "no_box_size"]);

    // the screen's save: planCount → update counted_quantity (+ counted_at/by) on the line, as anon
    const save = async (line, entry, mode) => {
      const plan = E.planCount(entry, line, mode);
      if (plan.status === "invalid") return { refused: plan.errors };
      const next = plan.status === "empty" ? null : plan.value;
      const cur = (await c.query("select counted_quantity from inventory_count_items where id = $1", [line.id])).rows[0].counted_quantity;
      const r = await client.from("inventory_count_items").update({ counted_quantity: next, ...V.countedFields(cur, next, "tester") }).eq("id", line.id);
      return r.error ? { error: r.error.message } : { saved: next };
    };
    const stored = async (line) => (await c.query("select counted_quantity, counted_by, counted_at is not null as at, packaging_snapshot, pack_unit, units_per_carton from inventory_count_items where id = $1", [line.id])).rows[0];
    const r1 = await save(byLot["TK-901"], { packages: "3", loose: "2" });
    const r2 = await save(byLot["TM-901"], { packages: "3", loose: "0.1" });
    const r3 = await save(byLot["TS-901"], { packages: "0", loose: "0" }, "packages"); // "Calculate using packages" chosen
    const r4 = await save(byLot["TW-901"], { quantity: "9" });
    check("saved counts are canonical base units: 3 boxes + 2 = 17 pieces; 3 × 500 mL + 0.1 = 1500.1 mL; 0 packages + 0 = 0; unpackaged 9", [r1, r2, r3, r4], [{ saved: 17 }, { saved: 1500.1 }, { saved: 0 }, { saved: 9 }]);
    check("stored exactly as numeric (no floating-point noise), with who/when", await Promise.all(["TK-901", "TM-901", "TS-901", "TW-901"].map(async (l) => { const s = await stored(byLot[l]); return [s.counted_quantity, s.counted_by, s.at]; })), [["17", "tester", true], ["1500.1", "tester", true], ["0", "tester", true], ["9", "tester", true]]);
    check("the snapshot is unchanged by counting (still the Lot's packaging at count start)", await Promise.all(["TK-901", "TM-901"].map(async (l) => { const s = await stored(byLot[l]); return [s.packaging_snapshot, s.pack_unit, Number(s.units_per_carton)]; })), [[1, "box", 5], [1, "bottle", 500]]);
    check("invalid entries never reach the database (fractional boxes, negative loose, 3-decimal mL)", [await save(byLot["TK-901"], { packages: "1.5", loose: "" }), await save(byLot["TK-901"], { packages: "1", loose: "-1" }), await save(byLot["TM-901"], { packages: "0", loose: "0.125" }), (await stored(byLot["TK-901"])).counted_quantity, (await stored(byLot["TM-901"])).counted_quantity], [{ refused: ["Full boxes must be a whole number (count opened ones as loose pieces)."] }, { refused: ["Loose pieces can't be negative."] }, { refused: ["Loose mL can have at most 2 decimals."] }, "17", "1500.1"]);

    // reopening: the fields rebuilt from the stored value give back the same count (nothing re-saved)
    check("reopening a line: fields rebuilt from the stored numeric give back exactly the stored count", await Promise.all(["TK-901", "TM-901", "TS-901", "TW-901"].map(async (l) => { const s = await stored(byLot[l]); const m = l === "TS-901" ? "packages" : undefined; const e = E.entryFor(s.counted_quantity, byLot[l], m); return [e, E.sameCount(E.planCount(e, byLot[l], m).value, s.counted_quantity)]; })), [[{ packages: "3", loose: "2", quantity: "" }, true], [{ packages: "3", loose: "0.1", quantity: "" }, true], [{ packages: "0", loose: "0", quantity: "" }, true], [{ packages: "", loose: "", quantity: "9" }, true]]);
    const tsTotal = E.entryFor((await stored(byLot["TS-901"])).counted_quantity, byLot["TS-901"]);
    check("the same saved 0 shown in the default total mode is '0' (a confirmed zero, not blank)", tsTotal, { packages: "", loose: "", quantity: "0" });
    const cleared = await save(byLot["TS-901"], { packages: "", loose: "" }, "packages");
    const cs = await stored(byLot["TS-901"]);
    check("clearing both fields un-counts the line (NULL, who/when cleared)", [cleared, cs.counted_quantity, cs.counted_by, cs.at], [{ saved: null }, null, null, false]);

    // reconciliation unchanged: 'corrected' sets the Lot to the counted base-unit quantity
    const resolved = (await anon.query("select stock_count_resolve($1, 'corrected', 'tester', $2, $3) r", [byLot["TK-901"].id, byLot["TK-901"].expected_quantity, 17])).rows[0].r;
    check("resolve 'corrected' (unchanged function): Lot quantity becomes the counted 17 pieces", [resolved.status, Number((await c.query("select current_quantity from reagents where lot_number = 'TK-901'")).rows[0].current_quantity)], ["ok", 17]);
    const resolvedM = (await anon.query("select stock_count_resolve($1, 'corrected', 'tester', $2, $3) r", [byLot["TM-901"].id, byLot["TM-901"].expected_quantity, 1500.1])).rows[0].r;
    check("resolve on the measured line: Lot becomes exactly 1500.1 mL", [resolvedM.status, (await c.query("select current_quantity from reagents where lot_number = 'TM-901'")).rows[0].current_quantity], ["ok", "1500.1"]);
    const late = await save(byLot["TK-901"], { packages: "4", loose: "0" });
    check("a resolved line's count is final: the save is refused by the database (the screen shows it, entry kept)", [/evidence_field_protected/.test(late.error || ""), (await stored(byLot["TK-901"])).counted_quantity], [true, "17"]);

    // historical lines (created before U2a): base units only; nothing about them changed
    const legacyLines = (await c.query("select * from inventory_count_items where packaging_snapshot is null")).rows;
    check("lines created before U2a are counted in base units only (no snapshot → no packaging inferred)", [legacyLines.length > 0, legacyLines.every((l) => E.linePackaging(l).reason === "no_snapshot")], [true, true]);
    const newIds = start.items.map((i) => i.id);
    check("every pre-existing count line and usage log is byte-identical", [JSON.stringify((await c.query("select * from inventory_count_items where id <> all($1) order by id", [newIds])).rows) === linesBefore, JSON.stringify((await c.query("select * from consumption_logs order by id")).rows) === logsBefore], [true, true]);
    check("Lots not reconciled keep their quantity (counting alone changes no stock)", (await c.query("select lot_number, current_quantity from reagents where lot_number in ('TS-901', 'TW-901') order by 1")).rows.map((r) => [r.lot_number, r.current_quantity]), [["TS-901", "30"], ["TW-901", "9"]]);
    await anon.end(); await c.end();
  } finally { await server.stop(); }
}, { expectedChecks: 15 });
