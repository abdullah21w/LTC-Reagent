// Atomic edit / undo — the save paths (logEditSave.js): strict amount check with the
// stock bound for increases, one log_edit / log_undo call carrying the values the
// window showed and a request id, every outcome mapped honestly, and a lost response
// recognised only by reading back the request's own activity entry.
import { suite, check, load, readSource } from "../helpers/core.mjs";

suite("Atomic edit / undo · save paths (logEditSave.js)", async () => {
const S = await load("logEditSave.js");
const lot = { unit: "piece", current_quantity: 2 }, ml = { unit: "mL", current_quantity: 1 };
const chk = (raw, l = lot, old = 3) => { const r = S.checkEditAmount(raw, l, old); return r.ok ? r.value : r.error; };

check("amount: valid edits up to old + what is left (3 + 2 = 5); any decrease; mL decimals", [chk("5"), chk("1"), chk("3.5", ml, 3), chk("0.10", ml, 0.5)], [5, 1, 3.5, 0.1]);
check("amount: more than old + left refused with the maximum and how to record more", chk("6"), "This Lot has only 2 pieces left, so this entry can be at most 5. To record more, correct the Lot's quantity first (Edit Lot or Stock Count).");
check("amount: the Log use rules apply (0, negative, fractional pieces, 3 decimals, exponent, blank)", [chk("0"), chk("-1"), chk("2.5"), chk("0.125", ml, 0.5), chk("1e1"), chk("")], ["Amount used must be more than 0.", "Amount used can't be negative.", "Amount used must be a whole number of pieces.", "Amount used can have at most 2 decimals.", "Amount used must be written as a plain number (for example 2 or 2.5).", "Enter the amount used in pieces."]);
check("no Lot loaded → no stock bound in the browser (the database checks it)", S.checkEditAmount("50", undefined, 3).ok, true);

const fake = ({ rpc, readBack }) => {
  const calls = [];
  return { calls, rpc: async (fn, args) => { calls.push(["rpc", fn, args]); if (rpc instanceof Error) throw rpc; return rpc; },
    from: (t) => { const q = { select: () => q, eq: (f, v) => { calls.push(["read", t, f, v]); return q; }, then: (res, rej) => (readBack instanceof Error ? Promise.reject(readBack) : Promise.resolve(readBack)).then(res, rej) };
      ["insert", "update", "delete", "upsert"].forEach((k) => { q[k] = () => { calls.push(["WRITE", t, k]); return q; }; }); return q; } };
};
const original = { id: "log-1", amount: 3, date: "2026-10-01", used_by: "tester", note: null, tested_by_qc: false };
const req = { requestId: "11111111-1111-4111-8111-111111111111", original, amount: 5, date: "2026-10-02", usedBy: "someone", note: "n", testedByQC: true, unit: "piece" };
const runE = async (o, r = req) => { const c = fake(o); return { r: await S.saveLogEdit({ client: c, request: r, actor: "editor" }), calls: c.calls }; };
const runU = async (o, r = { requestId: req.requestId, log: original }) => { const c = fake(o); return { r: await S.saveLogUndo({ client: c, request: r, actor: "undoer" }), calls: c.calls }; };

let t = await runE({ rpc: { data: { status: "ok" }, error: null } });
check("edit → one log_edit call: request id, the values the window showed, the new values, actor; saved; no direct write", [t.r.ok, t.r.outcome, t.calls.length, t.calls[0][1], t.calls[0][2]], [true, "saved", 1, "log_edit", { p_request_id: req.requestId, p_log_id: "log-1", p_seen_amount: 3, p_seen_date: "2026-10-01", p_seen_used_by: "tester", p_seen_note: "", p_seen_tested_by_qc: false, p_amount: 5, p_date: "2026-10-02", p_used_by: "someone", p_note: "n", p_tested_by_qc: true, p_actor: "editor" }]);
check("already_saved and unchanged are confirmations", [(await runE({ rpc: { data: { status: "already_saved" }, error: null } })).r.outcome, (await runE({ rpc: { data: { status: "unchanged" }, error: null } })).r.ok], ["already_saved", true]);
const edits = [];
for (const d of [{ status: "stale" }, { status: "covered", count_start_day: "2026-09-10" }, { status: "unclassifiable" }, { status: "count_derived" }, { status: "undone" }, { status: "insufficient", available: 2, max_amount: 5 }, { status: "mismatch" }, { status: "invalid_input", reason: "amount_not_whole" }]) edits.push((await runE({ rpc: { data: d, error: null } })).r);
check("edit refusals: never ok", edits.map((r) => [r.ok, r.outcome]), [[false, "stale"], [false, "covered"], [false, "unclassifiable"], [false, "count_derived"], [false, "undone"], [false, "insufficient"], [false, "mismatch"], [false, "invalid_input"]]);
check("stale asks to reload; covered names the count and what can still be corrected; insufficient gives the maximum", [edits[0].message, edits[1].message, edits[5].message], [S.STALE_MESSAGE, "This entry belongs to a period already covered by a completed Stock Count of this Lot (started 2026-09-10). Its amount and date can't be changed and it can't be undone, because the count already set this Lot's stock. You can still correct who used it, the note and the QC flag.", "This Lot has only 2 pieces left now, so this entry can be at most 5. Nothing was saved. To record more, correct the Lot's quantity first (Edit Lot or Stock Count)."]);
t = await runE({ rpc: { data: null, error: { code: "PGRST202", message: "Could not find the function public.log_edit" } } });
check("function not applied yet → rejected with a clear message", [t.r.outcome, /database update for it hasn't been applied/.test(t.r.message)], ["rejected", true]);

const net = new TypeError("Failed to fetch");
t = await runE({ rpc: net, readBack: { data: [{ id: req.requestId }], error: null } });
check("lost response: the request's own activity entry is found → recovered, read back by THIS request id (not by values)", [t.r.ok, t.r.outcome, t.calls[1]], [true, "recovered", ["read", "audit_log", "id", req.requestId]]);
t = await runE({ rpc: net, readBack: { data: [], error: null } });
const t2 = await runE({ rpc: net, readBack: new TypeError("Failed to fetch") });
check("not found → not_confirmed (never 'not saved'); check failed → unknown; both say Save again is safe", [t.r.outcome, t2.r.outcome, /press "Save" again — it is safe/.test(t.r.message) && /press "Save" again — it is safe/.test(t2.r.message)], ["not_confirmed", "unknown", true]);
t = await runE({ rpc: { data: null, error: null }, readBack: { data: [], error: null } });
check("no usable answer → checked, never assumed", t.r.outcome, "not_confirmed");
t = await runE({ rpc: {} }, { ...req, requestId: "" });
check("no request id → nothing sent", [t.r.ok, t.calls.length], [false, 0]);

t = await runU({ rpc: { data: { status: "ok", device_reverted: true }, error: null } });
check("undo → one log_undo call: request id, the amount and date the page showed, actor; saved", [t.r.ok, t.r.outcome, t.r.deviceReverted, t.calls[0][1], t.calls[0][2]], [true, "saved", true, "log_undo", { p_request_id: req.requestId, p_log_id: "log-1", p_seen_amount: 3, p_seen_date: "2026-10-01", p_actor: "undoer" }]);
t = await runU({ rpc: { data: { status: "already_undone", deleted_by: "tester2" }, error: null } });
check("already undone by someone else → a final state (ok) with a message; nothing restored again", [t.r.ok, t.r.outcome, t.r.message], [true, "already_undone", "This entry had already been undone by tester2. Nothing was restored again."]);
const undos = [];
for (const d of [{ status: "stale" }, { status: "covered", count_start_day: "2026-09-10" }, { status: "count_derived" }, { status: "unclassifiable" }]) undos.push((await runU({ rpc: { data: d, error: null } })).r);
check("undo refusals: never ok; stale asks to reload", [undos.map((r) => [r.ok, r.outcome]), undos[0].message], [[[false, "stale"], [false, "covered"], [false, "count_derived"], [false, "unclassifiable"]], S.STALE_UNDO_MESSAGE]);
t = await runU({ rpc: net, readBack: { data: [{ id: req.requestId }], error: null } });
const t3 = await runU({ rpc: net, readBack: { data: [], error: null } });
check("undo after a lost response: found by its activity entry → recovered; not found → not_confirmed with 'Undo again is safe'", [t.r.outcome, t3.r.outcome, /Press Undo again — it is safe: an entry can only be undone once/.test(t3.r.message)], ["recovered", "not_confirmed", true]);
check("Spread message", S.SPREAD_UNAVAILABLE, "Spreading an entry over a date range is temporarily unavailable while a version that keeps the original entry in the history is being developed. Use \"Exact date\" for now.");
check("logEditSave.js never writes a table directly — only log_edit / log_undo; it only reads audit_log", [/\.(insert|update|delete|upsert)\(/.test(readSource("logEditSave.js")), /rpc\(fn, args\)/.test(readSource("logEditSave.js")), (readSource("logEditSave.js").match(/from\("([a-z_]+)"\)/g) || [])], [false, true, ['from("audit_log")']]);
}, { expectedChecks: 19 });
