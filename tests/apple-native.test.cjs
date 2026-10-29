const test=require('node:test'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const owner='11111111-1111-1111-1111-111111111111',token='synthetic-native-token-00000000000000000000000000000';
function prepared(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-native-test-'));
 try{return JSON.parse(execFileSync('python3',['-c',`
import sys,json,gzip,sqlite3
from pathlib import Path
sys.path[:0]=['tools','tests']
from apple_health_test import XML
from apple_health.native import prepare
root=Path(sys.argv[1])/'source';root.mkdir();(root/'export.xml').write_text(XML)
(root/'workout-routes').mkdir();(root/'workout-routes/synthetic.gpx').write_text('<gpx><trk/></gpx>')
folder=Path(sys.argv[1])/'prepared';report=prepare(root,folder)
c=sqlite3.connect(folder/'staging.sqlite3')
print(json.dumps({'report':report,'archives':[json.loads(gzip.decompress(r[0])) for r in c.execute('select body from archive')],'projections':[json.loads(gzip.decompress(r[0])) for r in c.execute('select body from projections order by ordinal')]}))
`,directory],{cwd:path.join(__dirname,'..'),encoding:'utf8'}));}finally{fs.rmSync(directory,{recursive:true,force:true});}
}
async function setup(){const {createHandler}=await import('../supabase/functions/import-health/handler.mjs'),{hash}=await import('../supabase/functions/import-health/parser.mjs'),{HealthRepository}=await import('../supabase/functions/import-health/repository.mjs');
 const repo={batches:new Map(),raw:new Map(),projected:[],writes:0,
 async rateLimit(){this.writes++;return true},async findBatch(user,h){assert.equal(user,owner);return this.batches.get(h)},
 async archive(p,bytes){this.raw.set(p,bytes)},async register(row){const b={...row,id:'synthetic-'+this.batches.size};this.batches.set(row.payload_sha256,b);return b},
 async commit(id,user,rows){assert.equal(user,owner);const b=[...this.batches.values()].find(b=>b.id===id);b.processing_status='completed';b.counts=Object.fromEntries(['workouts','observations','events','series'].map(k=>[k,rows[k].length]));this.projected.push(rows);return {status:'completed',counts:b.counts}},
 async failed(id){[...this.batches.values()].find(b=>b.id===id).processing_status='retryable'},
 async request(url){assert.ok(url.includes('user_id=eq.'+owner));const m=url.match(/payload_sha256=in\.\(([^)]+)\)/);const rows=m[1].split(',').map(h=>this.batches.get(h)).filter(Boolean);return new Response(JSON.stringify(rows));}
 };
 repo.verifyNativeManifest=HealthRepository.prototype.verifyNativeManifest.bind(repo);repo.verifyNativeSource=HealthRepository.prototype.verifyNativeSource.bind(repo);
 const handler=createHandler({ownerId:owner,tokenHashes:[await hash(token)],repository:repo});
 return {repo,handler,hash,send:body=>handler(new Request('https://synthetic.invalid/import-health',{method:'POST',headers:{'Content-Type':'application/json','x-health-import-token':token},body:JSON.stringify(body)}))};
}
test('native archive must be complete before projection; all original files recover and source values retain fidelity',async()=>{
 const p=prepared(),{repo,send}=await setup();const manifest=p.archives.find(a=>a.data.nativeAppleArchive.kind==='manifest'),chunks=p.archives.filter(a=>a!==manifest);
 assert.equal((await send(p.projections[0])).status,503);assert.equal((await send(manifest)).status,503);
 for(const chunk of chunks)assert.equal((await send(chunk)).status,200);
 assert.equal((await send(manifest)).status,200);
 assert.equal((await send(p.projections[0])).status,200);
 const rows=repo.projected.at(-1);assert.equal(rows.observations.length,2);assert.ok(rows.observations.every(r=>r.is_aggregated===false));
 const metric=rows.observations.find(r=>r.metric_name==='HKQuantityTypeIdentifierFutureMetric');assert.equal(metric.value_numeric,7.25);assert.equal(metric.value_jsonb.native.children[0].attributes.value,'retained');
 assert.equal(rows.workouts[0].duration_sec,1800);assert.equal(rows.workouts[0].distance_m,5000);assert.equal(rows.workouts[0].route_present,true);
 assert.ok(rows.series.some(r=>r.metric_name.includes('HKQuantityTypeIdentifierDistanceWalkingRunning')&&r.is_aggregated));
 assert.ok(rows.events.some(r=>r.data_family==='appleHealthXML'&&r.summary_type==='FutureEvent'));
 assert.equal((await(await send(p.projections[0])).json()).replay,true);
});
test('native chunk tampering and unsafe manifest paths fail before writes',async()=>{
 const p=prepared(),{repo,send}=await setup(),chunk=structuredClone(p.archives.find(a=>a.data.nativeAppleArchive.kind==='chunk'));
 chunk.data.nativeAppleArchive.content_base64=Buffer.from('tampered').toString('base64');assert.equal((await send(chunk)).status,400);assert.equal(repo.writes,0);
 const manifest=structuredClone(p.archives.find(a=>a.data.nativeAppleArchive.kind==='manifest'));manifest.data.nativeAppleArchive.files[0].path='../outside';
 assert.equal((await send(manifest)).status,400);assert.equal(repo.writes,0);
});
