# Native ChatGPT Health: database foundation

This supersedes the broad XML/vendor collection scope for the current experiment. The native XML importer remains available separately; do not run its broad historical upload for this V1.

The SQL staging → private worker bridge is now implemented separately and awaits deployment approval. See [CHATGPT_HEALTH_EXECUTION_RUNBOOK.md](CHATGPT_HEALTH_EXECUTION_RUNBOOK.md) for the exact SQL-only ChatGPT execution path, supported input manifest and honest capability gates. The foundation described here remains deployed; the new bridge is not yet live.

V1 is a manually initiated evaluation of Apple Watch workouts starting on or after **September 1, 2026, midnight America/Los_Angeles** (`2026-09-01T07:00:00Z`). Include all eligible workout activity types, not only running and strength. Preserve existing Iron Ledger logs. Recurring triggers, real-data backfill and PWA changes are separate steps. A stored automation flag is not a scheduled task.

## Database objects

Reuse the existing `health_workouts`, `health_metric_observations`, `health_import_batches`, private `health-raw` bucket and `health_workout_matches`.

| Object | Purpose |
| --- | --- |
| `health_workouts.reported_workout_energy_kcal` | Native `total_energy_kcal`, without claiming it is active calories. Leave `active_energy` NULL for this connector. |
| `health_sync_config` | Owner-scoped cutoff, timezone, rolling lookback, exact metric identifiers, source policy and algorithm version. Automation defaults off. Verified workout source allowlist starts empty. |
| `health_sync_runs` | Durable manual/backfill/test/failed/partial attempts, requested windows, completeness, counts and readback/archive attestations. Failures can be recorded before a payload batch exists. |
| `health_workout_derived` | Versioned computed results, primary HR source policy, coverage, counts, quality flags and formula provenance. Missing results remain NULL. |
| `health_workout_observation_links` | A compact FK link from a workout to one existing observation. Does not copy the point JSON a second time. A sample can be assigned to at most one workout. |
| `health_connector_sync_status` | Read-only latest attempt and last successful window; owner-only underlying RLS. |
| `health_connector_workout_summary` | Read-only native workout plus the configured derived algorithm version and existing strength-log match. |
| `health_connector_workout_points` | Read-only linked measurements for charts, excluding duplicate raw JSON. |

All four new tables have RLS. Authenticated PWA users receive SELECT only for their own rows; anonymous access and PWA writes are denied. Views use `security_invoker=true`. Trusted admin SQL through the Supabase connector and the server's service role can write. No new client credential or broadly callable privileged import function is created.

The existing `health_workout_series` remains compatible with the older importers. Native V1 uses the normalized links instead; do not populate both representations for the same sample or union them blindly in charts. A new metric requires updating the reviewed owner config, not adding a numeric SQL column.

## Defaults and association guards

- September 1 or later, Los Angeles timezone, 7-day lookback.
- All 22 specified metric identifiers are represented in config. Coarse buckets and optional audio/environment signals default **off**; deliberately omit those groups during manual extraction unless enabled after review.
- No guessed source bundle identifier. Read the Health response, verify Watch workout provenance, then populate `source_policy.workout_source_allowlist` with the exact approved identifiers. Human-readable device names alone are insufficient.
- WHOOP/Oura sources are rejected for native linkage, including concurrent readings.
- Original observations retain `value_jsonb`; provenance includes `connector: "chatgpt_health_native"`, units, original local/UTC time semantics, response completeness and archive pointer.
- Workouts also require `provenance_jsonb.connector = "chatgpt_health_native"` and `source_bundle_identifier` for native links.
- `within_workout`, `overlaps_workout`, `near_workout_context` and `post_workout_recovery` are separate associations. The guard validates interval boundaries and rejects overlap with another recorded workout rather than guessing an assignment.
- Five-minute post-workout HR is permitted by config; it is not automatically fetched. VO2Max context must be within 30 minutes of the workout end and the selected workout must be a run/walk. Walking gait samples require a walking workout.
- Hour-bucket metrics (`stepCount`, `distanceWalkingRunning`, `activeEnergyBurned`, `basalEnergyBurned`, `flightsClimbed`) cannot be linked as precise workout series. If explicitly retained later, keep them only as coarse/unattributable observations.
- The guards run when a link is written. Later corrections to workouts/observations must revalidate affected links and recompute derived results; existing cached results are not automatically revalidated by this foundation.

## Trusted manual writer contract

The Supabase connector exposes administrative SQL. That verifies database access, not a Health-to-database transfer. A different ChatGPT chat or scheduled task must separately have both connectors authorized; this Codex environment does not expose native Health tools.

1. Resolve the intended owner from verified app/account context. Never guess an owner UUID or select the first owner when multiple exist.
2. Retrieve native Health workouts and relevant timestamped measurements for the bounded eligible workout windows. Parse every row in authorized attachments. Inspect completeness, omitted rows, limits and timestamp semantics. This repository contains no real Health response fixture.
3. Verify exact workout source identifiers and update the owner's config. Do not enable automation as part of a manual import.
4. Archive exact connector response JSON in the existing private raw bucket **before** projection. Keep batches below 2 MiB, with a lower practical target. The SQL connector alone does not upload object bytes; writing `storage.objects` metadata does not create an archive file. Use a trusted uploader/adapter, and verify storage acceptance.
5. Register a batch in `health_import_batches`, with original SHA-256/bytes/path and connector/window/provenance. Native Health JSON is **not** compatible with the existing v2 Edge Function envelope by assumption; it still needs a validated native adapter or equally safe trusted import procedure. Do not send it unadapted to `import-health`.
6. In a transaction, upsert native workouts by a stable source ID if verified; otherwise compute a deterministic key from owner, source bundle, raw activity and start epoch milliseconds. Preserve the full-record fingerprint to detect corrections/ambiguous exact-start duplicates. Map energy to `reported_workout_energy_kcal`, not `active_energy`. Store the original raw activity and timestamps in provenance; normalize activity names without inferring absent data.
7. Source-aware observation fingerprints include owner, metric, times, source bundle, original unit, aggregation and value. Do not lose simultaneous Watch and Bluetooth readings. Insert original observations once, then link eligible points with `health_workout_observation_links`. Hourly buckets never become exact workout totals. Corrections need explicit supersession/review so changed values are not summed as independent extra measurements.
8. Compute derived metrics using documented code and one chosen HR stream. Populate `health_workout_derived` with matching `algorithm_version`, source selection, method, gap cap and quality flags. Do not manufacture HR zones without threshold basis/version, workout steps, GPS, running power/cadence, or strength sets/reps. HR average and recovery are not computed by the schema itself.
9. Reuse the existing conservative strength matching logic without changing session JSON or installing the deferred trigger on Ledger writes. Preserve manual links/rejections.
10. Mark the raw batch completed only after validated projection. Read back committed row counts and raw archive acceptance. A succeeded sync run requires `result_complete=true`, reconciled workout counts, empty errors, finish/last-success timestamps, and `verification_jsonb` with `database_readback_verified` and `raw_archives_verified` set true. These are trusted importer attestations, not automatic verification performed by the table.

Keep privileged keys and the existing import token out of prompts, repository files, app JS and shared links. The database remains able to accept ordinary trusted SQL writes; the new link guard is defense in depth, not a replacement for the native adapter's complete source, unit, timestamp, cutoff, correction and archive validation.

## Read-only review queries

Run in a trusted SQL session with the verified owner parameter bound by the caller (or via an authenticated owner-scoped API). Do not paste personal result rows into public issues or logs.

```sql
select * from public.health_connector_sync_status where user_id = $1;
select * from public.health_connector_workout_summary
 where user_id = $1 order by start_at desc;
select metric_name, observed_at, end_at, value_numeric, unit, source, association
 from public.health_connector_workout_points
 where user_id = $1 and workout_key = $2
 order by observed_at, source;
```

## Validation and remaining work

`tests/health-connector-sql.cjs` applies the migration to isolated PostgreSQL with synthetic users and measurements. It checks Ledger function/trigger/data preservation, energy/duration semantics, timezone/DST boundaries, owner-only views, denied frontend writes, source allowlisting, cutoff, coarse buckets, optional groups, boundary/context/recovery associations, ambiguity, replay, derived-quality constraints and incomplete-sync handling. Existing health SQL tests continue to cover one-to-one strength matches and prior importer compatibility.

No data extraction, native payload adapter, formula worker, real backfill, scheduled trigger or PWA update is implied by database creation. The next integration test needs an authorized native Health attachment plus a verified private archive upload path. Start with a small reviewed run/strength/walk sample, then test exact replay before considering a larger backfill or automation.
