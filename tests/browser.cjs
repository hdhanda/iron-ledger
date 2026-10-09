const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const allowed=new Set(['index.html','ledger-core.js','cloud.js','config.js','manifest.json','sw.js','icon-180.png','icon-192.png','icon-512.png']);
const server=http.createServer((req,res)=>{
 const name=new URL(req.url,'http://local').pathname.slice(1)||'index.html';
 if(!allowed.has(name)){res.writeHead(404).end();return;}
 const type=name.endsWith('.js')?'application/javascript':name.endsWith('.html')?'text/html':name.endsWith('.png')?'image/png':'application/json';
 res.setHeader('Content-Type',type);res.end(fs.readFileSync(path.join(root,name)));
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true,...(process.env.BROWSER_PATH?{executablePath:process.env.BROWSER_PATH}:{})});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{
   await page.goto(`http://127.0.0.1:${server.address().port}`);
   let authRequests=0;
   await page.route('https://*.supabase.co/**',route=>{
     if(route.request().url().includes('/auth/v1/token'))authRequests++;
     return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'Test credentials rejected by server'})});
   });
   await page.evaluate(()=>{cloud.config.supabaseUrl='https://browser-test.supabase.co';cloud.config.supabaseKey='sb_publishable_test';});
   await page.getByRole('button',{name:'data',exact:true}).click();
   await page.locator('#cloudEmail').fill('test@example.com');await page.locator('#cloudPassword').fill('not-a-real-password');
   await page.getByRole('button',{name:'Sign in',exact:true}).click();
   await page.waitForFunction(()=>document.getElementById('toast').textContent==='Test credentials rejected by server');
   assert.equal(authRequests,1);
   await page.getByRole('button',{name:'train',exact:true}).click();
   const activeKey=await page.evaluate(()=>CONFIG.storageKey);
   const otherKey=activeKey==='ironledger'?'ironledger-v2-preview':'ironledger';
   await page.evaluate(key=>localStorage.setItem(key,'OTHER-CACHE-UNCHANGED'),otherKey);
   const navBottom=()=>page.locator('nav').evaluate(e=>e.getBoundingClientRect().bottom);
   assert.equal(await navBottom(),844);
   // Reproduce installed iOS reporting a visual viewport short by its top inset.
   const viewportChecks=await page.evaluate(()=>{
     const original=Object.getOwnPropertyDescriptor(window,'visualViewport');
     try{
       Object.defineProperty(window,'visualViewport',{configurable:true,value:{height:innerHeight-62,offsetTop:0,scale:1}});
       sizeViewport();
       const normal=document.querySelector('nav').getBoundingClientRect().bottom;
       window.visualViewport.height=innerHeight-320;sizeViewport();
       const keyboard=document.querySelector('nav').getBoundingClientRect().bottom;
       window.visualViewport.height=innerHeight-62;sizeViewport();
       const restored=document.querySelector('nav').getBoundingClientRect().bottom;
       return {normal,keyboard,restored};
     }finally{Object.defineProperty(window,'visualViewport',original);sizeViewport();}
   });
   assert.deepEqual(viewportChecks,{normal:844,keyboard:524,restored:844});
   // Menu must not follow an oversized app body below the usable viewport.
   await page.evaluate(()=>document.body.style.height='1100px');
   assert.equal(await navBottom(),844);
   const buttons=await page.locator('nav button').evaluateAll(nodes=>nodes.map(e=>{
     const r=e.getBoundingClientRect();return {visible:r.top>=0&&r.bottom<=innerHeight,height:r.height,hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e};
   }));
   assert.equal(buttons.length,4);assert.ok(buttons.every(b=>b.visible&&b.height>=48&&b.hit));
   await page.evaluate(()=>document.body.style.removeProperty('height'));
   await page.getByRole('button',{name:'Push',exact:true}).click();
   await page.getByRole('button',{name:'+ Add exercise'}).click();
   await page.evaluate(()=>{window.originalSearch=document.getElementById('q');});
   await page.locator('#q').pressSequentially('Bench',{delay:30});
   assert.equal(await page.evaluate(()=>document.activeElement===window.originalSearch&&document.getElementById('q')===window.originalSearch),true);
   await page.getByRole('button',{name:'Barbell Bench Press'}).click();
   await page.getByRole('button',{name:'Log set',exact:true}).click();
   await page.reload();assert.equal(await page.locator('.setrow').count(),1);
   await page.getByRole('button',{name:'Finish',exact:true}).click();
   await page.evaluate(()=>{
     DB.sessions=Array.from({length:65},(_,i)=>({id:'history_'+i,date:'2026-01-'+String(i%28+1).padStart(2,'0'),type:'Push',status:'completed',readiness:{sleep:3,soreness:2,stress:2},notes:'',entries:[{exId:'barbell-bench-press',sets:[{id:'set_'+i,w:100+i,r:8,rpe:8,warmup:false}]}]}));save();
   });
   await page.getByRole('button',{name:'progress',exact:true}).click();
   assert.equal(await page.locator('#progressResults>.card').count(),66);
   assert.equal(await navBottom(),844);
   await page.getByRole('button',{name:'Exercise progression',exact:true}).click();
   await page.locator('#progressQuery').fill('Bench');await page.locator('#progressExercise').selectOption('barbell-bench-press');
   assert.equal(await page.locator('#progressResults details').count(),65);
   assert.match(await page.locator('#progressResults').innerText(),/Heaviest 164 lb/);
   await page.setViewportSize({width:390,height:490});await page.waitForFunction(()=>document.querySelector('nav').getBoundingClientRect().bottom===490);
   await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('nav').getBoundingClientRect().bottom===844);
   fs.mkdirSync(path.join(root,'test-results'),{recursive:true});await page.screenshot({path:path.join(root,'test-results/progression.png')});
   await page.getByRole('button',{name:'train',exact:true}).click();
   await page.getByRole('button',{name:'Push',exact:true}).click();await page.getByRole('button',{name:'+ Add exercise'}).click();
   await page.locator('#q').fill('Offline Custom');await page.getByRole('button',{name:'Create "Offline Custom"'}).click();
   await page.getByRole('button',{name:'Horizontal Push',exact:true}).click();await page.getByRole('button',{name:'Add to session',exact:true}).click();
   await page.getByRole('button',{name:'Log set',exact:true}).click();
   await page.evaluate(()=>navigator.serviceWorker.ready);await page.reload();
   await context.setOffline(true);await page.reload();
   assert.match(await page.locator('#view').innerText(),/Offline Custom/);assert.equal(await page.locator('.setrow').count(),1);
   assert.equal(await page.evaluate(key=>localStorage.getItem(key),otherKey),'OTHER-CACHE-UNCHANGED');
   assert.ok(JSON.parse(await page.evaluate(key=>localStorage.getItem(key),activeKey)).sessions.length>=65);
   await context.setOffline(false);
   await page.getByRole('button',{name:'Finish',exact:true}).click();await page.getByRole('button',{name:'train',exact:true}).click();
   await page.getByRole('button',{name:'Log a run',exact:true}).click();await page.getByRole('button',{name:'Save run',exact:true}).click();
   await page.getByRole('button',{name:'train',exact:true}).click();await page.getByRole('button',{name:'Log body stats',exact:true}).click();await page.getByRole('button',{name:'Save stats',exact:true}).click();
   assert.equal(await page.evaluate(()=>DB.cardio.length),1);assert.equal(await page.evaluate(()=>DB.body.length),1);
   await page.getByRole('button',{name:'data',exact:true}).click();
   const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download full backup (JSON)'}).click();assert.match((await downloaded).suggestedFilename(),/backup/);
   const csv=page.waitForEvent('download');await page.getByRole('button',{name:'Export sets to CSV'}).click();assert.match((await csv).suggestedFilename(),/\.csv$/);
   assert.deepEqual(errors,[]);console.log('PASS: mobile navigation, stable search, 65-session history, offline restart, custom exercises, cardio/body, exports, production cache isolation.');
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
