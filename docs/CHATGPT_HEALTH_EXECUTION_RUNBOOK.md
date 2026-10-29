# ChatGPT execution runbook: native Health → Iron Ledger

**Deployment status:** implementation prepared on `feature/chatgpt-health-sql-bridge`; the bridge migration and worker require owner approval before production deployment. This document is not evidence of a live end-to-end import. No recurring task is created.

## What fixes the transfer boundary

The Health-enabled ChatGPT conversation needs two capabilities: read the **entire authorized native Health JSON attachment**, and execute administrative SQL through the Supabase connector. It does not need an HTTP tool, Storage upload action, import bearer token, Supabase secret key, repository access, or a local Mac upload.

ChatGPT submits bounded UTF-8 text chunks with SQL. PostgreSQL validates the complete payload size and SHA-256, then uses `pg_net` to notify a fixed backend worker. The notification contains only a job UUID and a short-lived per-job credential, generated server-side and never returned to ChatGPT. The worker retrieves the staged payload using built-in platform credentials, validates/normalizes it, uploads and reads back both raw JSON and its extraction manifest in private `health-raw` Storage, then commits the projections and verification status transactionally. PostgreSQL—not ChatGPT—makes the HTTP request.

The worker's public HTTP route requires the per-job dispatch credential. Its database RPCs are executable by the service role only. Staging is in the private schema; no PWA or anonymous import privilege is added. Original payload JSON is preserved byte-for-byte in Storage. Staging copies are erased after success; failed attempts can be retried or explicitly cancelled/purged. Existing legacy import endpoints and frontend behavior are unchanged.

## One-time deployment checklist — implementer only

After the owner approves production deployment:

1. Apply `20261029043325_health_connector_sql_bridge.sql` to the existing project. It enables `pg_net` and creates private staging helpers plus service-only worker RPCs. No cron, schedule or permanent dispatch secret is installed. Existing config source allowlists must already be verified.
2. Deploy `process-health-connector/index.ts`, including its relative modules and the existing shared repository/parser modules, as **`process-health-connector` with platform JWT verification disabled**. Independent dispatch-token authentication is mandatory in `worker.mjs`; do not remove it. The destination URL is pinned to the existing Iron Ledger project.
3. Verify new grants/RLS/advisors and perform a synthetic, nonpersonal live submission. An HTTP 202 is only acceptance; wait for SQL `state=completed` and verify archive/projection readback.
4. Obtain owner approval for the actual-data trial. The supplied reference file has no unit/completeness metadata embedded in it: validate its separate extraction manifest against the Health query summary before asserting source units/completeness. If the owner explicitly accepts the provided specification/test notes for the small reference trial instead, record that metadata origin; reference units receive a derived-quality flag. Do not describe specification-snapshot units as newly verified connector output. Future syncs should capture their actual query summaries.

## Initiating a sync in ChatGPT

The user can request: **“Sync my Apple Health workouts to Iron Ledger.”** The conversation must have both Health and Supabase connected and authorized. Depending on ChatGPT connector approval behavior, the user may still need to approve tool writes. This bridge does not establish unattended Scheduled Task support.

Use the following process. Do not report success until step 8.

### 1. Read scope and owner configuration

Using Supabase administrative SQL, inspect `public.health_sync_config` and `public.health_connector_sync_status`. Resolve the owner's `user_id` from verified account/app context. If multiple owners exist and the correct owner cannot be established, stop and request clarification; never pick the first UUID.

Use the configured Los Angeles cutoff (at least September 1, 2026), metric identifiers and source policy. All eligible workout activity types are included. Verify workout source bundle identifiers against the allowlist. WHOOP/Oura are excluded. Coarse hourly groups and optional environmental/audio metrics default off.

For a routine manual sync, query the last seven days bounded by the cutoff. For a specifically approved backfill, start at the cutoff. Split extraction into compact per-workout/day windows; a submitted job is limited to 1.5 MiB UTF-8, 100 workouts, 10,000 records and an eight-day extraction window. Smaller jobs are preferable for large HR attachments.

### 2. Extract Health data and metadata

Use native `query_samples_file` for `workout`, then the approved relevant quantities around eligible workouts, with at most the configured five-minute HR-recovery window. Process the full authorized attachment; a summary or displayed example rows are insufficient. Preserve every point field and source identifier. Do not substitute hourly quantity totals for workout totals or invent GPS, cadence/power, sets/reps or missing samples.

Collect these metadata separately from the Health response/query summary:

- Inclusive extraction `window_start`, exclusive `window_end`, timezone `America/Los_Angeles`.
- `complete=true`, `omitted=0`, and checked response truncation/row-limit flags. If incomplete, split/requery; do not submit it as complete.
- Exact `record_counts` for **every** top-level metric array, including empty arrays and `workout`.
- Exact original `units` for each nonempty quantity metric, from connector summary metadata. Do not guess units from values or import units from a different exporter.
- Optional original `timestamp_semantics`, per-metric aggregation resolution, and source-version metadata.
- `extracted_at` (actual query execution time) and `extraction_time_verified=true` only when established. If unavailable, set `extraction_time_verified=false`; new records can be ingested, but conflicting corrections are held for review.

For multiple source responses, preserve them as separate bounded jobs. A single supported payload is a JSON object mapping exact metric identifiers to their complete source-row arrays, matching native `query_samples_file` output. All metadata used for interpretation is in the manifest and is archived separately.

### 3. Prepare a checksum and bounded chunks

Read the complete authorized file in an available file/code-execution tool. Compute its UTF-8 byte count and SHA-256 **from the bytes**, and split its decoded text into chunks of at most **24,000 UTF-8 bytes**, preserving code points and exact order. Never calculate a checksum by intuition or manually rewrite/reconstruct thousands of measurements from prose.

Add `schema_version=1`, `payload_sha256`, `payload_bytes`, and `part_count` to the manifest. SHA-256 is lowercase hex. The server independently checks the byte size/hash after reassembly and validates array counts before projection.

`tools/prepare-health-connector.py` implements this preparation without network access and emits a manifest plus private SQL part files; it can run in a code-execution environment with the authorized attachment. Repository access is not essential: the algorithm is UTF-8 splitting + standard-library SHA-256 + dollar-quoted SQL, as described here. Generated files contain personal data and must stay private. The implementer can also use it locally for an explicitly supplied file; normal future syncs should use the Health-returned attachment directly.

**Capability gate:** if this ChatGPT conversation cannot read the full Health attachment or faithfully send its chunks through the SQL tool, stop and name that exact limitation. A reference to a file path, URL or attachment ID is not its contents; PostgreSQL cannot fetch a ChatGPT attachment just from its ID. The smallest fallback is a one-time owner-provided export/file processed by the same bridge, not a fabricated or truncated import.

### 4. Begin a durable job

Through the Supabase SQL tool, submit the verified owner and complete manifest:

```sql
select health_private.connector_begin(
  'VERIFIED_OWNER_UUID'::uuid,
  $manifest${"schema_version":1,"complete":true,"omitted":0,"timezone":"America/Los_Angeles","window_start":"WINDOW_START","window_end":"WINDOW_END","record_counts":{"workout":1,"heartRate":100},"units":{"heartRate":"count/min"},"payload_sha256":"COMPUTED_SHA256","payload_bytes":12345,"part_count":1,"extracted_at":"QUERY_EXECUTION_TIME","extraction_time_verified":true}$manifest$::jsonb,
  'UNIQUE_REQUEST_KEY'
);
```

Those values are placeholders, not a valid example to execute unchanged. Save `job_id`. Use a stable request key when retrying a lost begin response. Reusing the key with different metadata is rejected. If the returned state is already completed, inspect its result and stop the replay.

### 5. Send every chunk, then finalize

For each chunk, call the SQL tool with its zero-based index and exact text:

```sql
select health_private.connector_append(
  'JOB_UUID'::uuid, 0,
  $unique_delimiter$EXACT_SOURCE_TEXT_CHUNK$unique_delimiter$
);
```

Choose a dollar-quote delimiter absent from that chunk. SQL chunks are tool arguments, never shell commands. Do not expose chunks in public chats, repositories, screenshots or logs. Identical repeated parts are safe; conflicting replacements fail.

After all parts are acknowledged:

```sql
select health_private.connector_finish('JOB_UUID'::uuid);
```

This validates/reassembles the original bytes and queues a **single** worker request after the SQL transaction commits. It is not a recurring automation. A missing part or mismatched checksum cannot dispatch.

### 6. Inspect durable SQL status

```sql
select health_private.connector_status('JOB_UUID'::uuid);
```

Poll with reasonable spacing while the worker processes. `collecting`, `queued`, `processing`, `retryable`, and HTTP 202 are **not success**. Only `state=completed` with committed counts/readback is success. The transport response is diagnostic; it is not the import result. Health values are not returned by this status helper.

If `retry_allowed=true`, retry without resending the source chunks:

```sql
select health_private.connector_dispatch('JOB_UUID'::uuid);
```

Retries preserve prior failed sync-attempt rows. A worker lease prevents simultaneous execution; stale leases/failed deliveries can be retried. Failures leave the private staged source recoverable. Unsupported corrections, missing units, invalid source or incomplete extraction need fixing/review rather than repeated blind retries.

To cancel a pending/failed job and purge its staged payload:

```sql
select health_private.connector_cancel('JOB_UUID'::uuid);
```

Cancellation does not delete an already completed import or its raw archive.

### 7. Verify projections and data quality

Read the owner's `health_connector_workout_summary`, `health_connector_workout_points`, and corresponding `health_sync_runs` row. Verify the expected **unique** workout count, inserted/updated/unchanged counts, retained vs deliberately excluded observations, archive verification and completion. Report exclusions and missing data honestly. Do not claim all source rows were projected when scope filters excluded some; the exact original source file remains in private Storage.

Watch and Bluetooth source rows remain distinct. Derived HR uses one configured stream (Watch by default), rejects suspect values, deduplicates conflicting timestamps, and caps left-held values at 30 seconds. Coverage is measured against elapsed workout time; sparse coverage is flagged. Recovery uses same-source points within 15 seconds of the 60/120-second targets and requires a valid final workout point within 30 seconds of the end. HR zones remain NULL without a configured threshold basis. Pace uses recorded duration and workout distance; energy remains workout-reported energy. Walking gait statistics are walking-workout-only; VO2Max is contextual.

Corrections retain original archived observations and mark prior same-identity variants superseded. Conflicting corrections require a strictly newer verified extraction time. Changed configuration or concurrent context invalidates a stale computation and requires retry. No source record is deleted merely because a later lookback omitted it. Existing one-to-one conservative strength matching and manual rejections are preserved.

### 8. Report the result and stop

Summarize committed workout counts, excluded records and quality limitations. Exact replay must add no workouts or observations. Do not enable `automation_enabled`, create a ChatGPT Scheduled Task, install cron, change the PWA or expand the historical scope during this manual evaluation.

## What the current tests establish

The isolated integration tests exercise the same SQL staging, worker handler, archive-before-projection checks, adapter, native commit and readback using synthetic data, real local PostgreSQL, and simulated pg_net/Storage. Additional private local preview tooling can use an explicitly attached source file without uploading it. These tests do not establish real Supabase pg_net delivery, Edge background execution, native Health attachment access in every ChatGPT conversation, or unattended cross-connector approvals. Validate the deployed synthetic path first, then the owner-approved small actual-data trial.
