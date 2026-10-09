const test=require('node:test'),assert=require('node:assert/strict');
const Cloud=require('../cloud.js'),L=require('../ledger-core.js');
const config={storageKey:'test',supabaseUrl:'https://development.supabase.co',supabaseKey:'sb_publishable_test'};
const record=(id='custom')=>({id,name:'Custom exercise',pattern:'Other',group:'Other',anchor:false,custom:true});
test('default fetch keeps the browser Window receiver through sign-in and sync',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');
 const context=vm.createContext({Ledger:L,AbortController,setTimeout,clearTimeout});
 vm.runInContext(`
   const calls=[];
   const localStorage={getItem:()=>null,setItem:()=>{}};
   async function fetch(url){
     if(this!==globalThis)throw new TypeError('can only call Window.fetch on instances of Window');
     calls.push(url);
     const data=url.includes('/auth/v1/token')?{access_token:'test',refresh_token:'test',expires_in:3600,user:{id:'test-owner'}}:
       url.includes('ledger_manifest')?Object.fromEntries(Ledger.tables.map(t=>[t,'0:0'])):[];
     return {ok:true,json:async()=>data};
   }
 `,context);
 vm.runInContext(fs.readFileSync(require.resolve('../cloud.js'),'utf8'),context);
 await vm.runInContext(`(async()=>{
   const db={exercises:[],routines:[],sessions:[],cardio:[],body:[]};
   const client=new LedgerCloud({config:{storageKey:'test',supabaseUrl:'https://test.supabase.co',supabaseKey:'sb_publishable_test'},getDB:()=>db,persist:()=>{}});
   client.schedule=()=>{};
   await client.signIn('test@example.com','test-password');
   if(calls.length!==7||client.message!=='All records confirmed by Supabase.')throw new Error('Sign-in/sync did not complete');
 })()`,context);
});
function setup(){
 const db={exercises:[record()],routines:[],sessions:[],cardio:[],body:[],active:null};
 const store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};
 const server=Object.fromEntries(L.tables.map(t=>[t,new Map()]));let fail=false,lost=false,reads=0,writes=0,hook;
 const fetcher=async(url,opts)=>{
   if(fail)throw Error('Offline');
   const u=new URL(url),body=opts.body&&JSON.parse(opts.body);let result;
   if(u.pathname.endsWith('ledger_manifest'))result=Object.fromEntries(L.tables.map(t=>[t,server[t].size+':'+[...server[t].values()].reduce((n,r)=>n+r.version,0)]));
   else if(u.pathname.endsWith('ledger_write')){
     writes++;const {p_table:t,p_id:id,p_data:data,p_version:v}=body,old=server[t].get(id);
     if(!old||L.canonical(old.data)===L.canonical(data)||old.version===v){
       const row={id,data:L.clone(data),version:old?old.version+(L.canonical(old.data)!==L.canonical(data)?1:0):1};server[t].set(id,row);result={ok:true,row};
       if(hook){hook();hook=null;}if(lost){lost=false;throw Error('Response lost after commit');}
     }else result={ok:false,conflict:true,row:old};
   }else{reads++;const t=u.pathname.split('/').at(-1),filter=u.searchParams.get('id');
     const after=filter?JSON.parse(filter.slice(3)):'';
     result=[...server[t].values()].filter(r=>!after||r.id>after).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).slice(0,200).map(L.clone);}
   return{ok:true,json:async()=>L.clone(result)};
 };
 const cloud=new Cloud({config,getDB:()=>db,persist:()=>{},storage,fetcher});
 cloud.auth={access_token:'test',user:{id:'owner'},expires_at:Date.now()/1000+3600};cloud.schedule=()=>{};
 return{db,cloud,server,setFail:v=>fail=v,setLost:v=>lost=v,setHook:v=>hook=v,reads:()=>reads,writes:()=>writes};
}
test('offline failure stays pending; retry and lost acknowledgements do not duplicate records',async()=>{
 const f=setup();f.setFail(true);await f.cloud.sync();assert.equal(f.cloud.summary().pending,1);
 f.setFail(false);f.setLost(true);await f.cloud.sync();assert.equal(f.cloud.summary().failed,1);assert.equal(f.server.exercises.size,1);
 await f.cloud.sync();assert.equal(f.cloud.summary().synced,1);assert.equal(f.server.exercises.size,1);assert.equal(f.server.exercises.get('custom').version,1);
});
test('remote newer data loads, unchanged history is not fetched, stale local conflict preserves both',async()=>{
 const f=setup();await f.cloud.sync();await f.cloud.sync();const reads=f.reads();await f.cloud.sync();assert.equal(f.reads(),reads);
 const remote=f.server.exercises.get('custom');remote.version++;remote.data.name='Changed elsewhere';
 await f.cloud.sync();assert.equal(f.db.exercises[0].name,'Changed elsewhere');
 f.db.exercises[0].name='Offline edit';remote.version++;remote.data.name='New remote edit';
 await f.cloud.sync();assert.equal(f.cloud.summary().conflict,1);assert.equal(f.db.exercises[0].name,'Offline edit');assert.equal(remote.data.name,'New remote edit');
 f.cloud.resolve('exercises','custom','local');await f.cloud.sync();assert.equal(f.server.exercises.get('custom').data.name,'Offline edit');
});
test('edits during an in-flight write remain pending instead of falsely acknowledged',async()=>{
 const f=setup();f.setHook(()=>{f.db.exercises[0].name='Changed while saving';});
 await f.cloud.sync();assert.equal(f.cloud.summary().pending,1);await f.cloud.sync();assert.equal(f.cloud.summary().synced,1);
 assert.equal(f.server.exercises.get('custom').data.name,'Changed while saving');
});
test('fresh cache restores exercise IDs and routines including split-specific IDs',async()=>{
 const f=setup();f.db.routines=[{id:'ppl-a',split:'Push',blocks:[{exId:'custom'}]},{id:'ppl-a',split:'Pull',blocks:[]}];
 await f.cloud.sync();f.db.exercises=[];f.db.routines=[];delete f.db.cloud;await f.cloud.sync();
 assert.equal(f.db.exercises[0].id,'custom');assert.equal(f.db.routines.length,2);
});
test('cache cannot sync into another user account or project',async()=>{
 const f=setup();await f.cloud.sync();f.cloud.auth.user.id='other';const writes=f.writes();await f.cloud.sync();assert.equal(f.writes(),writes);assert.match(f.cloud.message,/another account/);
});
test('history pagination loads every remote record beyond server page size',async()=>{
 const f=setup();f.db.exercises=[];
 for(let i=0;i<451;i++){const data=record('ex_'+String(i).padStart(4,'0'));f.server.exercises.set(data.id,{id:data.id,data,version:1});}
 await f.cloud.sync();assert.equal(f.db.exercises.length,451);assert.equal(f.cloud.summary().synced,451);
 assert.equal(f.reads(),7); // three exercise pages and four empty tables
});
test('legacy metadata-only conflicts clear after fresh read; changed values stay protected',async()=>{
 const f=setup(),local=f.db.exercises[0];
 const remote={id:local.id,version:1,data:{...L.clone(local),_source:{sheet:'exercises'}}};
 f.server.exercises.set(local.id,remote);
 f.cloud.conflict('exercises',local.id,remote);
 f.cloud.state().manifest.exercises='1:1';
 await f.cloud.sync();
 assert.equal(f.cloud.summary().conflict,0);assert.equal(f.cloud.summary().synced,1);assert.equal(f.writes(),0);
 assert.deepEqual(f.db.exercises[0]._source,{sheet:'exercises'});
 const g=setup();g.server.exercises.set('custom',{id:'custom',version:1,data:{...record(),name:'Different'}});
 await g.cloud.sync();assert.equal(g.cloud.summary().conflict,1);assert.equal(g.db.exercises[0].name,'Custom exercise');
 // Once acknowledged, a removed metadata field is an edit, not a legacy cache.
 delete f.db.exercises[0]._source;remote.version=2;
 await f.cloud.sync();assert.equal(f.cloud.summary().conflict,1);
});
