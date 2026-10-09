// One coherent shell per release; close all tabs to activate a waiting update.
// Never reload an active workout. Bump RELEASE for every published app change.
const RELEASE='v2-production-4';
const PREFIX='iron-ledger:'+self.registration.scope+':';
const CACHE=PREFIX+RELEASE;
const SHELL=['./','./index.html','./ledger-core.js','./cloud.js','./config.js',
  './manifest.json','./icon-180.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)))));
});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
  if(!SHELL.some(path=>new URL(path,self.registration.scope).pathname===url.pathname))return;
  event.respondWith(caches.open(CACHE).then(async cache=>{
    const hit=await cache.match(event.request,{ignoreSearch:true});
    return hit||fetch(event.request);
  }));
});
