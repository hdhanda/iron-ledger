# Iron Ledger v2 setup

This is an incremental vanilla-JavaScript upgrade. The owner has approved production cutover and retaining the configured Supabase project as the permanent store. The production build uses the original `ironledger` local storage key. The separate hosted preview retains its own local cache; it now points at the same permanent database, so do not use it for disposable test records. Use a separate Supabase project for future destructive or synthetic testing. Deployment remains pending migration readback verification.

## 1. Protect the existing app

1. In the existing iPhone app, open **Data → Download full backup (JSON)** and save it in Files. Do this even if you have never made a backup before. Keep the installed app, its storage, original Sheet, and Apps Script unchanged.
2. Export a fresh XLSX from Google Sheets. Keep both files privately, outside the Git repository.
3. Use a separate preview HTTPS origin and a **separate development Supabase project**. Do not test storage clearing against the existing app.

The known-working Git baseline is tag `baseline/pre-v2-2026-10-07` at commit `2a92bae`. All development belongs on `feature/iron-ledger-v2`.

## 2. Create the development Supabase project

1. Sign in to the [Supabase dashboard](https://supabase.com/dashboard) and create a new project, for example `iron-ledger-development`. Keep its database password private; the app does not use it.
2. Open SQL Editor and run **[supabase.sql](supabase.sql)**. It creates five tables, owner RLS policies, versioning, an atomic write function, and a small change-manifest function. It is repeatable and contains no source-data deletion.
3. In Authentication → Users, create your single email/password user and confirm its email in the dashboard. Use a strong password. In Authentication settings, disable public sign-ups. There is no signup or account-management UI in the app.
4. In the project connection/API settings, copy the project URL and **publishable key**, beginning `sb_publishable_`. Use the modern publishable key, not the legacy service-role key or `sb_secret_` key.
5. Update `config.js` in the feature branch:

```js
window.IRON_LEDGER_CONFIG = {
  environment: 'preview',
  storageKey: 'ironledger-v2-preview',
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabaseKey: 'sb_publishable_YOUR_KEY'
};
```

The URL and publishable key may be committed to the frontend. Passwords, access/refresh tokens, database passwords, and secret/service-role keys must never be committed. Supabase [publishable keys](https://supabase.com/docs/guides/getting-started/api-keys) identify the application; [Auth and RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) restrict data to the signed-in owner.

6. Republish only the separate preview. In **Data**, sign in with the user you created. The app saves the Auth session separately from exported workout data. Sign-out keeps cached/pending records on the device. Only your personal devices should use this app.

The current project URL and publishable key are configured, and the owner has confirmed authenticated synchronization. Full migrated-history readback must also be verified before cutover.

## 3. How storage works

- Supabase is the durable record store once configured and signed in. Completed workouts, exercise definitions, routines, cardio and body records are downloaded on startup/sync. Active workouts stay local until completion.
- Local storage is a fast cache and offline outbox. Every change is persisted before sync is scheduled. If storage fails, keep the app open and immediately export a backup.
- Stable IDs make creation/retry idempotent. Updates require the last acknowledged database version; stale changes produce a conflict instead of silently replacing newer data. Data → Review cloud conflicts shows both versions and downloads a safety backup before a choice.
- A tiny per-table manifest is checked before downloading records. Changed tables are read in pages of 200; unchanged history is not downloaded repeatedly. No fragile time cursor can skip an out-of-order commit.
- Sync runs on startup, foreground return, connectivity return, after changes, and periodically while open; errors retry with backoff. An iPhone PWA cannot guarantee execution while closed. Reopen online to flush pending work.
- Different Supabase accounts/projects cannot reuse the same bound cache. Use separate preview origins for different projects; export before any manual cache reset.
- Routine database keys combine the existing ID and split. Original IDs remain unchanged inside JSON, including session references.
- Tables retain the full original record in JSONB `data`. Sessions also expose generated `date`, `type`, `status`, `routine_id`, and nested JSONB `entries` columns; exercises expose name/pattern/group/anchor. Generated columns avoid divergent copies and preserve unknown legacy metadata.
- Completed `deload` workouts count toward history/records; skipped/unfinished workouts and warmups do not count toward PRs. Epley remains `weight × (1 + reps / 30)`, rounded to one decimal.
- Backup restoration is a stable-ID union. Missing values can be filled; conflicting values require review. The incoming backup's cloud ownership/acknowledgements never replace the current cache's sync state.

## 4. Migrate and verify

Follow **[MIGRATION.md](MIGRATION.md)**. Do not import the supplied template workbook as your complete history. Use the current Sheet export plus a freshly exported phone JSON backup.

After approved import and confirmed sync, use a **fresh separate preview browser/device**, sign in, export a full backup, and run the comparison script. This is the important proof that history survives local-cache loss. Do not clear your original phone app to perform this test.

## 5. Deploy the static PWA

No framework, build step, npm installation, or backend server is required. Publish only:

```text
index.html
ledger-core.js
cloud.js
config.js
sw.js
manifest.json
icon-180.png
icon-192.png
icon-512.png
```

Use HTTPS. Keep SQL, tests, migration scripts and especially private backup/XLSX files out of the published static directory. Open the HTTPS URL in Safari, then Share → Add to Home Screen. The preview's manifest is named **Iron Ledger Preview** so it is distinct from your current app.

Do not open `index.html` as `file://`: Auth/CORS, local storage origins and service workers require proper HTTP(S) hosting. For local work, a loopback static server is sufficient; an iPhone needs an HTTPS preview URL for installed/offline testing.

The service worker caches one coherent release. Increment `RELEASE` in `sw.js` whenever publishing changed app assets or configuration. A waiting update activates after all old app windows close; it never forces a reload during a workout. Reopen online after updating, then check offline behavior. Keep preview on a different origin to isolate its service worker, auth and cache from production.

## 6. Final cutover — requires explicit owner approval

1. Complete [TESTING.md](TESTING.md), especially installed iPhone keyboard tests and real Supabase two-device readback/offline retry.
2. Export a final current phone backup and current Sheet, rerun reconciliation, settle review findings, and verify counts and source IDs against the chosen destination project. Development test workouts should not be promoted accidentally.
3. Review and approve the PR. Do not enable auto-merge. The owner explicitly chose to retain the current Supabase project and user permanently. Future development testing must use a separate project.
4. For the approved production build, set `environment: 'production'`, `storageKey: 'ironledger'`, the final project URL/key, and restore the original manifest/app display name. Increment the service worker release. Keeping the original `ironledger` key preserves the phone's legacy data; initial cloud sync reconciles it rather than replacing it.
5. Merge and deploy to existing GitHub Pages only after explicit approval. Check production backup, counts, pending/failed/conflict state and active workout before resuming normal training.

## 7. Rollback

**Application:** restore the static files from `baseline/pre-v2-2026-10-07` through a new rollback branch/PR, not a destructive reset of working history. Deploy only with owner approval. The baseline `sw.js` is network-first and will replace the newer worker after clients close; reopen online and confirm the known-working UI.

**Data:** changing application code does not delete Supabase rows or the original Sheet. Before cutover, keep the original phone JSON, fresh Sheet export, reviewed migration candidate and a fresh Supabase-backed JSON export. The v2 record structure remains schema v2 and baseline-compatible. If reverting, retain the latest v2 export so workouts logged after cutover are not lost; do not restore an older backup over a fuller cache. The old app's restore operation replaces data, so reconcile offline first with the provided tools before using it.

If a database import is wrong, stop sync and export both versions. Correct via reviewed IDs/versions in a separate development project first. No automated table truncation, mass deletion, or historical-sheet rewrite is provided. Keep original sources and migration decision files; repeat the conversion rather than trying to reconstruct lost source facts.

## 8. Legacy integration

Google Sheets writes remain an optional **manual one-way archive**, never a competing authority. The original Apps Script and Apple Health Shortcut are unchanged. Apple Health still goes to its existing Sheet tab; health data is preserved in the migration source archive, not silently relabeled as app cardio/body records. The supplied Apps Script ignores custom exercises; their durable home is now Supabase. Opaque `no-cors` Sheet sends remain unconfirmed and no longer mark records synced.

Implementation references: [Supabase Auth endpoints](https://github.com/supabase/auth), [user sessions](https://supabase.com/docs/guides/auth/sessions), [database functions](https://supabase.com/docs/guides/database/functions).
