// Versioned application shell; the user's word library remains exclusively in localStorage.
const CACHE = 'dictation-buddy-v0.3.7';
const SHELL = ['./', './index.html', './manual.html', './styles.css?v=0.3.7', './app.js?v=0.3.7', './core.js', './ocr-utils.js', './version-utils.js', './audio-store.js', './manifest.webmanifest', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png', './assets/audio/Dir_OP.mp3', './assets/audio/Dir_EP.mp3'];
self.addEventListener('install', event => {
  event.waitUntil((async()=>{
    await (await caches.open(CACHE)).addAll(SHELL);
    // v0.3.1 had no in-app update action: activate the migration build without requiring one.
    // The app still asks the user before reloading its own page.
    const keys=await caches.keys();
    if(keys.some(key=>key.startsWith('dictation-buddy-') && key!==CACHE))await self.skipWaiting();
  })());
});
self.addEventListener('message', event => {
  if(event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('dictation-buddy-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req=event.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin) return;
  // Never cache the update manifest; the phone must be able to discover new releases.
  if(url.pathname.endsWith('/version.json') || url.pathname.endsWith('/sw.js')){
    event.respondWith(fetch(req,{cache:'no-store'}));return;
  }
  if(req.mode==='navigate'){
    event.respondWith(fetch(req).then(res=>{if(res.ok){const clone=res.clone();caches.open(CACHE).then(cache=>cache.put(url.pathname.endsWith('/manual.html')?'./manual.html':'./index.html',clone));}return res;}).catch(()=>caches.match(url.pathname.endsWith('/manual.html')?'./manual.html':'./index.html')));
    return;
  }
  event.respondWith(caches.match(req).then(cached=>cached||fetch(req).then(res=>{
    if(res.ok){const clone=res.clone();caches.open(CACHE).then(cache=>cache.put(req,clone));}
    return res;
  })));
});
