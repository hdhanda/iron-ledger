# Verification and acceptance checklist

## Automated checks

```sh
node --test tests/*.test.cjs
python3 tests/migration_test.py
```

The app itself has no npm dependencies. Optional developer tests use Playwright and PGlite installed outside the app's published folder:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright BROWSER_PATH=/path/to/chrome node tests/browser.cjs
PGLITE_MODULE=/path/to/@electric-sql/pglite node tests/sql.cjs
```

If `BROWSER_PATH` is omitted, Playwright uses its installed Chromium. Browser tests launch an isolated profile and temporary localhost server; they never touch the user's real browser profile. Tests generate disposable screenshots in ignored `test-results/`.

Checked during implementation:

- Core PR/history/merge tests: all-time versus previous-session improvement, weight/e1RM distinctions, warmup/skipped exclusion, same-day ordering, multiple exercise blocks, duplicate set and missing-exercise detection, non-destructive restore.
- Mock cloud tests: offline failure, failed/confirmed states, committed write with lost response, idempotent retry, unchanged-history reads skipped, remote updates, explicit conflicts, edits during in-flight writes, custom exercise/routine fresh-cache recovery, account isolation.
- Migration tests: calendar dates, warmups, exact-name distinction, phone IDs, unsynced-set union, duplicates, orphan associations and sample review gates.
- PostgreSQL WASM tests: schema applies twice; owner reads/writes; foreign-owner reads/updates hidden; spoofed inserts denied; anonymous queries/RPC denied; nested JSONB readback; routine split keys; safe retries and stale-write conflicts.
- Chrome at a 390×844 mobile viewport: nav flush with bottom, resize recovery, original search input stays focused/mounted while typing, all 65 synthetic sessions accessible, offline reload preserves active/custom exercise, cardio/body logging and JSON/CSV downloads, original `ironledger` key untouched.
- Actual source transformation: all available source sessions/sets reconstructed; working/warmup counts and every source set's session/exercise association checked. Review findings remain explicit. Private source files and generated reports are not committed.

These are **not** substitutes for hosted Supabase Auth testing or an installed iPhone PWA. No development project was available during initial implementation.

## Installed iPhone preview

Use a separate HTTPS preview origin and its **Iron Ledger Preview** icon. Keep the existing app installed and its local data intact.

- [ ] Open all four tabs; nav touches the safe-area edge on short and long pages.
- [ ] Scroll long Train and Progress pages; nav remains anchored.
- [ ] Open/close keyboard several times, rotate if supported, switch tabs, background/foreground. Verify no floating nav or bottom gap.
- [ ] In Add exercise, type quickly, delete, move the caret, paste, and select a result. Input must not jump or lose focus. Scroll the results before editing the query.
- [ ] Resume an active workout after force-closing the preview; logged sets/readiness/notes remain.
- [ ] Compare all prior working sets on an exercise card. Warmups should not appear in that comparison.
- [ ] Log a set better than the last workout but below an older record: it may say “above last time” but must not get an all-time PR.
- [ ] Independently exceed weight and e1RM records. Warmups never receive PR labels.
- [ ] Select Push in Session progression; inspect every available Push session, routine filter, volume/working set trends and recurring exercise details.
- [ ] Search several exercises with actual imported records, including custom names; inspect all sets, RPE, warmups and all-time records. A source exercise with no records should show an empty state.
- [ ] Existing anchor charts, routines, readiness, cardio/body, History, CSV, backup and restore still work.

## Real development Supabase

- [ ] Run SQL in a new development project; create the single confirmed user; disable signups; configure only URL + publishable key.
- [ ] Sign in, import a reviewed candidate, and wait for database-confirmed saves. Check no failed/conflict records remain unreviewed.
- [ ] Sign into a fresh second preview browser; all exercises/routines/history/cardio/body load. Run `tools/verify-import.cjs` against that browser's backup.
- [ ] Add a custom exercise and complete a workout offline, reload while offline, reconnect, and confirm exactly one record per original ID on the second device.
- [ ] Let the Auth access token expire, then reopen online; refresh and sync should work. Test incorrect credentials and revoked/expired Auth sessions without losing pending records.
- [ ] Edit a record in a controlled development-only test from two clients; verify stale updates become conflicts. Keep both safety backups.
- [ ] A different Auth user cannot read or modify your rows; signed-out REST calls cannot access rows.
- [ ] Clear only the disposable second preview browser cache and sign in again. Repeat history/PR searches; never clear the original phone app as a test.
- [ ] Export final cloud-confirmed JSON and fresh source backups before requesting production cutover approval.

## Limits and remaining manual work

- Completed workout records are durable only after confirmed sync. Active workouts and unsynced changes are local until connectivity returns and the app runs.
- Deletions are not exposed in the completed-history UI or sync API; this prevents an incomplete cache/backup from propagating accidental deletion.
- The full phone backup and the deferred source review decisions are needed before finalizing migration. Current reference counts are not treated as proof of completeness.
- Apple Health remains in the original Sheet and source archive; its existing Shortcut has not been altered.
- A private preview may require its hosting sign-in before first online use. That is separate from Supabase Auth. Test installed/offline behavior on the actual iPhone.
