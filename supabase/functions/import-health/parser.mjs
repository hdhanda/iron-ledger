// Pure projections of vendor output. The exact request is archived independently.
export const FAMILIES = ['metrics','workouts','symptoms','ecg','heartRateNotifications','stateOfMind','cycleTracking','medications'];
export const canonical = x => JSON.stringify(x && typeof x === 'object' ? Array.isArray(x) ? x.map(v=>JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])) : x);
export async function hash(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b=>b.toString(16).padStart(2,'0')).join('');
}
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const num = x => typeof x === 'number' && Number.isFinite(x) ? x : null;
const qty = x => num(object(x) ? x.qty : x);
const text = x => typeof x === 'string' ? x : null;
export function instant(value) {
  if (typeof value !== 'string') return null;
  // Require an explicit offset: never interpret exporter dates in the server timezone.
  const iso = value.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?) ([+-]\d\d)(\d\d)$/, '$1T$2$3:$4');
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(iso)) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= Date.UTC(1900,0,1) && t < Date.UTC(2200,0,1) ? new Date(t).toISOString() : null;
}
const dateOf = p => p.date ?? p.start ?? p.startDate ?? (object(p.timestamp) ? p.timestamp.start : p.timestamp);
const endOf = p => p.end ?? p.endDate ?? (object(p.timestamp) ? p.timestamp.end : null);
const offsetOf = s => typeof s === 'string' ? s.match(/(?:[+-]\d\d:?\d\d|Z)$/)?.[0] ?? null : null;
// Keep queryable event fields while moving long waveforms/attachments to the archive.
function compactEvent(value){
  if(Array.isArray(value))return value.length>64?{archived:true,item_count:value.length}:value.map(compactEvent);
  if(object(value))return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,compactEvent(v)]));
  return value;
}
const pointer = s => String(s).replace(/~/g,'~0').replace(/\//g,'~1');
export function validateEnvelope(payload) {
  if (!object(payload) || !object(payload.data)) throw new Error('invalid_envelope');
  const keys = Object.keys(payload.data);
  if (!keys.length || keys.length > 32) throw new Error('invalid_families');
  for (const family of FAMILIES) if (family in payload.data && !Array.isArray(payload.data[family])) throw new Error('invalid_family_shape');
  return {families: keys.filter(k=>FAMILIES.includes(k)), unknown: keys.filter(k=>!FAMILIES.includes(k))};
}
export function checkComplexity(value, {maxDepth=32,maxNodes=150000}={}) {
  const queue=[[value,0]];let nodes=0;
  while(queue.length){const [v,depth]=queue.pop();if(++nodes>maxNodes||depth>maxDepth)throw new Error('payload_complexity');
    if(v && typeof v==='object') for(const item of Object.values(v)) queue.push([item,depth+1]);}
}
export async function project(payload, context={}) {
  const envelope=validateEnvelope(payload), out={workouts:[],observations:[],events:[],series:[],unknown_families:envelope.unknown,warnings:[]};
  const aggregation=context.aggregation ?? null;
  const observed = (point, metric, units, path, multi=false) => ({metric_name:metric, observed_at:instant(dateOf(point)), end_at:instant(endOf(point)),
    source_timestamp:text(dateOf(point)), source_timezone:offsetOf(dateOf(point)), value_numeric:num(point.qty)??num(point.Avg), unit:text(point.units)??units,
    source:text(point.source), source_sample_id:text(point.id), aggregation_level:aggregation,
    is_aggregated:multi || ['Min','Avg','Max'].some(k=>k in point) || (!!aggregation && !/^(none|raw|off)$/i.test(aggregation)) ? true : null,
    value_jsonb:point, raw_json_path:path});
  const fingerprint = async (scope,row) => hash(canonical([scope,row.source_sample_id ? [row.source,row.source_sample_id] : [row.observed_at,row.end_at,row.source,row.unit,row.aggregation_level,row.is_aggregated,row.value_jsonb]]));
  for (let m=0;m<(payload.data.metrics||[]).length;m++) {
    const metric=payload.data.metrics[m];
    if(!object(metric)||!text(metric.name)||!Array.isArray(metric.data))throw new Error('invalid_metric');
    for(let p=0;p<metric.data.length;p++){
      const point=metric.data[p];if(!object(point))throw new Error('invalid_observation');
      const row=observed(point,metric.name,text(metric.units),`/data/metrics/${m}/data/${p}`,(payload.data.metrics.length>1));
      row.provenance_jsonb={metric:Object.fromEntries(Object.entries(metric).filter(([key])=>key!=='data')),automation_id:context.automationId??null};
      row.fingerprint=await fingerprint(metric.name,row);out.observations.push(row);
    }
  }
  for(let w=0;w<(payload.data.workouts||[]).length;w++){
    const workout=payload.data.workouts[w];if(!object(workout))throw new Error('invalid_workout');
    const start=instant(workout.start),end=instant(workout.end);
    if(!start||!end||end<start||!text(workout.name))throw new Error('invalid_workout_timing');
    const externalId=text(workout.id), key=externalId ? await hash(canonical(['workout',externalId])) : await hash(canonical(['workout',workout.name,workout.start,workout.end,workout.source??null]));
    const distance=qty(workout.distance), unit=text(workout.distance?.units);
    const distanceM=distance===null?null:distance*({mi:1609.344,km:1000,m:1}[unit]??NaN);
    out.workouts.push({workout_key:key,external_id:externalId,activity_type:workout.name,start_at:start,end_at:end,
      source_timestamp:workout.start,source_timezone:offsetOf(workout.start),duration_sec:qty(workout.duration)??(Date.parse(end)-Date.parse(start))/1000,
      distance_m:Number.isFinite(distanceM)?distanceM:null,distance_original:distance,distance_unit:unit,
      active_energy:qty(workout.activeEnergyBurned),energy_unit:text(workout.activeEnergyBurned?.units),
      hr_avg:qty(workout.avgHeartRate)??qty(workout.heartRate?.avg),hr_max:qty(workout.maxHeartRate)??qty(workout.heartRate?.max),
      source:text(workout.source),route_present:Array.isArray(workout.route)&&workout.route.length>0,
      raw_json_path:`/data/workouts/${w}`,provenance_jsonb:{export_version:context.exportVersion??null,aggregation,identity:externalId?'vendor_id':'fallback_start_end'}});
    // Discover all timestamped arrays recursively; GPS stays exclusively in the raw archive.
    async function walk(node,path,metricPath){
      if(Array.isArray(node)){
        for(let i=0;i<node.length;i++){
          const point=node[i];
          if(object(point)&&dateOf(point)){
            const row=observed(point,metricPath,text(point.units),`${path}/${i}`);
            row.workout_key=key;row.fingerprint=await fingerprint([key,metricPath],row);out.series.push(row);
          }else if(object(point))await walk(point,`${path}/${i}`,metricPath);
        }
      }else if(object(node))for(const [name,value]of Object.entries(node)){
        if(name==='route')continue;
        if(value&&typeof value==='object')await walk(value,`${path}/${pointer(name)}`,metricPath?`${metricPath}.${name}`:name);
      }
    }
    await walk(workout,`/data/workouts/${w}`,'');
  }
  for(const family of envelope.families.filter(f=>!['metrics','workouts'].includes(f))){
    for(let i=0;i<payload.data[family].length;i++){
      const event=payload.data[family][i];if(!object(event))throw new Error('invalid_event');
      // Complex content remains losslessly in Storage; this row is a small lookup index.
      out.events.push({data_family:family,source_event_id:text(event.id),event_fingerprint:await hash(canonical([family,event.id??event])),
        start_at:instant(dateOf(event)),end_at:instant(endOf(event)),source_timestamp:text(dateOf(event)),source_timezone:offsetOf(dateOf(event)),
        summary_type:text(event.type)??text(event.name)??text(event.classification)??family,
        summary_jsonb:compactEvent(event),raw_json_path:`/data/${pointer(family)}/${i}`});
    }
  }
  for(const name of ['workouts','observations','events','series'])out[name]=[...new Map(out[name].map(r=>[r.fingerprint??r.workout_key??r.event_fingerprint,r])).values()];
  if(out.observations.some(r=>!r.observed_at)||out.series.some(r=>!r.observed_at))out.warnings.push('unparsed_timestamps');
  if(Object.values(out).filter(Array.isArray).reduce((n,a)=>n+a.length,0)>20000)throw new Error('projection_limit');
  return out;
}
