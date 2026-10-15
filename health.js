/* Read-only, account/project-scoped Health summaries. Never part of Ledger outbox/backups. */
(function(root){
 const COLUMNS='id,workout_key,activity_type,start_at,end_at,source_timestamp,duration_sec,distance_m,active_energy,energy_unit,hr_avg,hr_max,source';
 class LedgerHealth{
  constructor({cloud,storage=localStorage,changed=()=>{}}){Object.assign(this,{cloud,storage,changed});this.data={workouts:[],matches:[],lastAttempt:null,lastSuccess:null};this.message='';this.loadedOwner=null;this.lastRead=0;}
  owner(){return this.cloud.auth?this.cloud.config.supabaseUrl+'/'+this.cloud.auth.user.id:null;}
  get enabled(){return this.cloud.config.healthEnabled===true;}
  get visible(){return this.enabled&&this.owner()&&this.owner()===this.loadedOwner;}
  get workouts(){return this.visible?this.data.workouts:[];}
  get matches(){return this.visible?this.data.matches:[];}
  async pages(table,select,filter=''){
   let rows=[],after='';
   do{
    const page=await this.cloud.api(`${table}?select=${select}&order=id.asc&limit=200${filter}${after?'&id=gt.'+encodeURIComponent(after):''}`);
    if(!Array.isArray(page))throw Error('Invalid Health response');rows.push(...page);after=page.length===200?page.at(-1).id:'';
   }while(after);return rows;
  }
  async refresh(force=false){
   const owner=this.owner();
   if(!this.enabled||!owner){this.data={workouts:[],matches:[],lastAttempt:null,lastSuccess:null};this.loadedOwner=null;this.lastRead=0;return;}
   const key=this.cloud.config.storageKey+':health:'+owner;
   if(this.loadedOwner!==owner){
    this.loadedOwner=owner;this.lastRead=0;this.data={workouts:[],matches:[],lastAttempt:null,lastSuccess:null};
    try{const cache=JSON.parse(this.storage.getItem(key)||'null');if(cache?.version===1)this.data=cache.data;}catch{/* discard damaged derived cache */}
   }
   if(this.running||(!force&&Date.now()-this.lastRead<60000))return;
   this.running=true;this.message='Refreshing Apple Health…';this.changed();
   try{
    const [workouts,matches,attempts,successes]=await Promise.all([
     this.pages('health_workouts',COLUMNS,'&activity_type=in.(Running,Traditional%20Strength%20Training,Functional%20Strength%20Training,Strength%20Training)'),
     this.pages('health_workout_matches','workout_key,session_id,match_status,match_method,id'),
     this.cloud.api('health_import_batches?select=received_at,processing_status&order=received_at.desc&limit=1'),
     this.cloud.api('health_import_batches?select=processed_at&processing_status=eq.completed&order=processed_at.desc&limit=1')]);
    if(this.owner()!==owner)return;
    this.data={workouts,matches,lastAttempt:attempts[0]??null,lastSuccess:successes[0]?.processed_at??null};this.lastRead=Date.now();this.message='';
    try{this.storage.setItem(key,JSON.stringify({version:1,data:this.data}));}catch{this.message='Health summaries loaded; offline cache could not be saved.';}
   }catch{
    if(this.owner()===owner)this.message='Apple Health unavailable. Check importer setup or connection; cached summaries may be outdated.';
   }finally{this.running=false;this.changed();}
  }
  status(){
   if(!this.enabled)return 'Apple Health import is awaiting development setup.';
   if(!this.owner())return 'Sign in to view Apple Health workouts.';
   if(this.message)return this.message;
   if(!this.data.lastAttempt)return 'No exports received yet. Configure Health Auto Export before expecting workouts.';
   const pending=this.data.lastAttempt.processing_status!=='completed';
   if(!this.data.lastSuccess)return pending?'An export needs processing or review; no successful import yet.':'No successful import yet.';
   const stale=Date.now()-Date.parse(this.data.lastSuccess)>48*3600000;
   return `Last successful import: ${new Date(this.data.lastSuccess).toLocaleString()}.${stale?' Sync may be delayed (over 48 hours).':''}${pending?' Latest export needs processing or review.':''}`;
  }
 }
 const miles=w=>Number.isFinite(w.distance_m)?w.distance_m/1609.344:null;
 const pace=w=>miles(w)>0&&w.duration_sec>0?w.duration_sec/60/miles(w):null;
 const dateKey=w=>w.source_timestamp?.slice(0,10)||w.start_at.slice(0,10);
 function runningWeeks(workouts){
  const weeks=new Map();
  for(const w of workouts.filter(w=>w.activity_type==='Running')){
   const day=new Date(dateKey(w)+'T12:00:00Z');day.setUTCDate(day.getUTCDate()-((day.getUTCDay()+6)%7));const key=day.toISOString().slice(0,10);
   const week=weeks.get(key)||{week:key,runs:0,miles:0,seconds:0,paceMiles:0};week.runs++;
   const mi=miles(w);if(mi!==null&&mi>0){week.miles+=mi;if(w.duration_sec>0){week.seconds+=w.duration_sec;week.paceMiles+=mi;}}weeks.set(key,week);
  }
  const sorted=[...weeks.values()].sort((a,b)=>a.week.localeCompare(b.week));
  if(!sorted.length)return [];
  // Include rest weeks so a mileage chart does not hide gaps.
  const result=[];for(let day=new Date(sorted[0].week+'T12:00:00Z');day<=new Date(sorted.at(-1).week+'T12:00:00Z');day.setUTCDate(day.getUTCDate()+7)){
   const key=day.toISOString().slice(0,10),week=weeks.get(key)||{week:key,runs:0,miles:0,seconds:0,paceMiles:0};result.push({...week,pace:week.paceMiles?week.seconds/60/week.paceMiles:null});
  }return result;
 }
 const api={LedgerHealth,miles,pace,dateKey,runningWeeks};
 if(typeof module!=='undefined')module.exports=api;else root.Health=api;
})(typeof globalThis!=='undefined'?globalThis:this);
