# LTC Lab Inventory — Release runbook (owner)

Maintenance mode and forced updates are enforced **in the database**
(`ADD_RELEASE_CONTROL.sql`). Every command below is run by the owner in the
**Supabase SQL Editor**, one query at a time. Staff, old browser tabs and the
public app key cannot run them or change the state.

- **Maintenance ON**: nothing can be saved by the app — any version, any tab,
  any device. Staff see "Update in progress". The owner can sign in and look
  around (read-only, with a banner). Sign-ins, the owner's 2FA code and the
  e-mail jobs' bookkeeping still work; no inventory can change.
- **Approved build**: when a release is opened, exactly ONE build (Git commit)
  may save. Every other version — including tabs opened before the update —
  is refused by the database; its pages reload themselves when nothing is
  being entered, otherwise they show "A new version is ready".
- Switching maintenance on **waits** for saves already in progress (up to 15
  seconds): each finishes completely or not at all, and everything after the
  switch is refused.
- Every change is recorded in `app_release_log` (who, when, why). It can't be
  edited or deleted.

## Find the build id

The build id is the **full 40-character commit id** of what Vercel deployed —
on GitHub (the commit page) or in Vercel (the deployment's "Source"). Example:
`700efb9a34c4ccb7da1914663bcc556fafa6879d`. Short ids are refused.

## Check the current state

```sql
select ltc_release_state();
```

Shows maintenance on/off, enforcement, the approved build, the builds recently
reported by running copies of the app, and the last 10 changes.

## Normal release

1. **Maintenance ON** (staff see the maintenance screen within about a minute):
   ```sql
   select ltc_maintenance_on('Release <name>: <what changes>');
   ```
   If it reports a *lock timeout*, a save was stuck in progress — just run it
   again.
2. Apply the release's SQL files (if any) and run their VERIFY files.
3. Push / deploy. Wait until Vercel shows the deployment **Ready**.
4. **Confirm the deployment yourself** — the database can't see Vercel, and a
   build appearing as "reported" is not proof (anyone with the public app key
   could report any id). All three must agree on the new commit id:
   - Vercel shows the deployment **Ready** for that commit;
   - https://ltc-reagent.vercel.app/version.json shows `{"build":"<that commit id>"}`;
   - after you open the app in your browser, `select ltc_release_state();`
     lists it under `builds_seen`.
5. Do the read-only checks for the release.
6. **Approve and reopen** — exactly this build, nothing else:
   ```sql
   select ltc_release_open('<full commit id>', 'Release <name> verified', p_deployment_verified => true);
   ```
   Pages already on the new version continue by themselves; older pages
   reload themselves when nothing is being entered.

`ltc_release_open` refuses unless you pass `p_deployment_verified => true`
(your confirmation of step 4), and refuses a build that no running copy of the
app has reported in the last 2 hours — so a typo, or a deployment that failed,
can't reopen the system by accident.

## Maintenance without a release (e.g. data repair)

```sql
select ltc_maintenance_on('Repair: <why>');
-- … repair as owner in the SQL Editor (the owner is never blocked) …
select ltc_maintenance_off('Repair finished');
```

## Emergency: the new version is broken after opening

1. Stop saving everywhere:
   ```sql
   select ltc_maintenance_on('Release <name> broken: <symptom>');
   ```
2. Vercel → Deployments → the previous good deployment → **Instant Rollback**.
3. Check https://ltc-reagent.vercel.app/version.json shows the previous
   commit, then open the app in your browser so it reports in.
4. Approve the previous build:
   ```sql
   select ltc_release_rollback('<previous full commit id>', 'Rolled back: <why>', p_deployment_verified => true);
   ```
   Pages on the broken version are refused by the database and reload to the
   previous version.

Inventory data is never rolled back. Fix individual wrong entries with the app's
normal tools (undo / edit / Edit Lot / Stock Count) or as owner in SQL.

## Recovery

| Situation | Do this |
|---|---|
| Vercel deployment failed | Stay in maintenance. Fix and redeploy, then continue at step 4 — or roll back as above. The failed build can't be approved (it never reported). |
| Nobody can save and the cause is the build check (e.g. Vercel did not provide the commit id, so the app and /version.json say `dev`) | `select ltc_enforcement_set(false, '<why>');` — the build check is off, maintenance still works. Fix, then `select ltc_release_open('<commit id>', '<why>', p_deployment_verified => true);` |
| The app can't be opened at all, but you must approve a known commit | `select ltc_release_open('<full commit id>', '<why>', p_deployment_verified => true, p_force => true);` — only if Vercel and /version.json confirm the commit. |
| Maintenance switch keeps timing out | A save is stuck. Wait a minute and retry, or pass a longer wait: `select ltc_maintenance_on('<why>', null, interval '60 seconds');` |
| The release control itself is faulty | Prefer `ltc_enforcement_set(false, …)` and `ltc_maintenance_off(…)`. Last resort: `ROLLBACK_RELEASE_CONTROL.sql` (removes it; no inventory touched; the audit trail is kept). |

## Never

- Never delete or "roll back" inventory rows to undo a release.
- Never pass `p_deployment_verified => true` or `p_force => true` without
  checking Vercel and /version.json for that exact commit.
- Never share these commands with staff; they need no access to them.
