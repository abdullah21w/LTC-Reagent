// Atomic Log Use — the save path (logUseSave.js): strict amount check, the single
// log_use call with the window's reference id, every outcome mapped honestly
// (a read-back only ever RECOGNISES a success), and no direct table writes.
import { suite, check, load, readSource } from "../helpers/core.mjs";

suite("Atomic Log Use · save path (logUseSave.js)", async () => {
const S = await load("logUseSave.js");
const pcs = { unit: "piece", current_quantity: 12 }, ml = { unit: "mL", current_quantity: 100.5 };
const chk = (raw, lot = pcs) => { const r = S.checkUseAmount(raw, lot); return r.ok ? r.value : r.error; };

// ── amount ──
check("valid: whole pieces; mL with up to 2 decimals ('0.10' = 0.1); using all that is left", [chk("3"), chk(" 12 "), chk("0.25", ml), chk("0.10", ml), chk("100.5", ml)], [3, 12, 0.25, 0.1, 100.5]);
check("refused: blank, 0, negative, text, exponent, Infinity, NaN", [chk(""), chk("0"), chk("-2"), chk("abc"), chk("1e2"), chk("Infinity"), chk("NaN")], ["Enter the amount used in pieces.", "Amount used must be more than 0.", "Amount used can't be negative.", "Amount used must be a number.", "Amount used must be written as a plain number (for example 2 or 2.5).", "Amount used must be a number.", "Amount used must be a number."]);
check("refused: fractional countable, 3 decimals measured (never rounded: 0.100000001), over 1,000,000,000", [chk("2.5"), chk("0.125", ml), chk("0.100000001", ml), chk("1000000001", { unit: "mL", current_quantity: 2e9 })], ["Amount used must be a whole number of pieces.", "Amount used can have at most 2 decimals.", "Amount used can have at most 2 decimals.", "Amount used can be at most 1,000,000,000."]);
check("refused: more than the Lot holds (as last loaded) — says how much is left and how to correct the stock", chk("13"), "Only 12 pieces left in this Lot. Enter at most that — or, if more is really there, correct the Lot's quantity first (Edit Lot or Stock Count).");

// ── the call ──
const entry = { logId: "11111111-1111-4111-8111-111111111111", reagentId: "lot-1", amount: 3, date: "2026-10-13", usedBy: "tester", note: "n", testedByQC: true, replaceOnDevice: false, confirmLotToLotId: "ltl-1", lotToLot: true, unit: "piece" };
check("log_use arguments: the window's id, the Lot, the exact amount, date, who, note, QC, device choice, Lot-to-Lot, actor", S.logUseArgs(entry, "owner1"), { p_log_id: entry.logId, p_reagent_id: "lot-1", p_amount: 3, p_date: "2026-10-13", p_used_by: "tester", p_note: "n", p_tested_by_qc: true, p_replace_on_device: false, p_lot_to_lot: true, p_confirm_ltl_id: "ltl-1", p_actor: "owner1" });
check("defaults: no note → '', replace on device unless false, no Lot-to-Lot", (({ p_note, p_replace_on_device, p_lot_to_lot, p_confirm_ltl_id }) => [p_note, p_replace_on_device, p_lot_to_lot, p_confirm_ltl_id])(S.logUseArgs({ logId: "x", reagentId: "y", amount: 1, date: "d", usedBy: "u" }, "a")), ["", true, false, null]);
check("two windows get different ids (v4 UUIDs)", (() => { const a = S.newLogId(), b = S.newLogId(); return [a !== b, /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(a)]; })(), [true, true]);

// fake client: rpc answer + read-back answer, recording every call
const fake = ({ rpc, readBack }) => {
  const calls = [];
  return { calls, rpc: async (fn, args) => { calls.push(["rpc", fn, args]); if (rpc instanceof Error) throw rpc; return typeof rpc === "function" ? rpc() : rpc; },
    from: (t) => { const q = { select: () => q, eq: (f, v) => { calls.push(["read", t, f, v]); return q; }, then: (res, rej) => (readBack instanceof Error ? Promise.reject(readBack) : Promise.resolve(readBack)).then(res, rej) };
      ["insert", "update", "delete", "upsert"].forEach((k) => { q[k] = () => { calls.push(["WRITE", t, k]); return q; }; }); return q; } };
};
const run = async (o, e = entry) => { const c = fake(o); const r = await S.saveLogUse({ client: c, entry: e, actor: "owner1" }); return { r, calls: c.calls }; };
const same = { id: entry.logId, reagent_id: "lot-1", amount: "3", date: "2026-10-13", used_by: "tester", note: "n", tested_by_qc: true, date_provenance: "manual", source_count_item_id: null, deleted: false };

let t = await run({ rpc: { data: { status: "ok", log_id: entry.logId, auto_removed: true, lot_to_lot_flagged: true }, error: null } });
check("ok → saved (with auto-remove / Lot-to-Lot flags); exactly one log_use call with this id; no direct table write, no read-back", [t.r.ok, t.r.outcome, t.r.autoRemoved, t.r.lotToLotFlagged, t.calls.length, t.calls[0][1], t.calls[0][2].p_log_id], [true, "saved", true, true, 1, "log_use", entry.logId]);
t = await run({ rpc: { data: { status: "already_saved", log_deleted: true }, error: null } });
check("already_saved → a success (same submission, recorded once); says if it was undone since", [t.r.ok, t.r.outcome, t.r.logDeleted], [true, "already_saved", true]);
t = await run({ rpc: { data: { status: "mismatch" }, error: null } });
check("mismatch → NOT a success, with its message", [t.r.ok, t.r.outcome, t.r.message], [false, "mismatch", S.MISMATCH_MESSAGE]);
t = await run({ rpc: { data: { status: "insufficient", available: 2 }, error: null } });
check("insufficient → nothing recorded; says how much is left now and how to correct stock", [t.r.ok, t.r.outcome, t.r.available, t.r.message], [false, "insufficient", 2, "Only 2 pieces left in this Lot now (another use may have just been recorded). Nothing was recorded. Enter at most that — or, if more is really there, correct the Lot's quantity first (Edit Lot or Stock Count)."]);
const msgs = [];
for (const d of [{ status: "lot_not_found" }, { status: "lot_removed" }, { status: "lot_changed" }, { status: "reserved_user" }, { status: "invalid_input", reason: "amount_not_whole" }]) msgs.push((await run({ rpc: { data: d, error: null } })).r);
check("other refusals: never ok, each says nothing was recorded", msgs.map((r) => [r.ok, r.outcome, /Nothing was recorded/.test(r.message)]), [[false, "lot_not_found", true], [false, "lot_removed", true], [false, "lot_changed", true], [false, "reserved_user", true], [false, "invalid_input", true]]);
t = await run({ rpc: { data: null, error: { code: "PGRST202", message: "Could not find the function public.log_use" } } });
const t2 = await run({ rpc: { data: null, error: { code: "42501", message: "permission denied for table consumption_logs" } } });
check("database refusals: function not applied yet / no permission → rejected with a clear message, no read-back", [t.r.outcome, /database update for it hasn't been applied/.test(t.r.message), t2.r.outcome, /don't have permission/.test(t2.r.message), t.calls.length + t2.calls.length], ["rejected", true, "rejected", true, 2]);

// ── uncertain outcomes: read-back by the same id ──
const net = Object.assign(new TypeError("Failed to fetch"));
t = await run({ rpc: net, readBack: { data: [same], error: null } });
check("network failure, the log is there with the same values → recovered (a success), read back by THIS id", [t.r.ok, t.r.outcome, t.calls[1]], [true, "recovered", ["read", "consumption_logs", "id", entry.logId]]);
t = await run({ rpc: net, readBack: { data: [{ ...same, amount: "4" }], error: null } });
check("network failure, a log with this id but other values → mismatch (never a success)", [t.r.ok, t.r.outcome], [false, "mismatch"]);
t = await run({ rpc: net, readBack: { data: [], error: null } });
check("network failure, not found → not_confirmed (never 'not saved'); advice to retry in the same window", [t.r.ok, t.r.outcome, t.r.message], [false, "not_confirmed", S.NOT_CONFIRMED_MESSAGE]);
t = await run({ rpc: net, readBack: new TypeError("Failed to fetch") });
check("network failure and the check fails too → unknown", [t.r.ok, t.r.outcome, t.r.message], [false, "unknown", S.UNKNOWN_MESSAGE]);
t = await run({ rpc: { data: null, error: { message: "TypeError: Failed to fetch" } }, readBack: { data: [same], error: null } });
check("a network error returned (not thrown) is handled the same way (recovered)", t.r.outcome, "recovered");
t = await run({ rpc: { data: null, error: null }, readBack: { data: [], error: null } });
check("no usable answer at all → checked, never assumed (not_confirmed)", t.r.outcome, "not_confirmed");
t = await run({ rpc: { data: { status: "ok" } } }, { ...entry, logId: "" });
check("no reference id → nothing sent", [t.r.ok, t.calls.length], [false, 0]);
check("messages always tell the person to stay in the same window to retry, never to start again", [S.UNKNOWN_MESSAGE, S.NOT_CONFIRMED_MESSAGE].every((m) => /Keep this window open/.test(m) && /can only ever be recorded once/.test(m) && /Don't log it again in a new window/.test(m)), true);
check("sameUse compares every submitted field (Lot, amount, date, who, note, QC) and that it is a manual log", [S.sameUse(entry, same), S.sameUse(entry, { ...same, note: "x" }), S.sameUse(entry, { ...same, tested_by_qc: false }), S.sameUse(entry, { ...same, date_provenance: "count_exact" }), S.sameUse(entry, { ...same, source_count_item_id: "l" })], [true, false, false, false, false]);
check("logUseSave.js never writes a table directly — only the log_use function", [/\.(insert|update|delete|upsert)\(/.test(readSource("logUseSave.js")), /\.rpc\("log_use"/.test(readSource("logUseSave.js"))], [false, true]);
}, { expectedChecks: 23 });
