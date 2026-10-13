// A database with the full schema as on Production before U2a, holding the synthetic
// Stock Count history (tests/fixtures/backfillHistory.mjs).
//   before: migrations applied before the history is loaded
//   after:  migrations applied after it (e.g. the evidence rollout stages)
import { readdirSync } from "node:fs";
import { readRoot, rootPath } from "./core.mjs";
import { ensureRoles } from "./pg.mjs";
import { loadBackfillHistory } from "../fixtures/backfillHistory.mjs";

export const EVIDENCE_CHAIN = ["ADD_INVENTORY_COUNTS.sql", "ADD_COUNT_LOG_LINKS.sql", "ADD_ONE_OPEN_COUNT_PER_SCOPE.sql", "ADD_EVIDENCE_FOUNDATION.sql", "ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql", "ADD_STOCK_COUNT_START.sql", "ADD_EVIDENCE_GUARD.sql"];
const STAGE_FILES = new Set([...EVIDENCE_CHAIN, "ADD_HISTORICAL_EVIDENCE_BACKFILL.sql"]);

export async function historyDb(server, tables, { before = EVIDENCE_CHAIN, after = [] } = {}) {
  const c = await server.connect(await server.createDatabase());
  await ensureRoles(c);
  await c.query("grant usage on schema public to anon, authenticated; alter default privileges in schema public grant all on tables to anon, authenticated; alter default privileges in schema public grant execute on functions to anon, authenticated;");
  await c.query(readRoot("supabase_schema.sql"));
  // older optional files (some need Supabase-only extensions and are skipped when they fail)
  for (const f of readdirSync(rootPath()).filter((f) => /^ADD_.*\.sql$/.test(f) && !/^ADD_PACKAGING_|^ADD_STOCK_COUNT_START_V2/.test(f) && !STAGE_FILES.has(f)).sort()) {
    try { await c.query("savepoint o"); await c.query(readRoot(f)); await c.query("release savepoint o"); } catch { try { await c.query("rollback to savepoint o"); } catch {} }
  }
  for (const f of before) await c.query(readRoot(f));
  await c.query("grant all on all tables in schema public to anon, authenticated;");
  await loadBackfillHistory(c, tables);
  for (const f of after) await c.query(readRoot(f));
  return c;
}
