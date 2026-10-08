const test=require('node:test'),assert=require('node:assert/strict');
const L=require('../ledger-core.js');
const set=(id,w,r,warmup=false)=>({id,w,r,rpe:8,warmup});
const session=(id,date,sets,status='completed')=>({id,date,status,type:'Push',entries:[{exId:'bench',sets}]});
const empty=()=>({exercises:[{id:'bench',name:'Bench'}],routines:[],sessions:[],cardio:[],body:[],active:null});
test('all-time PR differs from previous-session improvement; warmups and skipped excluded',()=>{
 const sessions=[session('first','2026-01-01',[set('s1',100,10)]),session('last','2026-02-01',[set('s2',80,8),set('s3',70,10),set('s4',200,2,true)]),session('skip','2026-03-01',[set('s5',500,5)],'skipped')];
 assert.deepEqual(L.previous(sessions,'bench').sets.map(s=>s.w),[80,70]);
 const record=L.records(sessions,'bench');assert.equal(record.weight,100);assert.equal(record.e1rm,133.3);
 assert.deepEqual(L.pr(set('s6',90,10),record),{weight:false,e1rm:false});
 assert.deepEqual(L.pr(set('s7',105,3),record),{weight:true,e1rm:false});
 assert.deepEqual(L.pr(set('s8',100,11),record),{weight:false,e1rm:true});
 assert.deepEqual(L.pr(set('s9',200,10,true),record),{weight:false,e1rm:false});
});
test('same-day ordering and multiple exercise entries preserve every prior working set',()=>{
 const a=session('a','2026-01-01',[set('a1',60,10)]);a.endedAt=100;
 const b=session('b','2026-01-01',[set('b1',70,10)]);b.endedAt=200;b.entries.push({exId:'bench',sets:[set('b2',65,10)]});
 assert.equal(L.previous([b,a],'bench').sets.length,2);
 assert.equal(L.history([b,a],'bench').length,2);
});
test('merge unions stable set IDs, preserves active/routine splits, reports conflicting facts',()=>{
 const a=empty(),b=empty();a.sessions=[session('a','2026-01-01',[set('s1',60,10)])];
 b.sessions=[session('a','2026-01-01',[set('s1',60,10),set('s2',60,8)])];
 b.routines=[{id:'ppl-a',split:'Push',blocks:[]},{id:'ppl-a',split:'Pull',blocks:[]}];
 b.active=session('draft','2026-01-02',[set('draft1',70,8)]);
 const merged=L.merge(a,b);assert.equal(merged.conflicts.length,0);assert.equal(merged.issues.length,0);
 assert.equal(merged.db.sessions[0].entries[0].sets.length,2);assert.equal(merged.db.routines.length,2);assert.equal(merged.db.active.id,'draft');
 assert.equal(L.merge(merged.db,b).db.sessions[0].entries[0].sets.length,2);
 b.sessions[0].entries[0].sets[0].w=999;assert.equal(L.merge(a,b).conflicts.length,1);assert.equal(a.sessions[0].entries[0].sets[0].w,60);
});
test('validate catches orphan exercises and duplicate set IDs across sessions',()=>{
 const a=empty();a.sessions=[session('a','2026-01-01',[set('s1',60,10)]),session('b','2026-01-02',[set('s1',60,10)])];
 assert.match(L.validate(a).join(' '),/duplicate set/);a.exercises=[];assert.match(L.validate(a).join(' '),/missing exercise/);
});
