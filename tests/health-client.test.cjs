const test=require('node:test'),assert=require('node:assert/strict');
const {LedgerHealth,runningWeeks}=require('../health.js');
const storage=()=>{const data=new Map();return {getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)}};
const auth=id=>({user:{id}});
test('Health reads paginate; cached summaries are isolated by account/project and hidden on signout',async()=>{
 const paths=[],store=storage(),cloud={config:{healthEnabled:true,supabaseUrl:'https://synthetic.supabase.co',storageKey:'test'},auth:auth('one'),async api(path){paths.push(path);
 if(path.startsWith('health_workouts'))return path.includes('id=gt.')?[{id:'201',workout_key:'last'}]:Array.from({length:200},(_,i)=>({id:String(i),workout_key:String(i)}));
 if(path.startsWith('health_workout_matches'))return [];
 return path.includes('processing_status=eq.completed')?[{processed_at:'2026-10-10T17:00:00Z'}]:[{received_at:'2026-10-10T17:00:00Z',processing_status:'completed'}];}};
 const health=new LedgerHealth({cloud,storage:store});await health.refresh();assert.equal(health.workouts.length,201);assert.ok(paths.every(p=>!p.includes('route')&&!p.includes('value_jsonb')&&!p.includes('health_events')));
 cloud.auth=null;assert.equal(health.workouts.length,0);await health.refresh();assert.equal(health.loadedOwner,null);
 cloud.auth=auth('two');cloud.api=async()=>{throw Error('offline')};await health.refresh();assert.equal(health.workouts.length,0);
 cloud.auth=auth('one');await health.refresh();assert.equal(health.workouts.length,201);assert.match(health.status(),/outdated/);
 cloud.config.supabaseUrl='https://different.supabase.co';await health.refresh();assert.equal(health.workouts.length,0);
});
test('an inflight Health request cannot reveal the previous account after signout',async()=>{
 let release;const gate=new Promise(r=>release=r),cloud={config:{healthEnabled:true,supabaseUrl:'synthetic',storageKey:'test'},auth:auth('one'),async api(){await gate;return []}};
 const health=new LedgerHealth({cloud,storage:storage()});const pending=health.refresh();cloud.auth=null;release();await pending;assert.equal(health.workouts.length,0);
});
test('running weeks use exporter calendar dates, include rest weeks, and exclude legacy/strength data',()=>{
 const workouts=[{activity_type:'Running',source_timestamp:'2026-10-04 23:30:00 -0700',start_at:'2026-10-05T06:30:00Z',distance_m:1609.344,duration_sec:600},
 {activity_type:'Running',source_timestamp:'2026-10-19 09:30:00 -0700',distance_m:3218.688,duration_sec:1200},{activity_type:'Strength Training',distance_m:99999}];
 const result=runningWeeks(workouts);assert.equal(result[0].week,'2026-09-28');assert.equal(result[0].pace,10);assert.equal(result[1].runs,0);assert.equal(result.at(-1).miles,2);
});
