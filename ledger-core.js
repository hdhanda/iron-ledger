/* Shared, dependency-free calculations and non-destructive backup reconciliation. */
(function(root){
  const tables=['exercises','routines','sessions','cardio','body'];
  const clone=x=>JSON.parse(JSON.stringify(x));
  const key=(table,row)=>table==='routines'?JSON.stringify([row.id,row.split]):row.id;
  const canonical=x=>JSON.stringify(normalize(x));
  function normalize(x){
    if(Array.isArray(x))return x.map(normalize);
    if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>[k,normalize(x[k])]));
    return x;
  }
  function clean(row){const r=clone(row);delete r.synced;return r;}
  const equal=(a,b)=>canonical(clean(a))===canonical(clean(b));
  const completed=s=>!s.status||['completed','deload'].includes(s.status);
  const order=(a,b)=>a.date.localeCompare(b.date)||((a.endedAt||a.startedAt||0)-(b.endedAt||b.startedAt||0))||a.id.localeCompare(b.id);
  const setsFor=(s,id)=>s.entries.filter(e=>!id||e.exId===id).flatMap(e=>e.sets);
  const working=sets=>sets.filter(s=>!s.warmup);
  const e1rm=s=>s.r>0?+(s.w*(1+s.r/30)).toFixed(1):0;
  const best=sets=>Math.max(0,...working(sets).map(e1rm));
  function stats(sets){const work=working(sets);return{sets:work.length,volume:work.reduce((n,s)=>n+s.w*s.r,0),weight:Math.max(0,...work.map(s=>s.w)),e1rm:best(work)};}
  const history=(sessions,id)=>sessions.filter(s=>completed(s)&&s.entries.some(e=>e.exId===id)).sort(order);
  function previous(sessions,id,skip){
    const s=history(sessions.filter(s=>s.id!==skip),id).reverse().find(s=>working(setsFor(s,id)).length);
    return s?{date:s.date,sets:working(setsFor(s,id))}:null;
  }
  function records(sessions,id,skip){return stats(sessions.filter(s=>s.id!==skip&&completed(s)).flatMap(s=>setsFor(s,id)));}
  function pr(s,baseline){return !s.warmup&&baseline.sets?{weight:s.w>baseline.weight,e1rm:e1rm(s)>baseline.e1rm}:{weight:false,e1rm:false};}
  function validate(db){
    const issues=[],setIDs=new Map();
    for(const table of tables){
      if(!Array.isArray(db[table])){issues.push(`${table}: expected array`);continue;}
      const ids=new Set();
      for(const r of db[table]){
        if(!r||typeof r.id!=='string'||!r.id){issues.push(`${table}: missing ID`);continue;}
        const k=key(table,r);if(ids.has(k))issues.push(`${table}: duplicate ID ${k}`);ids.add(k);
        if(['sessions','cardio','body'].includes(table)&&!/^\d{4}-\d{2}-\d{2}$/.test(r.date||''))issues.push(`${table}/${r.id}: invalid date`);
      }
    }
    const ex=new Set((db.exercises||[]).map(e=>e.id));
    for(const r of db.routines||[])for(const b of r.blocks||[])if(!ex.has(b.exId))issues.push(`routine ${r.id}: missing exercise ${b.exId}`);
    for(const s of [...(db.sessions||[]),...(db.active?[db.active]:[])]){
      if(!Array.isArray(s.entries)){issues.push(`session ${s.id}: missing entries`);continue;}
      for(const e of s.entries){
        if(!ex.has(e.exId))issues.push(`session ${s.id}: missing exercise ${e.exId}`);
        if(!Array.isArray(e.sets)){issues.push(`session ${s.id}: missing sets`);continue;}
        for(const st of e.sets){
          if(typeof st.id!=='string'||!st.id)issues.push(`session ${s.id}: missing set ID`);
          if(setIDs.has(st.id))issues.push(`duplicate set ${st.id}: ${setIDs.get(st.id)} / ${s.id}`);setIDs.set(st.id,s.id);
          if(!Number.isFinite(st.w)||st.w<0||!Number.isInteger(st.r)||st.r<=0)issues.push(`set ${st.id}: invalid weight/reps`);
          if(typeof st.warmup!=='boolean')issues.push(`set ${st.id}: invalid warmup`);
        }
      }
    }
    return issues;
  }
  // Fill missing fields and union set IDs; conflicting facts require review, never last-write-wins.
  function merge(a,b){
    const out=clone(a),conflicts=[];
    function fields(left,right,path){
      for(const [k,v] of Object.entries(right)){
        if(k==='synced')continue;
        if(left[k]===undefined||left[k]===null||left[k]===''){left[k]=clone(v);continue;}
        if(v===null||v===''||v===undefined)continue;
        if(canonical(left[k])!==canonical(v))conflicts.push({path:`${path}.${k}`,local:clone(left[k]),incoming:clone(v)});
      }
      return left;
    }
    for(const table of tables){
      out[table]||=[];
      for(const incoming of b[table]||[]){
        const existing=out[table].find(r=>key(table,r)===key(table,incoming));
        if(!existing){out[table].push(clone(incoming));continue;}
        const path=`${table}/${key(table,incoming)}`;
        if(table!=='sessions'){fields(existing,incoming,path);continue;}
        const {entries,...meta}=incoming;fields(existing,meta,path);
        for(const en of entries||[]){
          // Entries with the same exercise can be separate blocks; set IDs decide overlap.
          let dest=existing.entries.find(e=>e.exId===en.exId&&e.sets.some(s=>en.sets.some(t=>t.id===s.id)));
          dest||=existing.entries.find(e=>e.exId===en.exId);
          if(!dest){existing.entries.push(clone(en));continue;}
          const {sets,...entryMeta}=en;fields(dest,entryMeta,`${path}/${en.exId}`);
          for(const st of sets){const old=dest.sets.find(s=>s.id===st.id);if(old)fields(old,st,`${path}/${st.id}`);else dest.sets.push(clone(st));}
        }
      }
    }
    if(b.active){if(!out.active)out.active=clone(b.active);else if(canonical(out.active)!==canonical(b.active))conflicts.push({path:'active',local:out.active,incoming:b.active});}
    return{db:out,conflicts,issues:validate(out)};
  }
  const api={tables,clone,key,canonical,clean,equal,completed,order,setsFor,working,e1rm,best,stats,history,previous,records,pr,validate,merge};
  if(typeof module!=='undefined')module.exports=api;else root.Ledger=api;
})(typeof globalThis!=='undefined'?globalThis:this);
