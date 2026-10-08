# One-time historical migration

The converter reads files only. It never connects to Google Sheets or Supabase, modifies the workbook, or deletes data. All actual workout exports and generated reports must remain private, outside this repository.

## Prepare sources

- Export the **current** Google Sheet as `.xlsx`, including all tabs. The supplied initial workbook contains template examples, not the complete history.
- In the original iPhone app, use Data → Download full backup (JSON). Keep it unchanged. It can contain custom exercise IDs and routines, unsynced sessions, cardio/body, and active workout data that the Sheet lacks.
- Retain the original template workbook for sample detection.
- Install Python 3 and `openpyxl` for read-only XLSX extraction (`python3 -m pip install openpyxl` in a local virtual environment). Node is used for core validation/readback checks.

## Generate a review candidate

Run from the repository. Paths below are examples to private files outside it:

```sh
node tools/export-catalog.cjs > ../migration-private/catalog.json
python3 tools/migrate.py \
  --xlsx ../migration-private/current-sheet.xlsx \
  --backup ../migration-private/phone-backup.json \
  --template ../IronLedger_Backend.xlsx \
  --catalog ../migration-private/catalog.json \
  --out ../migration-private/review
```

You may omit `--backup` for an initial audit, but the report will flag unreconciled phone data. Dates are normalized as calendar dates without conversion through UTC. `logged_at` timestamps retain their timezone and become epoch milliseconds; original values and available metadata are retained in `_source`. Missing start/end times are left absent rather than invented from duration.

Outputs:

- `candidate.json`: complete nested sessions and reconstructed exercise/routine definitions, with a review gate.
- `report.json`: source/destination counts, original-ID associations, missing exercise definitions, errors/conflicts and review codes.
- `source-archive.json`: all source tabs, including Apple Health and other tabs not loaded into the five app tables.

Exit code **2** means review is required. Exit code **0** means the converter's integrity checks and explicit review decisions passed. It is not proof of a database write.

Stable set IDs link records to the phone's original exercise IDs when available. Otherwise an exact reference/catalog/name match is used, then deterministic IDs for missing historical names. Similar spellings are never merged. Multiple exact-name definitions, conflicting facts, duplicate IDs and orphan sets are not silently resolved. Existing reference definitions and routines remain intact.

## Review findings explicitly

Do not delete questionable source rows. Use a private JSON decisions file to document reviewed choices:

```json
{
  "exerciseIds": {},
  "exclude": {"sessions": [], "cardio": [], "body": []},
  "acknowledge": []
}
```

- `exerciseIds` maps an exact historical name to a verified original ID when sources are ambiguous. Prefer using the original phone backup.
- `exclude` lists exact record IDs to omit from the **candidate only** after owner review. Excluding a session excludes its associated set rows; exclusions are reported.
- `acknowledge` lists exact review codes from the report when the owner knowingly keeps a discrepancy. It does not suppress duplicate/orphan errors or conflicting facts.
- `phone-backup-missing` can be acknowledged only if the owner accepts that phone-only data and original custom IDs remain unreconciled. Obtain the backup whenever possible.

Rerun with `--decisions ../migration-private/decisions.json`. Keep the decisions, reports and source hashes with your backups. Resolve actual conflicting facts by checking both original sources and preparing an explicitly reviewed source copy; never edit the sole original. Rerunning the same inputs produces stable IDs and does not generate duplicate records.

The first live-source audit found template examples still present and one mismatch between a session's claimed totals and its individual set rows. Those remain preserved and flagged; the owner deferred their review. They do not block development, but the final import should record an explicit keep/exclude decision.

## Import only into the development project first

1. Configure the private preview with the development Supabase project and sign in. Confirm it is not the current production origin.
2. In Data → Restore from backup, select the reviewed, unblocked `candidate.json`. The app merges by stable IDs, saves a safety backup, and reports conflicts instead of replacing existing data. An active session from the phone backup stays local; it is not marked completed or uploaded prematurely.
3. Keep the app online until Data reports database-confirmed saves. Resolve any cloud conflicts by reviewing both versions. Reimporting the same candidate is idempotent; richer existing records are not replaced by partial source rows.
4. Open a fresh second preview browser/device, sign in, and allow it to download all records. Do not import the candidate into this second browser: it must retrieve data from Supabase.
5. Download its full JSON backup and compare:

```sh
node tools/verify-import.cjs \
  ../migration-private/review/candidate.json \
  ../migration-private/fresh-device-backup.json
```

The check compares every expected record, session/set ID, working/warmup count, preserved metadata and historical PRs. It reports extra destination records separately so test workouts can be reviewed. A local candidate compared to itself is only a transformation smoke test, not cloud verification.

6. Search several actual historical exercises, including custom ones. Inspect all matching sessions and every set. A name with no source records correctly shows no history; the converter does not invent or merge similar lifts to populate a chart.
7. Complete an offline test workout with a custom exercise; reopen online and verify it appears exactly once on the second device. Export again.

## Production migration and recovery

Only after owner approval, repeat using fresh source exports and the approved destination project. Record source hashes and verified totals. Keep the original Sheet as an untouched archive; the Shortcut may continue writing health rows there. Follow [SETUP.md](SETUP.md) for production cutover and rollback. The converter provides no destructive import, delete, truncate or overwrite command.
