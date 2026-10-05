// Which Stock Count may start, given the counts currently in progress.
// A count's scope is an ordinary department (text: "Chemistry", "All lab", …)
// or Whole lab (department null = every active lot in every department).
//   - at most one open count per ordinary department; different departments
//     may be open together
//   - Whole lab only when nothing else is open, and nothing else while it is
// The database enforces the same rules (ADD_ONE_OPEN_COUNT_PER_SCOPE.sql);
// this is the friendly check made just before starting.

// { kind: "start" }
// { kind: "resume", session }                    same scope already open
// { kind: "blocked_by_whole_lab", session }      a Whole lab count is open
// { kind: "blocked_by_departments", sessions }   Whole lab asked, departments open
export function startDecision(department, openCounts) {
  const open = (openCounts || []).filter((c) => c && c.status === "in_progress");
  const whole = open.find((c) => c.department == null);
  if (department == null) {
    if (whole) return { kind: "resume", session: whole };
    if (open.length) return { kind: "blocked_by_departments", sessions: open };
    return { kind: "start" };
  }
  const same = open.find((c) => c.department === department);
  if (same) return { kind: "resume", session: same };
  if (whole) return { kind: "blocked_by_whole_lab", session: whole };
  return { kind: "start" };
}

// True only for the database's own Stock Count scope refusals: the trigger's
// P0001 "stock_count_scope_conflict", or a 23505 from one of this rule's two
// unique indexes. Any other error (including unrelated 23505s) is not ours.
export const SCOPE_CONFLICT_MESSAGE = "stock_count_scope_conflict";
export const SCOPE_INDEXES = ["inventory_counts_one_open_per_department", "inventory_counts_one_open_whole_lab"];
export function isScopeConflict(error) {
  if (!error) return false;
  if (error.code === "P0001") return error.message === SCOPE_CONFLICT_MESSAGE;
  if (error.code === "23505") return SCOPE_INDEXES.some((name) => String(error.message || "").includes(`"${name}"`));
  return false;
}
