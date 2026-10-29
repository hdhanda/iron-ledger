-- Native ChatGPT Health V1 database foundation. No payload import or scheduled job.
-- The legacy Ledger write/sync contract and existing Edge Function are unchanged.
begin;
set local lock_timeout = '5s';

alter table public.health_workouts
 add column reported_workout_energy_kcal double precision
 check (reported_workout_energy_kcal >= 0 and reported_workout_energy_kcal < 'Infinity'::float8);
comment on column public.health_workouts.reported_workout_energy_kcal is
 'Native total_energy_kcal exactly as reported. Not verified active energy; native imports leave active_energy NULL.';

create table public.health_sync_config (
 user_id uuid primary key references auth.users(id),
 connector text not null default 'chatgpt_health_native' check (connector = 'chatgpt_health_native'),
 schema_version integer not null default 1 check (schema_version = 1),
 cutoff_local_date date not null default '2026-09-01' check (cutoff_local_date >= '2026-09-01'),
 timezone text not null default 'America/Los_Angeles' check (timezone = 'America/Los_Angeles'),
 rolling_lookback_days integer not null default 7 check (rolling_lookback_days between 1 and 30),
 automation_enabled boolean not null default false,
 include_coarse_buckets boolean not null default false,
 include_optional_environment boolean not null default false,
 post_workout_hr_minutes integer not null default 5 check (post_workout_hr_minutes between 0 and 5),
 enabled_metric_identifiers text[] not null default array[
  'heartRate','vo2Max','oxygenSaturation','walkingHeartRateAverage','appleExerciseTime',
  'appleStandTime','walkingSpeed','walkingStepLength','walkingAsymmetryPercentage',
  'walkingDoubleSupportPercentage','stairAscentSpeed','stairDescentSpeed',
  'heartRateVariabilitySDNN','restingHeartRate','sixMinuteWalkTestDistance',
  'stepCount','distanceWalkingRunning','activeEnergyBurned','basalEnergyBurned',
  'flightsClimbed','environmentalAudioExposure','headphoneAudioExposure'],
 source_policy jsonb not null default '{"version":"watch-primary-v1","workout_source_allowlist":[],"excluded_sources":["whoop","oura"],"primary_hr":"apple_watch","external_hr_requires_explicit_selection":true}',
 algorithm_version text not null default 'chatgpt-health-v1' check (length(algorithm_version) between 1 and 100),
 updated_at timestamptz not null default now(),
 check (jsonb_typeof(source_policy) = 'object'),
 check (coalesce(jsonb_typeof(source_policy->'workout_source_allowlist') = 'array',false)),
 check (cardinality(enabled_metric_identifiers) between 1 and 100)
);
comment on column public.health_sync_config.automation_enabled is
 'Configuration only, default false. Updating this does not create or authorize a scheduled task.';
comment on column public.health_sync_config.source_policy is
 'Populate workout_source_allowlist with connector-verified source bundle identifiers before native sample linkage. No guessed bundle IDs.';

create table public.health_sync_runs (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 trigger_type text not null check (trigger_type in ('manual','backfill','scheduled','verification','recompute')),
 status text not null default 'running' check (status in ('running','succeeded','partial','failed','cancelled')),
 requested_start_at timestamptz not null check (requested_start_at >= '2026-09-01T07:00:00Z'),
 requested_end_at timestamptz not null,
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 workouts_seen integer not null default 0 check (workouts_seen >= 0),
 workouts_inserted integer not null default 0 check (workouts_inserted >= 0),
 workouts_updated integer not null default 0 check (workouts_updated >= 0),
 workouts_unchanged integer not null default 0 check (workouts_unchanged >= 0),
 observations_seen integer not null default 0 check (observations_seen >= 0),
 observations_inserted integer not null default 0 check (observations_inserted >= 0),
 errors_redacted jsonb not null default '[]' check (jsonb_typeof(errors_redacted) = 'array'),
 result_complete boolean not null default false,
 connector_coverage_through timestamptz,
 last_successful_at timestamptz,
 import_batches jsonb not null default '[]' check (jsonb_typeof(import_batches) = 'array'),
 algorithm_version text not null default 'chatgpt-health-v1',
 verification_jsonb jsonb not null default '{}' check (jsonb_typeof(verification_jsonb) = 'object'),
 unique(user_id,id),
 check (requested_end_at > requested_start_at),
 check (finished_at is null or finished_at >= started_at),
 check ((status = 'running' and finished_at is null) or (status <> 'running' and finished_at is not null)),
 check (observations_inserted <= observations_seen),
 check (status <> 'succeeded' or (
  result_complete and errors_redacted = '[]'::jsonb
  and workouts_seen = workouts_inserted + workouts_updated + workouts_unchanged
  and coalesce(verification_jsonb->>'database_readback_verified','false') = 'true'
  and coalesce(verification_jsonb->>'raw_archives_verified','false') = 'true'
  and last_successful_at is not null and last_successful_at = finished_at
 )),
 check (status = 'succeeded' or last_successful_at is null)
);
create index health_sync_runs_owner_started on public.health_sync_runs(user_id,started_at desc);
comment on table public.health_sync_runs is
 'Durable attempts including pre-ingest failures. Success requires explicit extraction completeness, archive/readback attestations and reconciled counts from the trusted importer.';

create table public.health_workout_derived (
 user_id uuid not null references auth.users(id),
 workout_key text not null,
 algorithm_version text not null check (length(algorithm_version) between 1 and 100),
 source_policy text not null,
 computed_at timestamptz not null default now(),
 sample_count integer not null default 0 check (sample_count >= 0),
 coverage_ratio double precision check (coverage_ratio between 0 and 1),
 hr_avg_bpm double precision check (hr_avg_bpm >= 0 and hr_avg_bpm < 'Infinity'::float8),
 hr_min_bpm double precision check (hr_min_bpm >= 0 and hr_min_bpm < 'Infinity'::float8),
 hr_max_bpm double precision check (hr_max_bpm >= 0 and hr_max_bpm < 'Infinity'::float8),
 hr_p50_bpm double precision check (hr_p50_bpm >= 0 and hr_p50_bpm < 'Infinity'::float8),
 hr_p95_bpm double precision check (hr_p95_bpm >= 0 and hr_p95_bpm < 'Infinity'::float8),
 hr_zone_seconds jsonb check (jsonb_typeof(hr_zone_seconds) = 'object'),
 elapsed_sec double precision check (elapsed_sec >= 0 and elapsed_sec < 'Infinity'::float8),
 duration_sec double precision check (duration_sec >= 0 and duration_sec < 'Infinity'::float8),
 estimated_paused_sec double precision check (estimated_paused_sec >= 0 and estimated_paused_sec < 'Infinity'::float8),
 distance_m double precision check (distance_m >= 0 and distance_m < 'Infinity'::float8),
 pace_moving_sec_per_km double precision check (pace_moving_sec_per_km > 0 and pace_moving_sec_per_km < 'Infinity'::float8),
 pace_elapsed_sec_per_km double precision check (pace_elapsed_sec_per_km > 0 and pace_elapsed_sec_per_km < 'Infinity'::float8),
 speed_mean_mps double precision check (speed_mean_mps >= 0 and speed_mean_mps < 'Infinity'::float8),
 energy_per_min_kcal double precision check (energy_per_min_kcal >= 0 and energy_per_min_kcal < 'Infinity'::float8),
 heart_rate_recovery_1min_bpm double precision check (heart_rate_recovery_1min_bpm > '-Infinity'::float8 and heart_rate_recovery_1min_bpm < 'Infinity'::float8),
 heart_rate_recovery_2min_bpm double precision check (heart_rate_recovery_2min_bpm > '-Infinity'::float8 and heart_rate_recovery_2min_bpm < 'Infinity'::float8),
 walking_gait_summary jsonb check (jsonb_typeof(walking_gait_summary) = 'object'),
 vo2max_context jsonb check (jsonb_typeof(vo2max_context) = 'object'),
 quality_flags text[] not null default '{}',
 data_sources jsonb not null default '{}' check (jsonb_typeof(data_sources) = 'object'),
 derived_extra jsonb not null default '{}' check (jsonb_typeof(derived_extra) = 'object'),
 primary key(user_id,workout_key,algorithm_version),
 foreign key(user_id,workout_key) references public.health_workouts(user_id,workout_key),
 check (hr_min_bpm is null or hr_max_bpm is null or hr_min_bpm <= hr_max_bpm),
 check (hr_min_bpm is null or hr_avg_bpm is null or hr_min_bpm <= hr_avg_bpm),
 check (hr_avg_bpm is null or hr_max_bpm is null or hr_avg_bpm <= hr_max_bpm),
 check (hr_zone_seconds is null or coalesce(derived_extra->>'hr_zone_basis_version','') <> '')
);
comment on table public.health_workout_derived is
 'Versioned computed results, not source records. Missing/low-quality inputs remain NULL. Record HR stream, method, gap cap, unit conversions and thresholds in data_sources/derived_extra.';

-- Reuse the existing observation once; do not duplicate its JSON in workout_series.
create table public.health_workout_observation_links (
 user_id uuid not null references auth.users(id),
 workout_key text not null,
 observation_id uuid not null,
 association text not null check (association in ('within_workout','overlaps_workout','near_workout_context','post_workout_recovery')),
 association_version text not null default 'chatgpt-health-v1',
 quality_flags text[] not null default '{}',
 linked_at timestamptz not null default now(),
 primary key(user_id,workout_key,observation_id),
 unique(user_id,observation_id),
 foreign key(user_id,workout_key) references public.health_workouts(user_id,workout_key),
 foreign key(user_id,observation_id) references public.health_metric_observations(user_id,id)
);
comment on table public.health_workout_observation_links is
 'Normalized V1 alternative to copying points into health_workout_series. One observation belongs to at most one workout; ambiguous associations require review.';

create function health_private.validate_connector_workout_link() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
 w public.health_workouts;
 o public.health_metric_observations;
 c public.health_sync_config;
 sample_end timestamptz;
begin
 select * into strict w from public.health_workouts where user_id = new.user_id and workout_key = new.workout_key;
 select * into strict o from public.health_metric_observations where user_id = new.user_id and id = new.observation_id;
 select * into strict c from public.health_sync_config where user_id = new.user_id;
 if w.start_at < (c.cutoff_local_date::timestamp at time zone c.timezone)
    or coalesce(w.provenance_jsonb->>'connector','') <> 'chatgpt_health_native'
    or coalesce(o.provenance_jsonb->>'connector','') <> 'chatgpt_health_native' then
  raise exception 'connector_scope_required';
 end if;
 if not exists (select 1 from jsonb_array_elements_text(c.source_policy->'workout_source_allowlist') s(bundle)
                where s.bundle = w.provenance_jsonb->>'source_bundle_identifier') then
  raise exception 'verified_workout_source_required';
 end if;
 if lower(concat_ws(' ',w.source,o.source,o.value_jsonb->>'source_name',o.value_jsonb->>'source_bundle_identifier')) ~ '(whoop|oura)' then
  raise exception 'excluded_connector_source';
 end if;
 if not (o.metric_name = any(c.enabled_metric_identifiers)) then raise exception 'metric_not_enabled'; end if;
 if o.metric_name in ('stepCount','distanceWalkingRunning','activeEnergyBurned','basalEnergyBurned','flightsClimbed')
    or lower(coalesce(o.aggregation_level,'')) in ('hour','hourly','60min','60m')
    or o.provenance_jsonb->>'association' = 'coarse_unattributable' then
  raise exception 'coarse_samples_cannot_link';
 end if;
 if o.metric_name in ('environmentalAudioExposure','headphoneAudioExposure') and not c.include_optional_environment then
  raise exception 'optional_environment_disabled';
 end if;
 if o.metric_name in ('walkingSpeed','walkingStepLength','walkingAsymmetryPercentage','walkingDoubleSupportPercentage')
    and w.activity_type not in ('Walking','HKWorkoutActivityTypeWalking') then raise exception 'gait_requires_walking_workout'; end if;
 sample_end := coalesce(o.end_at,o.observed_at);
 if o.observed_at is null or sample_end < o.observed_at then raise exception 'invalid_sample_interval'; end if;
 if new.association = 'within_workout' then
  if o.observed_at < w.start_at or sample_end > w.end_at or o.observed_at >= w.end_at then raise exception 'sample_not_within_workout'; end if;
 elsif new.association = 'overlaps_workout' then
  if o.observed_at >= w.end_at or sample_end <= w.start_at
     or (o.observed_at >= w.start_at and sample_end <= w.end_at) then raise exception 'sample_not_boundary_overlap'; end if;
 elsif new.association = 'near_workout_context' then
  if o.metric_name <> 'vo2Max' or w.activity_type not in ('Running','Walking','HKWorkoutActivityTypeRunning','HKWorkoutActivityTypeWalking')
     or o.observed_at < w.end_at - interval '30 minutes'
     or sample_end > w.end_at + interval '30 minutes' then raise exception 'invalid_near_workout_context'; end if;
 elsif new.association = 'post_workout_recovery' then
  if o.metric_name <> 'heartRate' or c.post_workout_hr_minutes = 0 or o.observed_at < w.end_at
     or sample_end > w.end_at + make_interval(mins => c.post_workout_hr_minutes) then raise exception 'invalid_recovery_window'; end if;
 end if;
 if exists (select 1 from public.health_workouts other where other.user_id = new.user_id
  and other.workout_key <> new.workout_key and other.end_at > o.observed_at
  and (other.start_at < sample_end or (sample_end = o.observed_at and other.start_at = o.observed_at))) then
  raise exception 'ambiguous_workout_association'; end if;
 return new;
end $$;
revoke all on function health_private.validate_connector_workout_link() from public,anon,authenticated;
grant execute on function health_private.validate_connector_workout_link() to service_role;
create trigger health_connector_link_validate before insert or update on public.health_workout_observation_links
 for each row execute function health_private.validate_connector_workout_link();

-- Owner-only frontend reads; trusted connector SQL/service role performs writes.
alter table public.health_sync_config enable row level security;
alter table public.health_sync_runs enable row level security;
alter table public.health_workout_derived enable row level security;
alter table public.health_workout_observation_links enable row level security;
revoke all on public.health_sync_config,public.health_sync_runs,public.health_workout_derived,public.health_workout_observation_links from public,anon,authenticated;
grant select on public.health_sync_config,public.health_sync_runs,public.health_workout_derived,public.health_workout_observation_links to authenticated;
grant all on public.health_sync_config,public.health_sync_runs,public.health_workout_derived,public.health_workout_observation_links to service_role;
create policy health_owner_read on public.health_sync_config for select to authenticated using ((select auth.uid()) = user_id);
create policy health_owner_read on public.health_sync_runs for select to authenticated using ((select auth.uid()) = user_id);
create policy health_owner_read on public.health_workout_derived for select to authenticated using ((select auth.uid()) = user_id);
create policy health_owner_read on public.health_workout_observation_links for select to authenticated using ((select auth.uid()) = user_id);

create view public.health_connector_sync_status with (security_invoker = true) as
 select c.user_id,c.connector,c.cutoff_local_date,c.timezone,c.rolling_lookback_days,c.automation_enabled,
  c.source_policy->'workout_source_allowlist' <> '[]'::jsonb as workout_sources_configured,
  r.id as latest_run_id,r.status as latest_run_status,r.started_at as latest_attempt_at,
  s.finished_at as last_successful_at,s.requested_end_at as last_successful_window_end,
  coalesce(r.status in ('partial','failed'),false) as needs_attention
 from public.health_sync_config c
 left join lateral (select id,status,started_at from public.health_sync_runs where user_id=c.user_id order by started_at desc,id desc limit 1) r on true
 left join lateral (select finished_at,requested_end_at from public.health_sync_runs where user_id=c.user_id and status='succeeded' order by finished_at desc,id desc limit 1) s on true;

create view public.health_connector_workout_summary with (security_invoker = true) as
 select w.id,w.user_id,w.workout_key,w.activity_type,w.start_at,w.end_at,w.duration_sec,w.distance_m,
  w.reported_workout_energy_kcal,w.source,w.provenance_jsonb,
  d.algorithm_version,d.source_policy,d.computed_at,d.sample_count,d.coverage_ratio,
  d.hr_avg_bpm,d.hr_min_bpm,d.hr_max_bpm,d.hr_p50_bpm,d.hr_p95_bpm,
  d.elapsed_sec,d.estimated_paused_sec,d.pace_moving_sec_per_km,d.pace_elapsed_sec_per_km,
  d.speed_mean_mps,d.energy_per_min_kcal,d.hr_zone_seconds,
  d.heart_rate_recovery_1min_bpm,d.heart_rate_recovery_2min_bpm,
  d.walking_gait_summary,d.vo2max_context,d.quality_flags,d.data_sources,d.derived_extra,
  m.session_id,m.match_status,m.match_method
 from public.health_workouts w
 left join public.health_sync_config c on c.user_id = w.user_id
 left join public.health_workout_derived d on d.user_id = w.user_id and d.workout_key = w.workout_key and d.algorithm_version = c.algorithm_version
 left join public.health_workout_matches m on m.user_id = w.user_id and m.workout_key = w.workout_key
 where w.provenance_jsonb->>'connector' = 'chatgpt_health_native';

create view public.health_connector_workout_points with (security_invoker = true) as
 select l.user_id,l.workout_key,l.observation_id,l.association,l.quality_flags,
  o.metric_name,o.observed_at,o.end_at,o.value_numeric,o.unit,o.source,
  o.source_sample_id,o.aggregation_level,o.is_aggregated,o.provenance_jsonb
 from public.health_workout_observation_links l
 join public.health_metric_observations o on o.user_id=l.user_id and o.id=l.observation_id;
revoke all on public.health_connector_sync_status,public.health_connector_workout_summary,public.health_connector_workout_points from public,anon,authenticated;
grant select on public.health_connector_sync_status,public.health_connector_workout_summary,public.health_connector_workout_points to authenticated,service_role;

-- Existing Ledger owners get manual-mode defaults only; no credentials or source IDs are guessed.
insert into public.health_sync_config(user_id)
 select distinct user_id from public.sessions on conflict (user_id) do nothing;
commit;
