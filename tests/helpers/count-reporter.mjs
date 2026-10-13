// Deterministic test-count reporter (used next to the spec reporter).
//
// Node's runner counts every suite as one test PLUS each of its checks as a test, so
// "tests" in its summary = checks + suites. This reporter reports both separately, per
// suite, and compares them with tests/expected-counts.json: a suite that is missing,
// unexpected, or ran a different number of checks makes the run fail. The summary is
// also written to tests/.cache/last-run.json for reports.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TESTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(TESTS, "expected-counts.json"), "utf8"));
const rel = (f) => (f ? path.relative(TESTS, f).split(path.sep).join("/") : "?");

export default async function* countReporter(source) {
  // Each suite() emits a self-describing "ltc-count {...}" diagnostic (files run in parallel,
  // so check events can't be attributed to suites reliably). A suite whose body threw never
  // emits it and is reported as incomplete.
  const suites = new Map(); // suite name → { file, pass, fail, ok, counted }
  const fileOf = new Map();  // suite name → file, from the manifest
  for (const g of Object.values(manifest)) if (g && typeof g === "object") for (const [file, entries] of Object.entries(g)) for (const name of Object.keys(entries)) fileOf.set(name, file);
  const manifestFile = (name) => fileOf.get(name) ?? fileOf.get(name.replace(/\(PostgreSQL [^)]+\)$/, "(PostgreSQL {v})")) ?? "?";
  const loadErrors = [];
  for await (const ev of source) {
    const d = ev.data;
    if (ev.type === "test:diagnostic" && typeof d.message === "string" && d.message.startsWith("ltc-count ")) {
      const r = JSON.parse(d.message.slice("ltc-count ".length));
      const s = suites.get(r.suite) || { file: manifestFile(r.suite), ok: false };
      Object.assign(s, { pass: r.passed, fail: r.failed, counted: true });
      suites.set(r.suite, s);
    } else if ((ev.type === "test:pass" || ev.type === "test:fail") && d.nesting === 0) {
      if (/\.test\.mjs$/.test(d.name)) { if (ev.type === "test:fail") loadErrors.push(`${d.name}: ${String(d.details?.error?.message || "failed").split("\n")[0].slice(0, 200)}`); continue; }
      const s = suites.get(d.name) || { file: manifestFile(d.name), pass: 0, fail: 0, counted: false };
      s.ok = ev.type === "test:pass";
      if (!s.ok) s.error = String(d.details?.error?.cause?.message || d.details?.error?.message || "failed").split("\n")[0].slice(0, 200);
      suites.set(d.name, s);
    }
  }

  // Which groups ran: from the runner's own command-line patterns (argv[1] is the first pattern).
  const args = process.argv.slice(1).join(" ");
  const groups = ["unit", "ui", "pg"].filter((g) => new RegExp(`(^|[\\s"'/\\\\])${g}/`).test(args));
  const versions = (process.env.TEST_PG_VERSIONS || "15,17").split(",").map((s) => s.trim()).filter(Boolean);
  const expected = new Map();
  for (const g of groups) for (const [file, entries] of Object.entries(manifest[g] || {})) for (const [name, checks] of Object.entries(entries)) {
    for (const v of g === "pg" ? versions : [null]) expected.set(v ? name.replace("{v}", v) : name, { file, checks });
  }
  const rows = [], problems = [];
  for (const [name, exp] of expected) {
    const s = suites.get(name);
    const ran = s ? s.pass + s.fail : 0;
    let status = "ok";
    if (!s) { status = "MISSING"; problems.push(`MISSING suite: ${name} (${exp.file})`); }
    else if (!s.counted) { status = "INCOMPLETE"; problems.push(`INCOMPLETE suite (stopped before reporting its checks): ${name}${s.error ? ` — ${s.error}` : ""}`); }
    else if (ran !== exp.checks) { status = "MISMATCH"; problems.push(`COUNT MISMATCH: ${name}: ran ${ran} checks, expected ${exp.checks}`); }
    else if (!s.ok || s.fail) { status = "FAILED"; problems.push(`FAILED: ${name}: ${s.fail} of ${ran} checks failed${s.error ? ` — ${s.error}` : ""}`); }
    rows.push({ suite: name, file: exp.file, expected: exp.checks, ran, passed: s?.pass ?? 0, failed: s?.fail ?? 0, status });
  }
  for (const [name, s] of suites) if (!expected.has(name)) { problems.push(`UNEXPECTED suite (not in expected-counts.json): ${name} (${s.file})`); rows.push({ suite: name, file: s.file, expected: null, ran: (s.pass ?? 0) + (s.fail ?? 0), passed: s.pass ?? 0, failed: s.fail ?? 0, status: "UNEXPECTED" }); }
  for (const e of loadErrors) problems.push(`FILE FAILED TO RUN: ${e}`);

  const totalChecks = rows.reduce((a, r) => a + r.ran, 0), passed = rows.reduce((a, r) => a + r.passed, 0), failed = rows.reduce((a, r) => a + r.failed, 0);
  const expectedChecks = [...expected.values()].reduce((a, e) => a + e.checks, 0);
  const lines = ["", "══ Test count summary (checks per suite, from tests/expected-counts.json) ══"];
  for (const r of rows) lines.push(`${r.status.padEnd(10)} ${String(r.ran).padStart(4)}${r.expected === null ? "" : ` / ${String(r.expected).padEnd(4)}`}  ${r.suite}`);
  lines.push(`groups run: ${groups.join(", ") || "(none recognised)"}${groups.includes("pg") ? `   PostgreSQL versions: ${versions.join(", ")}` : ""}`);
  lines.push(`TOTAL: ${totalChecks} checks in ${rows.length} suites (expected ${expectedChecks} in ${expected.size}); ${passed} passed, ${failed} failed.`);
  lines.push(`Node's own "tests" figure = checks + suites = ${totalChecks + rows.length}.`);
  if (problems.length) { lines.push("PROBLEMS:", ...problems.map((p) => `  ✖ ${p}`)); process.exitCode = 1; }
  else if (failed === 0 && rows.every((r) => r.status === "ok")) lines.push("All expected suites ran with exactly the expected number of checks.");
  mkdirSync(path.join(TESTS, ".cache"), { recursive: true });
  writeFileSync(path.join(TESTS, ".cache", "last-run.json"), JSON.stringify({ groups, versions: groups.includes("pg") ? versions : [], totalChecks, suites: rows.length, passed, failed, expectedChecks, expectedSuites: expected.size, problems, rows }, null, 1));
  yield lines.join("\n") + "\n";
}
