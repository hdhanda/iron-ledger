# ChatGPT execution runbook: native Health → Iron Ledger

**Deployment status:** summary-only migration and worker v2 deployed after owner approval on October 28, 2026 (October 29 UTC). Live synthetic import, approved failed-job retry and a separate identical-payload replay completed with zero new observation/link rows. Checksums verified that historical observations/links and lifting logs were unchanged. Both private archive verification and database readback succeeded; temporary staging was purged. Automation remains off. No historical backfill or PWA change is included.

## Summary-only persistence

ChatGPT still fetches complete timestamped Health samples and sends the original payload through the same SQL calls. The trusted worker computes summaries from those actual samples in memory. It archives and byte-verifies the original raw JSON and extraction manifest in private Storage before committing projections.

New native imports write only `health_workouts`, `health_workout_derived`, import/sync auditing and the existing strength-match results. They write **zero** `health_metric_observations`, `health_workout_observation_links`, event or series rows. Existing observations and links remain available for historical review and are neither hydrated into a new calculation nor deleted, superseded or relinked. The existing association safety trigger remains enabled for callers that still write historical sample links.

There is one derived row per supplied workout and configured algorithm version. A retry refreshes only the supplied workouts; neighboring context workouts are used for conservative ambiguity checks but their summaries are not rewritten. Fetch the complete measurement window for each submitted workout, including configured recovery/context points. Separate source responses for the same workout must be assembled into one complete payload before submission; partial HR fragments must not replace its complete summary.

`observations_seen` counts raw quantity rows inspected; `observations_inserted=0` and `links=0` describe new persistence, even when historical rows already exist. `derived` counts refreshed summaries. Workout inserted/updated/unchanged counts refer to the original workout record, so its derived metrics can refresh while the source workout is unchanged. Raw archives still retain all original points, including excluded sources or ambiguous/coarse rows, for audit/reprocessing. This change reduces database row growth, not raw archive size.

## What fixes the transfer boundary

The Health-enabled ChatGPT conversation needs two capabilities: read the **entire authorized native Health JSON attachment**, and execute administrative SQL through the Supabase connector. It does not need an HTTP tool, Storage upload action, import bearer token, Supabase secret key, repository access, or a local Mac upload.

ChatGPT submits bounded UTF-8 text chunks with SQL. PostgreSQL validates the complete payload size and SHA-256, then uses `pg_net` to notify a fixed backend worker. The notification contains only a job UUID and a short-lived per-job credential, generated server-side and never returned to ChatGPT. The worker retrieves the staged payload using built-in platform credentials, validates and computes summaries from it in memory, uploads and reads back both raw JSON and its extraction manifest in private `health-raw` Storage, then commits the projections and verification status transactionally. PostgreSQL—not ChatGPT—makes the HTTP request.

The worker's public HTTP route requires the per-job dispatch credential. Its database RPCs are executable by the service role only. Staging is in the private schema; no PWA or anonymous import privilege is added. Original payload JSON is preserved byte-for-byte in Storage. Staging copies are erased after success; failed attempts can be retried or explicitly cancelled/purged. Existing legacy import endpoints and frontend behavior are unchanged.

## Summary-only deployment checklist — implementer only

After explicit owner approval:

1. Wait for active workers to finish. Apply `20261029064219_health_connector_summary_only.sql` to the existing project. It replaces only `connector_context_revision`, `health_connector_claim` and `health_connector_commit`; there are no new tables/columns, data cleanup, constraint changes, or altered Ledger functions. The old commit deletes/rebuilds observation links and checks their counts, so changing the worker alone would delete historical links and fail readback. This function migration is necessary.
2. Deploy the updated `process-health-connector/index.ts` worker with its relative modules/shared repository/parser, preserving independent dispatch-token authentication and the existing platform JWT setting. SQL rejects old workers' point-bearing projections rather than silently storing samples; interrupted/old-version jobs remain retryable. Never roll the old worker back against the summary-only commit function.
3. Verify grants/RLS/advisors and perform a synthetic live submission only after approval. Wait for SQL `state=completed`, verify both archives and workout/derived rows, confirm inserted observations/links are zero, and replay under a fresh request key. Existing completed jobs remain completed and do not automatically rerun under the new revision.
4. If approved, dispatch a previously failed job through `connector_dispatch`; the original failed audit remains and the new attempt uses the retained raw payload. Do not change or disable `validate_connector_workout_link`. The reported strength failure arose while the old commit wrote individual associations; the summary-only commit never performs that write.

The SQL caller interface and extraction manifest remain unchanged. `projection_mode=summary_only` is set and enforced by the trusted backend, not a new client-selectable retention option. Keep automation disabled.

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

For different workouts, use separate bounded jobs when needed. For multiple metric responses belonging to one workout, assemble a complete per-workout payload and matching manifest before submission. A single supported payload is a JSON object mapping exact metric identifiers to their complete source-row arrays, matching native `query_samples_file` output. All metadata used for interpretation is in the manifest and is archived separately.

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

Read the owner's `health_connector_workout_summary`, matching `health_workout_derived` rows and corresponding `health_sync_runs` row. Verify the expected **unique** workout count, one derived row per submitted workout/algorithm, zero inserted observations/links, private archive verification and completion. SQL compares the committed derived values to the trusted calculation and verifies historical sample/link counts have not changed before marking success. `health_connector_workout_points` contains historical data only; its row count must not be used as proof of a new summary import. Report exclusions and missing data honestly; the exact original source file remains in private Storage.

Watch and Bluetooth points stay distinct in the raw archive and the in-memory calculation; they are never indiscriminately combined. Derived HR uses one configured stream (Watch by default), rejects suspect values, deduplicates conflicting timestamps, and caps left-held values at 30 seconds. Coverage is measured against elapsed workout time; sparse coverage is flagged. Recovery uses same-source points within 15 seconds of the 60/120-second targets and requires a valid final workout point within 30 seconds of the end. HR zones remain NULL without a configured threshold basis. Pace uses recorded duration and workout distance; energy remains workout-reported energy. Walking gait statistics are walking-workout-only; VO2Max is contextual.

Corrections retain original raw archive versions and refresh only the workout summary/derived metrics. Historical observation/link rows are not modified. A conflicting source-workout correction requires a strictly newer verified extraction time. After the first summary-only refresh, an input fingerprint in workout provenance also protects against stale/unverified sample-only corrections. Older V1 workouts without this fingerprint can receive their first summary refresh from a complete validated payload. `derived_extra.summary_revision=summary-only-v1` records the persistence/calculation-input revision without changing the configured algorithm version. Changed configuration or concurrent workout provenance invalidates stale work and requires retry. No workout is deleted merely because a later lookback omitted it. Existing conservative strength matching and manual rejections are preserved.

### 8. Report the result and stop

Summarize committed workout counts, excluded records and quality limitations. Exact replay must add no workouts or observations. Do not enable `automation_enabled`, create a ChatGPT Scheduled Task, install cron, change the PWA or expand the historical scope during this manual evaluation.

## What the current tests establish

The summary-only bridge suite uses real isolated PostgreSQL and the actual staging/claim/commit functions and worker, with synthetic data and fake pg_net/Storage. It covers fresh/replayed imports, zero point/link writes, byte-identical historical observation/link preservation, archive/checksum failures, exact derived readback, atomic rollback, private privileges/owner isolation, correction ordering, HR source separation/percentiles/coverage/recovery, walking/VO2 metrics, sparse/conflicting-input flags, DST and strength matching/manual rejections without changes to lifting logs or Ledger RPCs. A synthetic ambiguity regression confirms the original link trigger still rejects an ambiguous association while summary-only reprocessing succeeds.

After synthetic checks passed, the retained failed strength payload was copied read-only to an isolated local database with the existing workout records as context. Summary-only processing and a separate replay completed without association errors, created no observations/links and preserved the existing workout count. Private fixtures, source identifiers and reports are outside Git. After deployment approval, the same production job was retried successfully through the existing dispatch helper; its earlier failed attempt remains in the audit history. A separate replay under a new request key also completed without duplicate rows.

Production validation now also proves SQL → pg_net → background worker → byte-verified private archives → summary-only atomic projections, successful retry/replay, zero new samples/links, staging cleanup and unchanged historical/lifting data checksums. Native Health attachment access in every ChatGPT conversation and unattended cross-connector approvals remain separate capability gates. Reference-trial units remain labeled as accepted reference metadata, rather than fresh query-summary verification.
