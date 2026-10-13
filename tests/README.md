# LTC Lab Inventory — automated tests

These tests protect inventory integrity: quantities are never converted behind the
user's back, different units are never added together, Lots with history keep their
meaning, concurrent edits can't overwrite each other, and failed writes are reported
honestly.

They use **synthetic data only** (`tests/fixtures/`). No Production snapshot, real
reagent names, Lot numbers or staff accounts are used or stored, and no test ever
connects to Supabase or any other network service. The database used by the
PostgreSQL tests is a throw-away local server.

The test tools live in their own package (`tests/package.json`), separate from the
app's dependencies, so the app's install and the Vercel build are unchanged.

## Prerequisites

- **Node.js 22 or newer** (the built-in test runner is used; no other framework).
- The app's own dependencies installed at the repository root (`npm ci`), because
  the tests render the real React components with the real libraries.
- About 300 MB of disk for the test tools (two PostgreSQL builds, 15 and 17,
  downloaded from npm by `test:setup`). Nothing is downloaded while tests run.
- Windows, macOS or Linux (x64; arm64 on macOS/Linux). On Linux, run as a normal
  user, not root — PostgreSQL refuses to start as root.

## Commands

From the repository root:

```bash
npm ci
```

```bash
npm run test:setup
```

```bash
npm test
```

```bash
npm run test:pg
```

```bash
npm run test:all
```

| Command | What it runs |
|---|---|
| `npm run test:setup` | installs the test tools from `tests/package-lock.json` (exact versions) — once |
| `npm test` | unit + UI suites (`tests/unit`, `tests/ui`) — a few seconds |
| `npm run test:pg` | PostgreSQL suites (`tests/pg`) on PostgreSQL 15 **and** 17 — a few minutes |
| `npm run test:all` | everything |

Inside `tests/` the same scripts exist, plus `npm run test:unit` and `npm run test:ui`.
All of them go through `tests/run.mjs`.

Options (environment variables):

- `TEST_PG_VERSIONS=17` — run the PostgreSQL suites on one version only.
- `TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/postgres` — use an existing,
  disposable PostgreSQL server instead of the embedded one (e.g. in CI). The
  suites create and drop their own databases and create the roles `anon`,
  `authenticated` and `other`. **Never point this at a real or shared database.**

## Test counts are deterministic

Every suite and its exact number of checks is listed in `tests/expected-counts.json`.
After each run, `run.mjs` prints a per-suite table and the totals, and **fails** if a
suite is missing, stopped before reporting its checks (incomplete), ran a different
number of checks than listed, is not listed, or failed — or if the summary itself
could not be produced. The same summary is written to `tests/.cache/last-run.json`.

Node's runner prints its own "tests" figure, which counts each suite once **plus**
each of its checks: that figure is always checks + suites (e.g. 436 checks in 7
suites → 443). Reports should quote the checks.

## What is covered

### Unit and UI (`npm test`)

| Suite | File | Checks | Protects |
|---|---|---|---|
| U1 unit engine | `unit/units.test.mjs` | 109 | unit spellings, whole vs measured quantities, box splits, never adding different units, saved package names, allocation rounding; `units.js` pure and imported only where allowed |
| Edit Lot rules + save | `unit/lotEdit.test.mjs` | 125 | U0 typed numbers stored as-is, unit/packaging locked on Lots with history; U2c-1 only changed fields written, each guarded by its original value, conflict / missing / network / database refusals, activity logged only after a confirmed save, failure reported, never retried; U2c-2 package-name rules, legacy values kept |
| Forecasts | `unit/forecast.test.mjs` | 29 | U2b mixed-unit groups, nothing dropped, per-unit low stock, neutral pack wording, shared low-evidence rule |
| Reconciliation evidence | `unit/evidence.test.mjs` | 49 | Batch E classification of every provenance value, discrepancy, allocation vs physical shortage, validator errors vs historical warnings, readiness status |
| Edit Lot window | `ui/editLot.test.mjs` | 51 | real component: errors keep the window open, one save per tap, package-name controls, lock panel on Lots with history |
| Log use window | `ui/logUse.test.mjs` | 25 | U2c-3 display wording; the saved amount is exactly what was typed |
| Stock screens | `ui/screens.test.mjs` | 48 | U2b Charts, History, Detail, Dashboard, Reorder, Public summary, PDF report, monthly report (network mocked) |

### PostgreSQL (`npm run test:pg`, each suite on 15 and 17)

| Suite | File | Checks per version | Protects |
|---|---|---|---|
| Packaging schema | `pg/packaging.test.mjs` | 55 | U2a pre-check, migration ×2, verify, Lot packaging guard, constraints, Stock Count v2 snapshots, app statements, rollback, snapshot protection after rollback |
| Edit Lot save | `pg/editLotSave.test.mjs` | 42 | U2c-1/U2c-2: concurrent consumption vs edits, two editors, NULL conditions, guard refusals surfaced, denied activity entry, history appearing mid-edit |
| Stock Count functions | `pg/stockCountFunctions.test.mjs` | 459 | window parity with the browser (lab time zone, midnight edges), parity with recorded client writes, auto-remove rule, result contract (every refusal writes nothing), fault injection at every write step (nothing committed, retry once), two-connection concurrency, lost-response retry, Edit dates, guard against direct mutation, current app writes |
| Scope rule | `pg/scopeRule.test.mjs` | 119 | one open count per department / Whole lab: sequential, truly concurrent (advisory lock, READ COMMITTED), rollback while waiting, index backstop, the app's error recogniser — in 3 schema states |
| Evidence Guard + compatibility | `pg/evidenceGuardCompat.test.mjs` | 40 | final guard rules (corrections and resolved lines immutable, what stays allowed); every app version × every rollout schema state = the reviewed 300-cell matrix |
| Stock Count start | `pg/stockCountStart.test.mjs` | 50 | eligibility = client rule, initial line state, result contract, concurrent starts, quantity changes racing the start, fault injection, coexistence with resolve/guard/scope |
| Recorded client replay | `pg/b1Replay.test.mjs` | 106 | recorded Stock Count client writes on Foundation (+Functions), with the guard (immutable evidence), and without the Foundation (documented partial write) |
| Evidence Foundation | `pg/evidenceFoundation.test.mjs` | 51 | Foundation schema, historical rows untouched, app write patterns, Batch A guard write-once rules, FK ON DELETE SET NULL, documented old-client hazard |
| manual_spread | `pg/manualSpread.test.mjs` | 11 | provenance CHECK on fresh install and upgrade; manual_spread rows behave as manual logs; provenance write-once |
| Historical backfill | `pg/historicalBackfill.test.mjs` | 43 | Batch D: exactly the planned classes and links, nothing else changes, idempotent, guard protects the result, newer evidence never overwritten, changed rows skipped |
| Readiness | `pg/readiness.test.mjs` | 17 | Batch E READINESS_CHECK.sql read-only at each rollout stage and after a full new count; parity with the JS validator |
| Business fingerprint | `pg/businessFingerprint.test.mjs` | 26 | business values unchanged through every rollout stage; time-zone independent; blind to evidence columns; detects a change to any protected value |
| Probes | `pg/probes.test.mjs` | 5 | runbook GET probes are write-free |

Totals: **436** unit/UI checks; **1,024** PostgreSQL checks per version (**2,048** for 15 + 17); **2,484** in all.

## Coverage matrix — original review suites → this harness

The review suites used during development lived outside the repository and some ran
on a read-only Production snapshot. Every one of them is accounted for here.

| Original suite | Checks then | Ported to | Checks now | Differences |
|---|---|---|---|---|
| U0 rules (`testsU0`) | 56 | `unit/lotEdit.test.mjs` | in 125 | synthetic Lots instead of real reagent names / Lot numbers |
| U0 render | 5 | `ui/editLot.test.mjs` | in 51 | — |
| U1 (`testsU1`) | 108 (+1 added in U2c-2) | `unit/units.test.mjs` | 109 | Production lots → synthetic lots of the same shapes; Production-wide sweeps run over the synthetic set |
| U2b (`testsU2b`) | 117 | `unit/forecast.test.mjs`, `ui/screens.test.mjs` | 29 + 48 | **not ported:** the one-off comparison of every group against the pre-U2b code on the Production snapshot (needs the snapshot and old commits); its intent is asserted as rules (nothing dropped, never summed, evidence shared) |
| U2b interactions | 42 | `ui/screens.test.mjs` | in 48 | synthetic inventory with the same group shapes |
| U2c-1 / U2c-2 / U2c-3 rule + UI suites | 31 + 15 / 49 + 31 / 29 | `unit/lotEdit`, `ui/editLot`, `ui/logUse` | in 125 / 51 / 25 | **not ported:** "only these lines changed since commit X" review checks (they compare specific commits); replaced by permanent invariants (writers unchanged, display helpers do no arithmetic, payload keys) |
| U2a (`runU2a`) | 59 | `pg/packaging.test.mjs` | 55 | Production replica → synthetic seed; business fingerprint → full row dump (stricter) |
| U2c-1 / U2c-2 database (`runU2c1`, `runU2c2`) | 20 + 23 | `pg/editLotSave.test.mjs` | 42 | synthetic seed |
| A3 atomic migration (`runA3atomic`) | 16 | — | — | **not ported:** tested a one-off migration script already executed on Production (Gate A3); its effect is covered by `pg/packaging.test.mjs` |
| B1.5a (`runB15`) | 460 | `pg/stockCountFunctions.test.mjs` | 459 | **omitted check 1 of 2:** "B1.5a commit left the guard file unchanged" — a review-time `git diff` between two historical commits, not a property of the code |
| Scope rule (`run`, `runAS`, `runAS2`) | 39 / 40 / 40 | `pg/scopeRule.test.mjs` | 119 (39 + 40 + 40) | all three schema variants run |
| B2 (`runB2`) + MatrixC (`runMatrixC`) | 32 + 34 | `pg/evidenceGuardCompat.test.mjs` | 40 | MatrixC is a superset of B2 (same guard rules; B2's matrix is the identical subset — verified cell by cell); B2's 5 matrix assertions kept by name over its own 9 operations; **added:** all 300 matrix cells must equal the reviewed matrix (before, only named rows were asserted) |
| Batch C (`runC`) | 50 | `pg/stockCountStart.test.mjs` | 50 | device names and staff codes replaced |
| B1 replay (`runB1F`; `runB1` was its earlier form) | 106 | `pg/b1Replay.test.mjs` | 106 | recorded client writes kept as golden fixtures (synthetic: Alpha/Beta/…, TESTER) |
| Batch A (`runA`) | 51 | `pg/evidenceFoundation.test.mjs` | 51 | the Batch A guard is loaded from `fixtures/historical-sql` instead of git history; identifiers replaced |
| manual_spread (`runMS`) | 12 | `pg/manualSpread.test.mjs` | 11 | **omitted check 2 of 2:** "functions and StockCount unchanged by this adjustment" — a review-time `git diff` between two historical commits; the old Foundation is loaded from `fixtures/historical-sql` |
| Batch D (`runD`) | 43 | `pg/historicalBackfill.test.mjs` | 43 | Production replica → synthetic history built around the plan's own row ids (`fixtures/backfillHistory.mjs`). **Limitation:** whether the plan was correctly *derived* from Production (timing and audit-row matching against the real data) cannot be re-proved without that data; the plan was applied in Phase 5 and is not to be re-applied |
| Batch E (`runE`, `testsE`) | 17 + 49 | `pg/readiness.test.mjs`, `unit/evidence.test.mjs` | 17 + 49 | counts now derived from the synthetic history (e.g. 1 duplicate-correction line, 8 pre-received rows, 34 unknown-timing rows, 52 lines without modern metadata) |
| Business fingerprint (`runFP`) | 26 | `pg/businessFingerprint.test.mjs` | 26 | column list taken from the schema before the rollout instead of the Production snapshot's columns |
| Probe (`runProbe`) | 5 | `pg/probes.test.mjs` | 5 | — |

Strengthened while porting: the original key-sorting comparison turned every `Date`
into `{}`, so date comparisons inside it always passed; `helpers/uuid.mjs` `canon()`
keeps dates, so those checks are now real.

## Fixtures and privacy

- `fixtures/lots.mjs`, `inventory.mjs`, `pgSeed.mjs` — invented Lots, people (`tester`,
  `staff-a` …) and dates.
- `fixtures/backfillHistory.mjs` — invented history around the Batch D plan's row ids
  (those ids are already in `ADD_HISTORICAL_EVIDENCE_BACKFILL.sql`).
- `fixtures/golden/` — write sequences recorded from the earlier Stock Count client on a
  synthetic seed, and the reviewed compatibility matrix (outcome text only).
- `fixtures/historical-sql/` — two earlier versions of the repository's own SQL files,
  copied from commits `94d2df2` and `c482054` so no git history is needed.
- The only real-data text left is the readiness check's own name in
  `READINESS_CHECK.sql` ("… (e.g. kit3 / 0314)"), which a test must quote to read that row.

## Writing tests

- Use `suite()` and `check(name, actual, expected)` from `helpers/core.mjs`
  (JSON comparison). When a suite gains or loses checks, update its
  `expectedChecks` **and** `tests/expected-counts.json`.
- App code is bundled with esbuild (`load()`); `supabaseClient.js` is always
  replaced by a stub (`helpers/dom.mjs` → `STUB_SUPABASE`) that records writes
  in `globalThis.__writes` and never performs them.
- Add fixtures to `tests/fixtures/` — invented names and Lot numbers only.
- Never add Production exports, snapshots, real staff names or credentials.
