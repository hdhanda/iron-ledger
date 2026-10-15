# Apple Health integration — development release

Status: local implementation with synthetic validation. No hosted development project, live endpoint, real-device contract validation, production migration, merge, deployment or backfill has occurred. `healthEnabled` remains false in the checked-in production configuration. The Edge entrypoint refuses the existing production project and requires `HEALTH_ENVIRONMENT=development`.

## Architecture

Health Auto Export → authenticated `import-health` Edge Function → exact request bytes in private `health-raw` Storage → audit batch → transactional PostgreSQL projections. The PWA reads a small, explicit selection of run/strength columns through its existing Auth JWT. It never receives the import secret, privileged key, raw archives, routes or sensitive event details.

All eight documented family arrays are supported: metrics, workouts, symptoms, ECG, heart rate notifications, state of mind, cycle tracking, medications. Unknown family payloads are archived and quarantined; new metric names use rows, not new SQL columns. Unknown fields survive in the original bytes. Generic observations retain the full point plus metric provenance; workout-specific timestamped arrays are discovered recursively. Routes and complex event waveforms stay in raw Storage; events retain queryable structured details with JSON pointers. Event arrays longer than 64 items are represented by archived-count markers, with every original item retained in Storage.

The migration adds six owner-scoped tables, private rate accounting, service-only ingestion/reconciliation RPCs, and a session reconciliation trigger. It does not extend `Ledger.tables`, `ledger_manifest` or `ledger_write`. Existing session records, legacy cardio, conflicts and backup formats remain intact. A private, fixed-path trigger reconciles health matches when sessions arrive later; it does not modify sessions. Ordinary clients have SELECT only on their own health rows. A restrictive Storage policy excludes the raw bucket even if another permissive policy is broad.

## Local verification

The app has no runtime npm dependencies. The importer uses Web APIs and Supabase REST. Development tools used: Node 22, Supabase CLI 2.121.0, PGlite 0.5.10, bundled Playwright, installed Chrome with a disposable profile. Install pinned tools outside the published app folder:

```sh
npm install --prefix /tmp/iron-ledger-health-tools --save-exact @electric-sql/pglite@0.5.10 supabase@2.121.0
node --test tests/*.test.cjs
PGLITE_MODULE=/tmp/iron-ledger-health-tools/node_modules/@electric-sql/pglite node tests/health-sql.cjs
PGLITE_MODULE=/tmp/iron-ledger-health-tools/node_modules/@electric-sql/pglite node tests/sql.cjs
PLAYWRIGHT_MODULE=/path/to/playwright BROWSER_PATH=/path/to/chrome node tests/browser.cjs
python3 tests/migration_test.py
```

The Python migration suite needs openpyxl (available in the bundled document runtime). PGlite is real PostgreSQL in-process, but its Storage tables are test stubs; Storage API behavior, Deno hosting, actual network limits and Supabase advisors still require hosted development validation. All fixtures are synthetic and inline in tests, independent of any owner export. The migration was created with `supabase migration new apple_health_import`; it is a one-time additive migration, not a repeatedly applied setup script.

## Hosted development setup (pending owner organization and cost confirmation)

1. Create a separate project with synthetic Auth users. Do not branch/copy private production records. Apply existing `supabase.sql` first, then `supabase/migrations/*_apple_health_import.sql`. Existing schema is a prerequisite because matches reference sessions. Do not run this migration against production.
2. Run Supabase security/performance advisors. Check all six tables have owner RLS, authenticated clients cannot mutate them, anonymous requests fail, foreign-owner records remain hidden, raw objects are private and denied to clients, and all ingestion RPCs are service-only.
3. Generate a random import token with at least 32 random bytes, encoded as base64url (43 characters). Privately store the token and its SHA-256 hex digest. Configure only the digest(s) in `HEALTH_IMPORT_TOKEN_HASHES` (comma-separated for rotation). Configure `HEALTH_OWNER_ID` to the synthetic development user UUID and `HEALTH_ENVIRONMENT=development` in Edge secrets. Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Edge runtime. Never put a service role key on the phone, in config.js, in GitHub, or in logs.
4. Deploy the function to that development project only. JWT gateway verification is disabled **only because** the independent custom-header token is verified by the handler before writes. Test invalid/missing/rotated tokens, size/depth limits, concurrent replays, failed Storage/SQL writes and recovery. No CORS headers are needed for the iPhone webhook.
5. Create a separate preview origin/cache with `environment:'preview'`, a new storageKey, the development URL and publishable key, and `healthEnabled:true`. Keep the production config, real phone cache and current Home Screen app intact.
6. POST synthetic run/lift/metric/event requests first. Compare archived bytes/checksums with submitted bytes; query projections as each Auth user. Verify a new metric survives round-trip, and simulated failure leaves an accepted/retryable batch and recoverable raw object. Only after owner approval should real private data go to a reviewed endpoint.

Do not publish the repository root wholesale as a site package. Publish only the static PWA assets (`index.html`, `ledger-core.js`, `cloud.js`, `health.js`, `config.js`, `sw.js`, manifest and icons). No environment files, archives, developer tools or test output belong in the site package.

## Exporter setup after approval

Use JSON v2 with bounded overlapping windows such as Previous 7 Days. Each REST automation sends the same verified HTTPS endpoint and `x-health-import-token`. Vendor headers `automation-id`, `session-id`, `automation-aggregation`, `automation-period` are retained as metadata, not trusted identity. Body `user_id` is ignored. The configured server owner controls every row.

Use separate small automations: all workouts with metrics/routes; targeted single-metric HR/HRV/recovery; modest activity/body/sleep groups; nutrition/environment/remaining available metrics; each available typed event family. Enable only data types actually available to the exporter under iOS permissions; there is no additional Iron Ledger category consent gate. Do not infer unavailable categories from an empty import. Record app version, license, granted permissions, selected sources, summary/grouping settings and test window in a private operational record.

Multi-metric exports are documented as aggregated even when Summarize Data is off. The parser marks them aggregated; grouped headers and Min/Avg/Max also mark aggregation. Without sufficient evidence the resolution stays unknown (`is_aggregated=null`), never falsely sample-level. Preserve original units, timestamps and offsets. The UI uses canonical meters for distance and marks active energy estimated; it does not sum observations across sources.

Request limits are deliberately **2 MiB**, JSON depth 32, 150,000 nodes and 20,000 projected rows, with 60 authenticated attempts per owner per minute (including replays). Larger uploads get 413; smaller requests with too many projected rows retain raw data and fail retryably. Use smaller slices rather than repeatedly retrying an oversized projection. Batch Requests does not eliminate the iPhone query cost. Measure actual device/runtime performance before enlarging limits; neither instant sync nor complete native HealthKit fidelity is promised.

## Identity, corrections and matching

Exact bodies deduplicate per configured owner and SHA-256. A concurrent/lost Storage response is accepted only after reading the existing immutable path and verifying its checksum. Batch projection takes a per-owner transaction lock; duplicate commits are harmless. Partial projection failure rolls back all row changes and leaves raw bytes intact. Successful responses contain only batch IDs, status and counts, never payloads or exception text.

Workouts with vendor IDs update one stable row. Without IDs, identity uses activity/start/end/source and is marked fallback. Observation stable IDs include source and metric; otherwise fingerprints include point content, interval and aggregation semantics. Byte-identical overlapping points deduplicate without conflating distinct sources. Changed no-ID values remain separate variants: **do not SUM these as independent samples or choose a correction automatically**. Without upstream stable IDs/revisions/tombstones, unambiguous historical correction/deletion cannot be inferred. Newer arrival is not guaranteed to mean a newer upstream revision. Raw versions remain the audit source; historical source-aware correction adjudication is a rollout prerequisite. Nothing is deleted merely because it is absent from an incremental export.

Strength matching uses UTC start instants, completed/deload sessions, a 15-minute maximum offset, a five-minute separation from competing sessions **and competing Watch workouts**, and one-to-one constraints. Session end time is ignored. Ambiguous near matches are marked review. Manual matches/rejections survive reconciliation. Workouts with no nearby candidate remain unlinked and are reconsidered when sessions arrive; a missing/invalid workout start is retained in raw and leaves a retryable batch rather than a guessed match. Set timestamps are not yet used as secondary evidence. Administrative match decisions are currently service-side SQL only, with explicit fixed owner/workout/session identifiers; no client edit UI is exposed.

## Operations and recovery

- **Status:** query `health_import_batches` for received/processed times, status and counts, not function payload logs. PWA shows the most recent accepted attempt/success, pending/review state and a >48-hour stale hint. This is importer receipt freshness, not proof of every stream or historic coverage. No exports received differs from no running workouts imported. On-device delivery/permission inventory and per-stream gap reporting still require rollout work.
- **Retry:** replay the identical request after a retryable failure; the same archive/batch is reused. Retryable state has a generic redacted reason. Diagnose with synthetic reproduction, never payload logging.
- **Reproject:** use `tools/health-reprocess.mjs` in development with private server environment variables and a specific batch UUID. It verifies archive checksum, uses the original batch metadata, resets only that batch to accepted through a service-only RPC, and reruns transactional projections. Unknown/unsupported parser shapes remain quarantined/retryable. No records absent from the batch are deleted.
- **Token rotation/revocation:** add a new digest alongside the old digest, update each automation's custom token, test a synthetic request, then remove the old digest. Removing all digests fails closed. Delete/revoke phone automation credentials if the device is lost. No raw request headers are logged.
- **Disable a category:** turn off its exporter automation or revoke its iOS data permission. For shared automations remove that category in the exporter. This stops future collection without deleting history. Revoke/rotate tokens if all uploads should stop. A server category-disable registry is not implemented yet.
- **Backfill:** only after owner acceptance, take a reviewed private backup, test one run and one lift, then progress through day/week windows. Record requested window, byte count, checksum, status, source counts and explicit coverage in a private ledger. Do not schedule an entire history at seconds resolution in one request.
- **Disaster recovery:** export PostgreSQL plus private Storage objects separately; database backup alone does not preserve object content. Keep a private checksum manifest indexed by owner and batch. Restore raw objects before batch/projection rows, verify checksums, then reproject reviewed batches. Existing PWA JSON backups cover legacy Ledger records, **not** health tables or Storage.
- **Owner-requested deletion:** revoke import tokens first. Export a private safety backup if requested. In a reviewed service-side transaction scoped to one owner remove matches, series, events, observations, workouts and batch rows in dependency order; remove only that owner's reviewed Storage paths using Storage API. Do not delete existing sessions/cardio/body or use arbitrary user-supplied paths. Backup retention copies need separate deletion review. No automatic retention expiry is configured.
- **Rollback:** revert static PWA assets as a coherent service-worker release. Close app tabs for activation; never clear local storage as rollback. Retain additive health schema/raw objects for recovery; disable importer credentials if needed. No merge or production activation until owner acceptance.

## Remaining acceptance gates

Hosted Auth/RLS/Storage/Edge integration, advisors, real iOS payload shape/source identity validation, licensed exporter switches, route availability, high-resolution size/latency measurements, source correction adjudication, per-automation coverage/gaps, match review UX and actual installed-iPhone testing remain open. HR chart detail is retained/queryable in series but not yet displayed. This release supplies the working local foundation; it is not a claim that the complete operational specification is production-ready.

## Verified references

- [Exporter REST configuration, aggregation and batching](https://help.healthyapps.dev/en/health-auto-export/automations/rest-api/)
- [Workout v2 summaries, series and routes](https://help.healthyapps.dev/en/health-auto-export/export-format/workouts/)
- [Metrics, original units and special nested values](https://help.healthyapps.dev/en/health-auto-export/export-format/health-metrics/)
- [All family formats](https://help.healthyapps.dev/en/health-auto-export/export-format/)
- [Supabase Edge authentication](https://supabase.com/docs/guides/functions/auth)
- [Supabase Edge runtime limits](https://supabase.com/docs/guides/functions/limits)

Supabase changelog was checked before implementation, including the upcoming TLS cipher retirement and PostgreSQL 17.11 extension changes. This implementation uses no affected legacy cipher, ltree, btree_gist or custom operator.
