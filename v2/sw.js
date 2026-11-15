const C='kg2-v5';const A=['./','./index.html','./manifest.json'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))));self.clients.claim()});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin)return;e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request)))});

self.addEventListener('push',e=>{let d={title:'Kegel',body:'Chwila dla siebie'};try{d=Object.assign(d,e.data.json())}catch(x){}
e.waitUntil(self.registration.showNotification(d.title,{body:d.body,tag:d.tag||'kegel',icon:'../icon-192.png',badge:'../icon-192.png',renotify:true}))});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if(c.url.includes('/v2/'))return c.focus()}return clients.openWindow('./index.html')}))});
