import {canonical,hash} from '../import-health/parser.mjs';
export const VERSION='chatgpt-health-v1';
const SUMMARY_REVISION='summary-only-v1';
const B=new Set(['stepCount','distanceWalkingRunning','activeEnergyBurned','basalEnergyBurned','flightsClimbed']);
const GAIT=new Set(['walkingSpeed','walkingStepLength','walkingAsymmetryPercentage','walkingDoubleSupportPercentage']);
const OPTIONAL=new Set(['environmentalAudioExposure','headphoneAudioExposure']);
const names={13:'Cycling',37:'Running',50:'Traditional Strength Training',52:'Walking'};
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const iso=x=>new Date(x).toISOString();
const fail=s=>{throw Error(s);};
const excluded=p=>/whoop|oura/i.test(`${p.source_name??''} ${p.source_bundle_identifier??''}`);
const interval=p=>[p.start_time_ms,p.end_time_ms];
const overlap=(s,e,a,b)=>s===e?s>=a&&s<b:s<b&&e>a;
function cutoffTime(config){
 let value=Date.parse(config.cutoff_local_date+'T00:00:00Z');const target=value;
 for(let i=0;i<2;i++){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:config.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(value).map(p=>[p.type,p.value]));
  value+=target-Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);}
 return value;
}
function validatePoint(p,metric){
 if(!p||p.metric!==metric||typeof p.source_bundle_identifier!=='string'||!p.source_bundle_identifier||typeof p.source_name!=='string')fail('invalid_point_source');
 for(const prefix of ['start','end']){
  const ms=p[prefix+'_time_ms'],local=p[prefix+'_time_local'];
  if(!Number.isSafeInteger(ms)||ms<Date.UTC(2026,0,1)||ms>Date.UTC(2200,0,1)||typeof local!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(local)||Math.abs(Date.parse(local)-ms)>1||!Number.isFinite(Date.parse(local)))fail('invalid_point_time');
 }
 if(p.end_time_ms<p.start_time_ms)fail('invalid_point_interval');
}
function validateManifest(payload,m){
 if(!m||m.schema_version!==1||m.complete!==true||m.omitted!==0||m.timezone!=='America/Los_Angeles'||!m.record_counts||!m.units)fail('incomplete_extraction_manifest');
 const a=Date.parse(m.window_start),b=Date.parse(m.window_end);
 if(!finite(a)||!finite(b)||a<Date.parse('2026-09-01T07:00:00Z')||b<=a||b-a>8*86400000)fail('invalid_extraction_window');
 if(m.extraction_time_verified===true&&!Number.isFinite(Date.parse(m.extracted_at)))fail('invalid_extraction_version');
 const keys=new Set([...Object.keys(payload),...Object.keys(m.record_counts)]);
 for(const k of keys){if(!Array.isArray(payload[k])||!Number.isInteger(m.record_counts[k])||payload[k].length!==m.record_counts[k])fail('extraction_count_mismatch');}
 if(!payload.workout?.length||payload.workout.length>100||Object.values(payload).reduce((n,a)=>n+a.length,0)>10000)fail('batch_scope_limit');
 return {a,b};
}
function changed(old,fp,m){
 if(!old||old.record_fingerprint===fp)return;
 if(m.extraction_time_verified!==true||!old.extraction_time_verified||Date.parse(m.extracted_at)<=Date.parse(old.extracted_at))fail('correction_requires_newer_verified_extraction');
}
function association(p,workouts,c){
 const [s,e]=interval(p),hits=workouts.filter(w=>overlap(s,e,w.start,w.end));
 if(hits.length>1)return {reason:'ambiguous_workout'};
 if(hits.length===1)return {workout:hits[0],kind:s>=hits[0].start&&e<=hits[0].end?'within_workout':'overlaps_workout'};
 let candidates=[];
 if(p.metric==='heartRate'&&c.post_workout_hr_minutes>0)candidates=workouts.filter(w=>s>=w.end&&e<=w.end+c.post_workout_hr_minutes*60000).map(w=>({workout:w,kind:'post_workout_recovery'}));
 if(p.metric==='vo2Max')candidates=workouts.filter(w=>['Running','Walking'].includes(w.activity_type)&&s>=w.end-1800000&&e<=w.end+1800000).map(w=>({workout:w,kind:'near_workout_context'}));
 return candidates.length===1?candidates[0]:{reason:candidates.length?'ambiguous_workout':'outside_workout'};
}
const quantile=(sorted,p)=>{const x=(sorted.length-1)*p,i=Math.floor(x);return sorted[i]+(sorted[Math.min(i+1,sorted.length-1)]-sorted[i])*(x-i);};
function derive(w,points,c){
 const duration=w.duration_sec,elapsed=(w.end-w.start)/1000,distance=w.distance_m,energy=w.reported_workout_energy_kcal;
 const flags=[],sourcePolicy=c.source_policy,watch=new Set(sourcePolicy.workout_source_allowlist);
 const selected=sourcePolicy.selected_external_hr_source_bundle_identifier??null;
 const streams=new Map();
 for(const {point:p,kind} of points){
  if(p.metric!=='heartRate'||kind!=='within_workout'||!finite(p.value)||p.value<25||p.value>250||p.end_time_ms-p.start_time_ms>30000)continue;
  const key=JSON.stringify([p.source_bundle_identifier,p.source_name]);
  if(!streams.has(key))streams.set(key,[]);streams.get(key).push(p);
 }
 const candidates=[...streams].filter(([,a])=>selected?a[0].source_bundle_identifier===selected:watch.has(a[0].source_bundle_identifier));
 candidates.sort((a,b)=>b[1].length-a[1].length||a[0].localeCompare(b[0]));
 const primary=candidates[0];if(candidates.length>1)flags.push('multiple_primary_candidates_chose_most_samples');
 const byTime=new Map();let conflicts=0;
 for(const p of primary?.[1]??[]){if(byTime.has(p.start_time_ms)&&byTime.get(p.start_time_ms)!==null&&byTime.get(p.start_time_ms).value!==p.value){conflicts++;byTime.set(p.start_time_ms,null);}else if(!byTime.has(p.start_time_ms))byTime.set(p.start_time_ms,p);}
 const hr=[...byTime.values()].filter(Boolean).sort((a,b)=>a.start_time_ms-b.start_time_ms),values=hr.map(p=>p.value).sort((a,b)=>a-b);
 const gap=30;let covered=0,weighted=0;
 for(let i=0;i<hr.length;i++){const seconds=Math.max(0,Math.min(gap,((hr[i+1]?.start_time_ms??w.end)-hr[i].start_time_ms)/1000,(w.end-hr[i].start_time_ms)/1000));covered+=seconds;weighted+=seconds*hr[i].value;}
 const coverage=elapsed>0?Math.min(1,covered/elapsed):0;
 if(!hr.length)flags.push('no_valid_primary_hr');else if(coverage<0.8)flags.push('sparse_hr_coverage');
 if(conflicts)flags.push('conflicting_same_source_timestamps_excluded');
 if(elapsed+1<duration)flags.push('duration_exceeds_elapsed');
 const out={workout_key:w.workout_key,algorithm_version:c.algorithm_version,source_policy:sourcePolicy.version,sample_count:hr.length,
  coverage_ratio:hr.length?coverage:null,hr_avg_bpm:covered>0?weighted/covered:null,hr_min_bpm:values.length?values[0]:null,hr_max_bpm:values.length?values.at(-1):null,
  hr_p50_bpm:values.length?quantile(values,.5):null,hr_p95_bpm:values.length?quantile(values,.95):null,hr_zone_seconds:null,
  elapsed_sec:elapsed,duration_sec:duration,estimated_paused_sec:Math.max(0,elapsed-duration),distance_m:distance,
  pace_moving_sec_per_km:distance>0&&duration>0?duration/(distance/1000):null,pace_elapsed_sec_per_km:distance>0&&elapsed>0?elapsed/(distance/1000):null,
  speed_mean_mps:distance!==null&&duration>0?distance/duration:null,energy_per_min_kcal:energy!==null&&duration>0?energy/(duration/60):null,
  heart_rate_recovery_1min_bpm:null,heart_rate_recovery_2min_bpm:null,walking_gait_summary:null,vo2max_context:null,quality_flags:flags,
  data_sources:{hr_primary:primary?JSON.parse(primary[0]):null,hr_method:'left_hold_time_weighted',hr_gap_cap_seconds:gap,hr_coverage_denominator:'elapsed_workout_seconds',valid_hr_bpm:[25,250],recovery_tolerance_seconds:15},
  derived_extra:{algorithm_definition:VERSION,hr_quantiles:'linear_interpolation',hr_zones:'not_configured',recovery_offsets_seconds:{}}};
 const last=hr.at(-1);
 if(last&&w.end-last.start_time_ms<=30000){
  const recovery=points.filter(({point:p,kind})=>kind==='post_workout_recovery'&&p.metric==='heartRate'&&p.source_bundle_identifier===last.source_bundle_identifier&&p.source_name===last.source_name&&finite(p.value)&&p.value>=25&&p.value<=250&&p.end_time_ms-p.start_time_ms<=30000).map(x=>x.point);
  for(const minute of [1,2]){const target=w.end+minute*60000,candidate=recovery.filter(p=>Math.abs(p.start_time_ms-target)<=15000).sort((a,b)=>Math.abs(a.start_time_ms-target)-Math.abs(b.start_time_ms-target)||a.start_time_ms-b.start_time_ms)[0];
   if(candidate){out[`heart_rate_recovery_${minute}min_bpm`]=last.value-candidate.value;out.derived_extra.recovery_offsets_seconds[minute]=(candidate.start_time_ms-w.end)/1000;}}
 }
 if(out.heart_rate_recovery_1min_bpm===null)flags.push('recovery_1min_unavailable');
 if(out.heart_rate_recovery_2min_bpm===null)flags.push('recovery_2min_unavailable');
 const vo2=points.filter(x=>x.point.metric==='vo2Max').sort((a,b)=>Math.abs(a.point.start_time_ms-w.end)-Math.abs(b.point.start_time_ms-w.end))[0];
 if(vo2)out.vo2max_context={value:vo2.point.value,unit:vo2.unit,observed_at:iso(vo2.point.start_time_ms),source:vo2.point.source_name,interpretation:'contextual_estimate'};
 if(w.activity_type==='Walking'){
  const gait={};for(const metric of GAIT){const samples=points.filter(x=>x.point.metric===metric&&x.kind==='within_workout');if(!samples.length)continue;
   const units=new Set(samples.map(x=>x.unit)),sources=new Set(samples.map(x=>JSON.stringify([x.point.source_bundle_identifier,x.point.source_name])));
   if(units.size!==1||sources.size!==1){flags.push('gait_multiple_sources_or_units_not_combined');continue;}
   const v=samples.map(x=>x.point.value);gait[metric]={mean:v.reduce((a,b)=>a+b,0)/v.length,min:Math.min(...v),max:Math.max(...v),count:v.length,unit:samples[0].unit,source:JSON.parse([...sources][0])};}
  if(Object.keys(gait).length)out.walking_gait_summary=gait;
 }
 return out;
}
export async function projectConnector(payload,manifest,config,owner,context={workouts:[]}){
 const {a,b}=validateManifest(payload,manifest);
 if(config.algorithm_version!==VERSION)fail('unsupported_algorithm_version');
 const cutoff=cutoffTime(config);
 const allow=new Set(config.source_policy.workout_source_allowlist),enabled=new Set(config.enabled_metric_identifiers);
 if(!allow.size)fail('verified_workout_source_required');
 const counts={workouts_seen:payload.workout.length,observations_seen:0,excluded:{}};
 const reject=reason=>{counts.excluded[reason]=(counts.excluded[reason]??0)+1;};
 const workouts=new Map();
 for(const old of context.workouts??[]){if(old.provenance_jsonb?.connector!=='chatgpt_health_native')continue;
  workouts.set(old.workout_key,{...old,start:Date.parse(old.start_at),end:Date.parse(old.end_at)});}
 const previous=new Map(workouts),incoming=new Map();
 for(let i=0;i<payload.workout.length;i++){
  const p=payload.workout[i];validatePoint(p,'workout');
  if(p.kind!=='workout'||excluded(p)||!allow.has(p.source_bundle_identifier)||p.start_time_ms<cutoff||p.start_time_ms<a||p.start_time_ms>=b)fail('workout_scope_or_source');
  if(!finite(p.duration_sec)||p.duration_sec<0||p.end_time_ms<=p.start_time_ms||(p.total_energy_kcal!=null&&(!finite(p.total_energy_kcal)||p.total_energy_kcal<0))||(p.total_distance_m!=null&&(!finite(p.total_distance_m)||p.total_distance_m<0)))fail('invalid_workout_values');
  const activity=p.activity?.match(/^HKWorkoutActivityType\(rawValue:\s*(\d+)\)$/)?.[1];if(!activity)fail('invalid_workout_activity');
  const key=await hash(canonical([owner,p.source_bundle_identifier,p.activity,p.start_time_ms]));
  const fp=await hash(canonical(p));if(incoming.has(key)&&incoming.get(key).provenance_jsonb.record_fingerprint!==fp)fail('ambiguous_workout_identity');
  changed(workouts.get(key)?.provenance_jsonb,fp,manifest);
  const w={workout_key:key,external_id:null,activity_type:names[activity]??p.activity,start: p.start_time_ms,end:p.end_time_ms,start_at:iso(p.start_time_ms),end_at:iso(p.end_time_ms),
   source_timestamp:p.start_time_local,source_timezone:p.start_time_local.match(/(Z|[+-]\d\d:\d\d)$/)[0],duration_sec:p.duration_sec,distance_m:p.total_distance_m??null,
   distance_original:p.total_distance_m??null,distance_unit:p.total_distance_m==null?null:'m',active_energy:null,reported_workout_energy_kcal:p.total_energy_kcal??null,energy_unit:'kcal',hr_avg:null,hr_max:null,
   source:p.source_name,route_present:false,raw_json_path:`/workout/${i}`,provenance_jsonb:{connector:'chatgpt_health_native',adapter_version:VERSION,identity_method:'source_activity_start',
    source_bundle_identifier:p.source_bundle_identifier,raw_activity:p.activity,raw_workout:p,record_fingerprint:fp,extracted_at:manifest.extracted_at??null,extraction_time_verified:manifest.extraction_time_verified===true,route_availability:'not_exposed_by_connector'}};
  incoming.set(key,w);workouts.set(key,w);
 }
 // Deduplicate exact raw points in memory; never build observation database rows.
 const all=[...workouts.values()],byWorkout=new Map([...incoming.keys()].map(k=>[k,new Map()]));
 for(const [metric,rows]of Object.entries(payload)){
  if(metric==='workout')continue;
  for(const p of rows){
   counts.observations_seen++;validatePoint(p,metric);
   if(p.kind!=='quantity'||!finite(p.value))fail('invalid_quantity_value');
   if(excluded(p)){reject('excluded_source');continue;}
   if(!enabled.has(metric)){reject('metric_not_enabled');continue;}
   const unit=manifest.units[metric];if(typeof unit!=='string'||!unit.trim()||unit.length>100)fail('missing_metric_unit');
   if(metric==='heartRate'&&!['count/min','bpm'].includes(unit))fail('unsupported_heart_rate_unit');
   const coarse=B.has(metric)||(manifest.aggregation?.[metric]?.bucket_minutes??0)>=60;
   if(coarse){reject('coarse_not_summarized');continue;}
   if(OPTIONAL.has(metric)&&!config.include_optional_environment){reject('optional_environment_disabled');continue;}
   const assoc=association(p,all,config);
   if(!assoc.workout){reject(assoc.reason);continue;}
   if(GAIT.has(metric)&&assoc.workout.activity_type!=='Walking'){reject('gait_outside_walking');continue;}
   const samples=byWorkout.get(assoc.workout.workout_key);
   if(samples)samples.set(canonical([p,unit]),{point:p,kind:assoc.kind,unit});
  }
 }
 // Refresh only supplied workouts, using only the supplied raw points. A neighboring
 // context workout must never lose its summary merely because its samples were not fetched.
 const derived=[];
 for(const w of incoming.values()){
  const points=[...byWorkout.get(w.workout_key).values()],d=derive(w,points,config);
  const inputHash=await hash(canonical(points.map(p=>canonical(p)).sort()));
  changed(previous.get(w.workout_key)?.provenance_jsonb.summary_input,inputHash,manifest);
  w.provenance_jsonb.summary_input={record_fingerprint:inputHash,extracted_at:manifest.extracted_at??null,
   extraction_time_verified:manifest.extraction_time_verified===true,raw_payload_sha256:manifest.payload_sha256??null};
  d.derived_extra={...d.derived_extra,projection_mode:'summary_only',summary_revision:SUMMARY_REVISION,
   input_sha256:inputHash,raw_payload_sha256:manifest.payload_sha256??null};
  if(manifest.unit_origin&&manifest.unit_origin!=='connector_summary')d.quality_flags.push('units_from_reference_manifest');
  derived.push(d);
 }
 return {projection_mode:'summary_only',workouts:[...incoming.values()].map(({start,end,...w})=>w),
  observations:[],links:[],superseded:[],derived,recompute_keys:[...incoming.keys()],
  events:[],series:[],warnings:[],unknown_families:[],counts};
}
