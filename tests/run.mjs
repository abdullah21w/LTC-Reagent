// Test entry point:  node run.mjs <unit|ui|pg>...
// Runs the chosen groups with Node's test runner (spec output on screen), then prints the
// per-suite count summary written by helpers/count-reporter.mjs and fails if any suite is
// missing, incomplete, unexpected, ran a different number of checks than
// expected-counts.json says, or failed — or if the summary itself was not produced.
// (The summary goes through a file because --test-force-exit, needed for jsdom/React
// handles, can end the process before a second stdout reporter has flushed.)
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const groups = process.argv.slice(2);
const bad = groups.filter((g) => !["unit", "ui", "pg"].includes(g));
if (!groups.length || bad.length) { console.error(`usage: node run.mjs <unit|ui|pg>...  (unknown: ${bad.join(", ")})`); process.exit(2); }
const summaryFile = path.join(TESTS, ".cache", "count-summary.txt"), jsonFile = path.join(TESTS, ".cache", "last-run.json");
mkdirSync(path.dirname(summaryFile), { recursive: true }); // absent on a fresh checkout
rmSync(summaryFile, { force: true }); rmSync(jsonFile, { force: true });
const args = [
  "--test", "--test-force-exit",
  ...(groups.includes("pg") ? ["--test-concurrency=1", "--test-timeout=900000"] : []),
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  "--test-reporter=./helpers/count-reporter.mjs", `--test-reporter-destination=${path.relative(TESTS, summaryFile)}`,
  ...groups.map((g) => `${g}/*.test.mjs`),
];
const r = spawnSync(process.execPath, args, { cwd: TESTS, stdio: "inherit", env: process.env });
if (!existsSync(summaryFile) || !existsSync(jsonFile)) { console.error("\n✖ The test-count summary was not produced — treating the run as failed."); process.exit(1); }
process.stdout.write(readFileSync(summaryFile, "utf8"));
const summary = JSON.parse(readFileSync(jsonFile, "utf8"));
const ok = r.status === 0 && summary.problems.length === 0 && summary.failed === 0 && summary.totalChecks === summary.expectedChecks;
process.exit(ok ? 0 : 1);
