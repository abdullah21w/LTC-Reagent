import { createHash } from "node:crypto";
/** Deterministic UUID (v4 layout) from a label, so fixtures can refer to rows by name. */
export const uuidOf = (s) => { const h = createHash("md5").update(s).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
/** Key-order-independent form (jsonb stores keys in its own order). */
export const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" && !(v instanceof Date) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
