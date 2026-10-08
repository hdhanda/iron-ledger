/* Supabase Auth + PostgREST only: no backend, SDK, or database secrets. */
(function(root){
  const L=typeof module!=='undefined'?require('./ledger-core.js'):root.Ledger;
  class LedgerCloud {
    constructor({config,getDB,persist,changed=()=>{},isSeed=()=>false,storage=localStorage,fetcher=fetch}){
      Object.assign(this,{config,getDB,persist,changed,isSeed,storage,fetcher});
      this.authKey=config.storageKey+':auth';this.message='';this.busy=false;this.backoff=5000;
      try{this.auth=JSON.parse(storage.getItem(this.authKey)||'null')}catch{this.auth=null;}
    }
    get configured(){return /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(this.config.supabaseUrl)&&this.config.supabaseKey.startsWith('sb_publishable_');}
    state(){const db=this.getDB();db.cloud||={owner:null,meta:{},manifest:{}};return db.cloud;}
    meta(table,id){const state=this.state();state.meta[table]||={};return state.meta[table][id];}
    acknowledge(table,row){this.state().meta[table]||={};this.state().meta[table][row.id]={version:row.version,base:L.canonical(row.data),status:'synced'};}
    status(table,row){const m=this.meta(table,L.key(table,row));return m?.status==='conflict'?'conflict':m?.base===L.canonical(L.clean(row))?'synced':m?.status==='failed'?'failed':'pending';}
    summary(){const counts={pending:0,synced:0,failed:0,conflict:0};for(const t of L.tables)for(const r of this.getDB()[t])counts[this.status(t,r)]++;return counts;}
    async request(path,{body,token}={}){
      const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),20000);
      try{
        const res=await this.fetcher(this.config.supabaseUrl+path,{method:body===undefined?'GET':'POST',signal:ctrl.signal,cache:'no-store',
          headers:{apikey:this.config.supabaseKey,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
          ...(body===undefined?{}:{body:JSON.stringify(body)})});
        const data=await res.json();
        if(!res.ok)throw new Error(data.msg||data.message||data.error_description||data.error||`HTTP ${res.status}`);
        return data;
      }finally{clearTimeout(timeout);}
    }
    saveAuth(auth){auth.expires_at||=Math.floor(Date.now()/1000)+auth.expires_in;this.storage.setItem(this.authKey,JSON.stringify(auth));this.auth=auth;}
    async signIn(email,password){
      if(!this.configured)throw new Error('Configure a development Supabase URL and publishable key in config.js first.');
      const auth=await this.request('/auth/v1/token?grant_type=password',{body:{email,password}});
      this.checkOwner(auth.user.id);this.saveAuth(auth);this.persist();await this.sync();
    }
    checkOwner(id){
      const owner=this.config.supabaseUrl+'/'+id,state=this.state();
      if(state.owner&&state.owner!==owner)throw new Error('This cache belongs to another account or project. Export it and use a separate preview origin.');
      state.owner=owner;
    }
    async token(){
      if(this.paused)throw new Error('Cache changed in another tab. Reload before syncing.');
      if(!this.auth)throw new Error('Sign in to sync. Offline records remain on this device.');
      this.checkOwner(this.auth.user.id);
      if(this.auth.expires_at*1000<Date.now()+60000){
        if(!this.refreshing)this.refreshing=this.request('/auth/v1/token?grant_type=refresh_token',{body:{refresh_token:this.auth.refresh_token}})
          .then(a=>this.saveAuth(a)).finally(()=>{this.refreshing=null;});
        await this.refreshing;
      }
      return this.auth.access_token;
    }
    async api(path,body){return this.request('/rest/v1/'+path,{body,token:await this.token()});}
    async signOut(){
      clearTimeout(this.timer);if(this.running)await this.running;
      try{if(this.auth)await this.request('/auth/v1/logout?scope=local',{body:{},token:await this.token()});}catch{/* local sign out is still possible offline */}
      this.auth=null;this.storage.removeItem(this.authKey);this.message='Signed out. Cached and pending records remain on this device.';this.changed();
    }
    schedule(delay=1200){
      clearTimeout(this.timer);
      if(this.configured&&this.auth&&!this.paused)this.timer=setTimeout(()=>this.sync(),delay);
    }
    async sync(){
      if(this.running)return this.running;
      if(!this.configured||!this.auth||this.paused)return;
      clearTimeout(this.timer);this.busy=true;this.changed();
      this.running=this.run().catch(e=>{this.message=e.name==='AbortError'?'Sync timed out. Records remain pending.':e.message;this.schedule(this.backoff);this.backoff=Math.min(this.backoff*2,300000);})
        .finally(()=>{this.busy=false;this.running=null;this.changed();});
      return this.running;
    }
    async run(){
      await this.token();
      const manifest=await this.api('rpc/ledger_manifest',{});
      for(const table of L.tables){
        if(this.state().manifest[table]===manifest[table])continue;
        let after='',rows=[];
        do{
          const page=await this.api(`${table}?select=id,data,version&order=id.asc&limit=200${after?'&id=gt.'+encodeURIComponent('"'+after.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"'):''}`);
          if(!Array.isArray(page))throw new Error('Invalid database response');
          rows.push(...page);after=page.length===200?page.at(-1).id:'';
        }while(after);
        // Only modify cache after the complete table read succeeds.
        for(const row of rows)this.receive(table,row);
        this.state().manifest[table]=manifest[table];this.persist();
      }
      const issues=L.validate(this.getDB());
      if(issues.length)throw new Error('Sync paused: '+issues[0]+'. Export backup for review.');
      for(const table of L.tables){
        for(const item of [...this.getDB()[table]]){
          const id=L.key(table,item),status=this.status(table,item);
          if(status==='synced'||status==='conflict')continue;
          const data=L.clean(item),m=this.meta(table,id);
          try{
            const result=await this.api('rpc/ledger_write',{p_table:table,p_id:id,p_data:data,p_version:m?.version??null});
            if(result.conflict){this.conflict(table,id,result.row);}
            else if(result.ok&&result.row&&L.canonical(result.row.data)===L.canonical(data)){
              this.acknowledge(table,result.row);
            }else throw new Error('Database did not confirm the saved record');
            this.persist();
          }catch(e){
            this.state().meta[table]||={};this.state().meta[table][id]={...m,status:'failed',error:e.message};this.persist();throw e;
          }
        }
      }
      const counts=this.summary();this.backoff=5000;
      this.message=counts.conflict?`${counts.conflict} conflicts need review. Both versions are preserved.`:
        counts.pending?`${counts.pending} new changes waiting to sync.`:'All records confirmed by Supabase.';
      this.state().lastSyncedAt=new Date().toISOString();this.persist();
      this.schedule(counts.pending?1200:60000);
    }
    receive(table,row){
      const items=this.getDB()[table],i=items.findIndex(r=>L.key(table,r)===row.id),local=items[i],m=this.meta(table,row.id);
      if(!local){items.push(row.data);this.acknowledge(table,row);return;}
      if(L.equal(local,row.data)){this.acknowledge(table,row);return;}
      const dirty=!m||m.base!==L.canonical(L.clean(local));
      if(!dirty||(!m&&this.isSeed(table,local))){items[i]=row.data;this.acknowledge(table,row);return;}
      if(m?.version===row.version&&m.status!=='conflict')return; // pending edit against the same base
      this.conflict(table,row.id,row);
    }
    conflict(table,id,row){this.state().meta[table]||={};this.state().meta[table][id]={...this.meta(table,id),status:'conflict',remote:row};}
    resolve(table,id,choice){
      const m=this.meta(table,id);if(m?.status!=='conflict')return;
      const items=this.getDB()[table],i=items.findIndex(r=>L.key(table,r)===id);
      if(choice==='remote')items[i]=L.clone(m.remote.data);
      this.acknowledge(table,m.remote); // choosing local now targets the reviewed remote revision
      this.persist();this.changed();this.schedule();
    }
  }
  if(typeof module!=='undefined')module.exports=LedgerCloud;else root.LedgerCloud=LedgerCloud;
})(typeof globalThis!=='undefined'?globalThis:this);
