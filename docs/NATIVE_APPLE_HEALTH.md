# Native Apple Health export → Mac → Iron Ledger

This is the current import pathway. No paid exporter app, Shortcut or live phone sync is required. Export manually as often as desired (weekly is fine); the Mac handles parsing, integrity verification, replay protection and uploads. The existing Supabase project is used. The current PWA release is not changed by preparing or archiving exports.

## What is preserved

Every export file is retained, including XML, CDA, GPX routes, ECG CSV, clinical FHIR JSON and unrecognized attachments. Finder housekeeping (`.DS_Store`, `.localized`, `._*`, `__MACOSX`) is excluded. The original files are deterministically gzip-compressed, split into 128 KiB pieces and wrapped as JSON for the existing private raw bucket. Each original file, compressed file, piece and upload body has a SHA-256 checksum. A manifest records paths, lengths, order and hashes. Restoration verifies the bytes against the original-file hashes.

The XML parser streams complete root children, preserving unknown attributes, metadata and nested RR intervals. It stages every root Record as a generic observation, including categorical values, and every workout with its original structure/statistics/events. Other root elements become private generic events. Auxiliary attachment contents stay in the raw archive; their file metadata and checksum are indexed in the manifest. Future complex XML families remain preserved even before a specialized parser exists.

The local SQLite staging database provides typed metric/date/value/unit/source queries for all readings and typed workout lookup. It contains private health data and must stay outside the repository. No source payloads, device identifiers, dates of birth, routes, clinical details or credentials belong in fixtures, screenshots, public reports or logs. Fixtures in tests are synthetic.

## Weekly workflow

1. In the iPhone Health app, use Summary → profile → Export All Health Data. Save/AirDrop the export to the Mac and extract its folder. This is the only phone-side step.
2. From the repository, prepare the folder into a **new private destination for that export**:

```sh
python3 tools/import-apple-health.py prepare ~/Downloads/apple_health_export \
  --destination ../migration-private/apple-native/YYYY-MM-DD
python3 tools/import-apple-health.py verify ../migration-private/apple-native/YYYY-MM-DD
python3 tools/import-apple-health.py review ../migration-private/apple-native/YYYY-MM-DD
```

Preparation and verification are local and never contact Supabase. Use a dated destination so older original snapshots remain recoverable. Do not place the destination inside the export folder. The importer refuses symlinks, external XML entities, unsafe references, missing referenced route files, corrupted archives and a reused destination containing a different export. Re-preparing a completed, unchanged export returns its existing report. Interrupted preparation can be rerun; an incomplete plan cannot upload.

3. Review storage capacity and choose an explicit projection scope before the first historical upload:

```sh
# All original files in private Supabase Storage; workouts in Supabase tables.
# Every reading remains queryable in the private local SQLite database.
python3 tools/import-apple-health.py upload ../migration-private/apple-native/YYYY-MM-DD \
  --credentials ../migration-private/health-import/credentials.json \
  --projection workouts
```

`--projection all` also indexes all readings/events in PostgreSQL. `--projection none` archives originals only. The default is `all`, preserving the comprehensive design unless the owner explicitly chooses a smaller cloud projection. The tool refuses full projection when its payload estimate exceeds the configured database budget (default 450 MiB). This is a preliminary guard, not a PostgreSQL quota guarantee: indexed rows can use substantially more space than payload JSON. `tools/estimate-health-db.cjs PREPARED_FOLDER TOTAL_READINGS` measures a private in-memory PostgreSQL sample and prints only aggregate size estimates. It also reports an experimental compact-schema estimate, which is **not an implemented storage option**.

Supabase currently documents a 500 MB database and 1 GB object Storage allowance on its free plan. Full history with high-resolution readings may exceed either limit. A compressed source archive and selected workout projections can be much smaller. The importer does not change or purchase a hosting plan. Do not increase the local budget override unless adequate actual project capacity has been arranged.

4. Uploads resume from acknowledged batches. `--limit N` bounds the number of additional HTTP requests for a staged trial; rerun without it to continue. A private delivery cache next to the prepared folders skips unchanged readings/workouts in later weekly exports. Only successful acknowledgments enter the cache; changed source values are reconsidered. Lost responses are safe to retry. Switching account credentials resets local acknowledgment assumptions; the server always derives ownership from the token.

The prepared SQLite database and delivery cache must remain together for efficient weekly imports. Losing the cache causes safe replay, not silent omissions. No upstream absence is interpreted as deletion. Raw snapshots are versioned; there is no automatic retention purge.

## Backend validation

The existing authenticated `import-health` endpoint accepts `nativeAppleArchive` chunks/manifests and `nativeAppleEvents`, plus ordinary metric/workout projections carrying a `native_source` descriptor. Native sample batches are explicitly marked unaggregated; native workout statistics retain their aggregated interval semantics. Vendor multi-metric aggregation assumptions do not apply to native XML readings.

The server checks decoded piece hashes before accepting archive chunks. It verifies every manifest reference against completed owner-scoped archived chunks and their file/hash/index/length metadata. Native projections cannot succeed until their matching manifest is complete. Invalid dependencies leave raw requests retryable, rather than claiming successful ingestion. Chunk requests, manifests and projections all use the existing private immutable raw archive and audit batches; no new source-table writer or broad client grant is introduced.

Upload bodies are approximately 192 KiB for projections and 175 KiB for raw chunks, below the original 2 MiB request ceiling. Global rate limiting remains 60 authenticated attempts/minute; the uploader paces requests and retries transient failures/429. Large original files are never sent as giant Edge request bodies. Deployed v2 was smoke-tested with a tiny synthetic XML file, a validated manifest, empty projections and an exact replay. The Python uploader also passed a live synthetic random-attachment test at the planned 128 KiB chunk size; no actual medical records were written by either check.

## Identity and corrections

Native exports do not universally supply stable record UUIDs. A vendor sync identifier/external UUID is used when present. Otherwise readings use full content fingerprints, with transient HKDevice memory addresses excluded **from identity only**; original device strings remain in the archive and local point detail. Identical records are deduplicated in projections, with original duplicates retained in raw files. Changed no-ID values remain variants and must not be blindly summed as separate samples.

Workout fallback identity uses activity/start/source/device, so updated statistics or end times do not create a second run. Ambiguous source identities still need review; no source can guarantee deletion/correction semantics when Apple omits stable IDs. Manual lifting links/rejections remain preserved by the existing reconciliation policy. Native route presence comes from verified referenced GPX files; HR summaries are used only when exported workout statistics provide them. Missing summaries are not fabricated or derived from flawed Ledger end times.

## Recovery

```sh
python3 tools/import-apple-health.py restore ../migration-private/apple-native/YYYY-MM-DD \
  --destination ../migration-private/apple-native/restored-YYYY-MM-DD
```

Local restoration verifies every piece, compressed file and original checksum before writing. Existing destination files are never overwritten. A cloud-only recovery requires an owner-scoped privileged Storage retrieval of the manifest and its referenced batch objects, then the same checksum/gzip reconstruction; a public raw-download route is intentionally not exposed. Keep a private Mac backup of the prepared folders and credentials. The PWA’s ordinary JSON backup covers legacy Ledger records, not the native health archive.

References: [Apple export instructions](https://support.apple.com/guide/iphone/share-your-health-data-iph5ede58c3d/ios), [Supabase capacity](https://supabase.com/pricing).
