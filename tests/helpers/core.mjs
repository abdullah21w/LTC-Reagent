// Shared test helpers. No absolute paths: everything is resolved from this file's
// location, so the suite runs from any clean checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import * as esbuild from "esbuild";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CACHE = path.join(ROOT, "tests", ".cache");
export const rootPath = (...p) => path.join(ROOT, ...p);
export const readRoot = (f) => readFileSync(rootPath(f), "utf8");
/** Source with Windows line endings normalised (App.jsx is CRLF). */
export const readSource = (f) => readRoot(f).replace(/\r\n/g, "\n");

let current = null;
/**
 * One named assertion, compared as JSON — the same semantics the original
 * review suites used (key order and undefined-vs-missing matter; -0 = 0).
 * Must be called inside suite(); each check is reported as its own subtest.
 */
export function check(name, actual, expected) {
  if (!current) throw new Error(`check("${name}") called outside suite()`);
  current.push([name, actual, expected]);
}

/**
 * A test file's body. The runner awaits the whole (async) body, so no check can be
 * skipped by an early exit; if the body throws, the suite fails with that error.
 * The number of checks that ran is reported, and must equal `expectedChecks` when
 * given (guards against a refactor silently dropping assertions).
 */
export function suite(name, body, { expectedChecks } = {}) {
  test(name, async (t) => {
    const list = [];
    current = list;
    try { await body(); } finally { current = null; }
    let passed = 0, failed = 0;
    for (const [n, actual, expected] of list) {
      await t.test(n, () => {
        try { assert.equal(JSON.stringify(actual), JSON.stringify(expected), `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); passed++; }
        catch (e) { failed++; throw e; }
      });
    }
    t.diagnostic(`${list.length} checks`);
    // Machine-readable count for helpers/count-reporter.mjs (self-describing: files run in parallel).
    t.diagnostic(`ltc-count ${JSON.stringify({ suite: name, ran: list.length, passed, failed, expected: expectedChecks ?? null })}`);
    if (expectedChecks !== undefined) assert.equal(list.length, expectedChecks, `expected ${expectedChecks} checks to run, ${list.length} ran`);
  });
}

let seq = 0;
/**
 * Bundles app source with esbuild (resolving the app's own dependencies from the
 * repository's node_modules) into tests/.cache and imports it.
 *   entry:    a repository file ("units.js") or { contents } for a virtual entry
 *   plugins:  esbuild plugins (e.g. the Supabase stub)
 */
export async function load(entry, { plugins = [], dom = false } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const outfile = path.join(CACHE, `bundle-${process.pid}-${++seq}.mjs`);
  const base = { bundle: true, format: "esm", platform: "node", outfile, logLevel: "error", plugins };
  const virtual = typeof entry === "object";
  await esbuild.build({
    ...base,
    ...(virtual ? { stdin: { contents: entry.contents, resolveDir: ROOT, loader: "js" } } : { entryPoints: [rootPath(entry)] }),
    ...(dom || virtual ? {
      define: { "process.env.NODE_ENV": '"development"', "import.meta.env.VITE_SUPABASE_URL": '""', "import.meta.env.VITE_SUPABASE_ANON_KEY": '""' },
      banner: { js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);' },
    } : {}),
  });
  return import(pathToFileURL(outfile).href);
}

/** Absolute import path for a repository file, usable inside a virtual entry. */
export const src = (f) => rootPath(f).replace(/\\/g, "/");

/**
 * esbuild plugin: replaces supabaseClient.js with `stubSource` (a JS module that
 * exports `supabase`), and re-exports extra names from App.jsx for testing.
 * No test ever reaches a real database or the network.
 */
export function appPlugin({ stubSource, appExports = [] }) {
  return {
    name: "ltc-test-app",
    setup(b) {
      b.onResolve({ filter: /supabaseClient$/ }, () => ({ path: "stub", namespace: "ltc-stub" }));
      b.onLoad({ filter: /.*/, namespace: "ltc-stub" }, () => ({ contents: stubSource, loader: "js" }));
      if (appExports.length) {
        b.onLoad({ filter: /App\.jsx$/ }, (a) => ({ contents: readFileSync(a.path, "utf8") + `\nexport { ${appExports.join(", ")} };\n`, loader: "jsx" }));
      }
    },
  };
}

/** Today's date (UTC) shifted by -n days, as YYYY-MM-DD. */
export function daysAgo(n, from = new Date().toISOString().slice(0, 10)) {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
