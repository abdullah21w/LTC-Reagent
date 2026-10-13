// PostgreSQL integration helpers.
//
// By default each version listed in TEST_PG_VERSIONS (default "15,17") runs on a
// throw-away embedded PostgreSQL server (npm package embedded-postgres; binaries
// come from npm, nothing is downloaded at test time). The data directory is created
// in the OS temp folder and removed afterwards. Every connection is to 127.0.0.1.
//
// TEST_PG_URL=postgres://user:pass@host:port/db may point at an existing server
// instead (e.g. in CI). The suites create and drop their own databases and two
// roles (anon, authenticated) on it, so never point it at a real project.
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { readRoot, rootPath } from "./core.mjs";

// DATE columns as "YYYY-MM-DD" text, exactly like Supabase/PostgREST returns them.
pg.types.setTypeParser(1082, (v) => v);

export const PG_VERSIONS = (process.env.TEST_PG_VERSIONS || "15,17").split(",").map((s) => s.trim()).filter(Boolean);

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.unref();
  s.on("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** Creates the given roles if missing (roles are cluster-wide). */
export async function ensureRoles(c, names = ["anon", "authenticated"]) {
  for (const n of names) await c.query(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${n}') then create role ${n} nologin; end if; end $$;`);
}

/**
 * Test-only fault injection (never part of a migration): a trigger on each listed
 * table counts its firings per transaction and raises "injected fault at <table>_<op>_<when>_<n>"
 * when `set test.fault = '<that key>'` is active on the connection.
 */
export const faultTriggers = (tables) => `
  create or replace function zz_test_fault() returns trigger language plpgsql as $$
  declare k text := tg_table_name || '_' || lower(tg_op) || '_' || lower(tg_when); n int;
  begin
    n := coalesce(nullif(current_setting('test.n_' || k, true), ''), '0')::int + 1;
    perform set_config('test.n_' || k, n::text, true);
    if current_setting('test.fault', true) = k || '_' || n then raise exception 'injected fault at %', k || '_' || n; end if;
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end $$;
  ${tables.map((t) => `
  create trigger zz_test_before before insert or update or delete on ${t} for each row execute function zz_test_fault();
  create trigger zz_test_after after insert or update or delete on ${t} for each row execute function zz_test_fault();`).join("")}`;

/** Polls pg_stat_activity until backend `pid` waits on a lock (max ~5 s). Returns { waited, event }. */
export async function waitForLock(admin, pid) {
  for (let i = 0; i < 250; i++) {
    const w = (await admin.query("select wait_event_type t, wait_event e from pg_stat_activity where pid = $1", [pid])).rows[0];
    if (w?.t === "Lock") return { waited: true, event: w.e };
    await new Promise((r) => setTimeout(r, 20));
  }
  return { waited: false, event: null };
}

/** Deterministic UUID from a label (same scheme as the original review suites). */
export { uuidOf } from "./uuid.mjs";

/** Starts a server for `version` (or uses TEST_PG_URL). Returns { version, connect(db), createDatabase(), stop() }. */
export async function startPostgres(version, { flags = [] } = {}) {
  if (process.env.TEST_PG_URL) {
    const base = new URL(process.env.TEST_PG_URL);
    const admin = new pg.Client({ connectionString: base.toString() });
    await admin.connect();
    const created = [];
    return {
      version: (await admin.query("show server_version")).rows[0].server_version,
      connect: async (db) => { const u = new URL(base); u.pathname = `/${db}`; const c = new pg.Client({ connectionString: u.toString() }); await c.connect(); await c.query("set timezone = 'UTC'"); return c; },
      async createDatabase() { const name = `ltc_test_${randomBytes(4).toString("hex")}`; await admin.query(`create database ${name}`); created.push(name); return name; },
      async stop() { for (const n of created) { try { await admin.query(`drop database if exists ${n} with (force)`); } catch {} } await admin.end(); },
    };
  }
  const mod = await import(`embedded-postgres-${version}`);
  const EmbeddedPostgres = mod.default?.default || mod.default;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), `ltc-pg${version}-`));
  rmSync(dataDir, { recursive: true, force: true }); // embedded-postgres wants to create it
  const port = await freePort();
  const password = randomBytes(12).toString("hex"); // local, throw-away server
  const server = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password, port, persistent: false, createPostgresUser: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-c", "listen_addresses=127.0.0.1", ...flags.flatMap((f) => ["-c", f])], onLog: () => {}, onError: () => {} });
  await server.initialise();
  await server.start();
  let n = 0;
  const connect = async (db) => { const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password, database: db }); await c.connect(); await c.query("set timezone = 'UTC'"); return c; };
  return {
    version: String(version),
    connect,
    async createDatabase() { const name = `ltc_test_${++n}`; const c = await connect("postgres"); await c.query(`create database ${name}`); await c.end(); return name; },
    async stop() {
      try { await server.stop(); } catch {}
      // On Windows the server's files can stay locked for a moment after shutdown.
      try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
      catch (e) { console.warn(`could not remove the temporary database folder ${dataDir}: ${e.message}`); }
    },
  };
}

// The repository's schema files, applied the way Production has them.
export const CHAIN = ["ADD_INVENTORY_COUNTS.sql", "ADD_COUNT_LOG_LINKS.sql", "ADD_ONE_OPEN_COUNT_PER_SCOPE.sql", "ADD_EVIDENCE_FOUNDATION.sql", "ADD_ATOMIC_STOCK_COUNT_FUNCTIONS.sql", "ADD_STOCK_COUNT_START.sql", "ADD_EVIDENCE_GUARD.sql"];
export const U2A = ["ADD_PACKAGING_FOUNDATION.sql", "ADD_STOCK_COUNT_START_V2.sql", "ADD_PACKAGING_GUARDS.sql"];
// Applied by the suites that test them, in Production order (after U2a).
export const LOG_USE = ["ADD_ATOMIC_LOG_USE.sql"];
const SKIP = new Set([...CHAIN, ...U2A, ...LOG_USE, "ADD_HISTORICAL_EVIDENCE_BACKFILL.sql"]);

/**
 * Builds the pre-U2a schema: supabase_schema.sql, the older ADD_*.sql files
 * (some need Supabase-only extensions such as pg_cron/pg_net and are skipped when
 * they fail — they don't touch inventory tables), then the evidence chain in order.
 * Returns the list of optional files that could not be applied, for diagnostics.
 */
export async function buildBaseSchema(c) {
  await c.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  end $$;`);
  await c.query("grant usage on schema public to anon, authenticated; alter default privileges in schema public grant all on tables to anon, authenticated;");
  await c.query(readRoot("supabase_schema.sql"));
  const skipped = [];
  for (const f of readdirSync(rootPath()).filter((f) => /^ADD_.*\.sql$/.test(f) && !SKIP.has(f)).sort()) {
    try { await c.query("savepoint opt"); await c.query(readRoot(f)); await c.query("release savepoint opt"); }
    catch (e) { skipped.push(`${f}: ${e.message}`); try { await c.query("rollback to savepoint opt"); } catch {} }
  }
  for (const f of CHAIN) await c.query(readRoot(f));
  return skipped;
}
export async function applyU2a(c) { for (const f of U2A) await c.query(readRoot(f)); }
export async function applyLogUse(c) { for (const f of LOG_USE) await c.query(readRoot(f)); }

/** Runs `sql`; returns null on success or "message/detail" on error (never throws). Inside inTx each statement gets a savepoint. */
export async function err(c, sql, params) {
  if (c.__inTx) await c.query("savepoint s");
  try { await c.query(sql, params); if (c.__inTx) await c.query("release savepoint s"); return null; }
  catch (e) { if (c.__inTx) await c.query("rollback to savepoint s"); return `${e.message}${e.detail ? "/" + e.detail : ""}`; }
}
/** Runs fn inside a transaction that is always rolled back. */
export async function inTx(c, fn) { await c.query("begin"); c.__inTx = true; try { return await fn(); } finally { c.__inTx = false; await c.query("rollback"); } }
export async function asAnon(c, fn) { return inTx(c, async () => { await c.query("set local role anon"); return fn(); }); }

export const TABLES = ["reagents", "consumption_logs", "inventory_counts", "inventory_count_items", "audit_log"];
/** Every row of every inventory table (optionally without some columns), as JSON — for "nothing else changed" checks. */
export async function dumpAll(c, { without = [] } = {}) {
  const minus = without.map((col) => ` - '${col}'`).join("");
  const out = {};
  for (const t of TABLES) out[t] = JSON.stringify((await c.query(`select to_jsonb(x)${minus} j from ${t} x order by id`)).rows);
  return out;
}

/**
 * Supabase-client subset used by lotEdit.saveLotEdit and receiveSave.saveReceipt (from(t).update()/insert().eq().is().select()),
 * executed as SQL on a pg connection — one UPDATE … WHERE … RETURNING, like PostgREST.
 */
export function pgClient(conn) {
  const qi = (n) => `"${n}"`;
  async function exec(st) {
    const params = [];
    const where = st.filters.map(([f, op, v]) => (op === "is" ? `${qi(f)} is null` : (params.push(v), `${qi(f)} = $${params.length}`))).join(" and ");
    try {
      if (st.op === "insert") {
        const cols = Object.keys(st.values);
        const r = await conn.query(`insert into ${st.table} (${cols.map(qi).join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning ${st.cols || "id"}`, cols.map((k) => st.values[k]));
        return { data: r.rows, error: null };
      }
      if (st.op === "update") {
        const sets = Object.entries(st.values).map(([k, v]) => (params.push(v), `${qi(k)} = $${params.length}`));
        const r = await conn.query(`update ${st.table} set ${sets.join(", ")} where ${where} returning ${st.cols || "id"}`, params);
        return { data: r.rows, error: null };
      }
      const r = await conn.query(`select ${st.cols || "*"} from ${st.table}${where ? ` where ${where}` : ""}`, params);
      return { data: r.rows, error: null };
    } catch (e) { return { data: null, error: { message: e.message, details: e.detail ?? null, code: e.code } }; }
  }
  return { from(table) {
    const st = { table, op: "select", values: null, filters: [], cols: null };
    const b = {
      update(v) { st.op = "update"; st.values = v; return b; },
      insert(v) { st.op = "insert"; st.values = v; return b; },
      eq(f, v) { st.filters.push([f, "=", v]); return b; },
      is(f, v) { st.filters.push([f, "is", v]); return b; },
      select(cols) { st.cols = cols; return b; },
      then(res, rej) { return exec(st).then(res, rej); },
    };
    return b;
  } };
}
