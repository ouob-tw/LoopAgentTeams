// Requirements-first attachment acceptance, real Chrome + isolated fake-command board.
// Evidence persists outside the fixture; no live agents or production board are used.
import { spawnSync } from 'node:child_process';
import { beforeAll, afterAll, afterEach, test, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, NODE, jsonLines, type Fixture } from '../harness.ts';
import { launchChrome, type Browser, type Tab } from '../browser.ts';
const E = '/tmp/naru-attachments-qa';
const BOX = '.dock .cmd textarea';
const SEND = '.dock .cmd .send-slot button[aria-label="送出"]';
let f: Fixture, cookie: string, b: Browser | undefined, t: Tab;
const evidence = (name: string, data: unknown) => writeFileSync(join(E, name + '.json'), JSON.stringify(data, null, 2));
async function shot(name: string) { const r = await t.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(E, name + '.png'), Buffer.from(r.data, 'base64')); }
async function visit(search = '?controller=s-lead', width = 1280) {
 b = await launchChrome({ screen: 'document.body.innerText' }); t = b.tab;
 const [name, value] = cookie.split('='); await t.send('Network.setCookie', { name, value, url: f.url });
 await t.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width <= 760 });
 await t.navigate(f.url + '/' + search); await t.until(`JSON.stringify(history.state).includes('depth') && !!document.querySelector('${BOX}')`);
 await t.eval(`window.qaRequests=[];window.qaOriginalFetch=window.fetch;window.fetch=async(...a)=>{const r=await window.qaOriginalFetch(...a); if(String(a[0]).includes('/api/uploads')) window.qaRequests.push({url:String(a[0]),method:a[1]?.method,status:r.status,body:await r.clone().text()});return r;}`);
}
async function pick(paths: string[]) { const { root } = await t.send('DOM.getDocument'); const { nodeId } = await t.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.dock input[type=file]' }); await t.send('DOM.setFileInputFiles', { nodeId, files: paths }); }
async function done(n: number) { await t.until(`document.querySelectorAll('.dock .tray li').length === ${n} && [...document.querySelectorAll('.dock .tray li')].every(x=>x.title.startsWith('/'))`, 'uploads complete'); }
async function type(text: string) { await t.eval(`(()=>{const x=document.querySelector('${BOX}');x.value=${JSON.stringify(text)};x.dispatchEvent(new Event('input',{bubbles:true}));})()`); }
async function send() { await t.eval(`document.querySelector('${SEND}').click()`); }
async function paths() { return t.eval<string[]>(`[...document.querySelectorAll('.dock .tray li')].map(x=>x.title)`); }
async function log(controller: boolean) { await t.eval(`document.querySelector('${controller ? '#tab-sent' : '#agent-tab-log'}')?.click()`); }
beforeAll(async () => {
 mkdirSync(E, { recursive: true });
 for(const [name,args] of [['image.png',['-f','lavfi','-i','color=c=red:s=32x32','-frames:v','1']],['clip.webm',['-f','lavfi','-i','color=c=blue:s=320x180:d=4','-c:v','libvpx-vp9']]] as [string,string[]][]){const r=spawnSync('ffmpeg',['-hide_banner','-loglevel','error',...args,'-threads','1','-y',join(E,name)]);if(r.status!==0)throw new Error('ffmpeg fixture failed: '+r.stderr);}
 writeFileSync(join(E, 'note.txt'), 'attachment bytes 一二三\n');
 const bytes=Buffer.alloc(3*1024*1024+17); for(let i=0;i<bytes.length;i++)bytes[i]=i%251; writeFileSync(join(E,'large.bin'),bytes);
 f=await startFixture({env:{LAT_BOARD_INJECT_COMMAND:JSON.stringify([NODE,join(import.meta.dir,'../fake-inject.mjs'),E])}}); cookie=await f.login('attachment-qa');
 const lead=f.bound('lat','lead',{session_id:'s-lead'}); f.list([lead]);
 f.setHcom({agents:['lead','plain','other'].map(name=>({name,session_id:'s-'+name,status:'listening',launch_context:{pane_id:'wA:p-s-'+name}}))});
 const agents=['lead','plain','other'].map(name=>({agent:'claude',agent_session:{kind:'id',value:'s-'+name},agent_status:'idle',cwd:'/tmp/qa-'+name,pane_id:'wA:p-s-'+name,tab_id:'wA:t-s-'+name,workspace_id:'wA'}));
 writeFileSync(join(f.dir,'herdr.json'),JSON.stringify({agents,workspaces:[{workspace_id:'wA',number:1,label:'QA'}],tabs:agents.map(a=>({tab_id:a.tab_id,workspace_id:'wA',label:a.agent_session.value}))})); await f.refresh(cookie);
 evidence('fixture',{url:f.url,dir:f.dir});
});
afterEach(async()=>{if(b){await shot('latest-browser').catch(()=>{}); evidence('latest-dom',await t.eval('document.body.innerText').catch(()=>'')); await b.close();b=undefined;}}); afterAll(async()=>{await f?.cleanup();});
test('1+4: file input previews, chunk bytes, controller and agent sends and sent logs',async()=>{
 await visit(); await t.pointerClick('.dock button[aria-label="附加檔案"]');
 await pick(['image.png','clip.webm','note.txt','large.bin'].map(x=>join(E,x))); await done(4);
 await t.until(`document.querySelector('.tray img').naturalWidth > 0 && document.querySelector('.tray video').readyState >= 1`, 'media previews decoded');
 const p=await paths(); for(let i=0;i<p.length;i++){expect(readFileSync(p[i])).toEqual(readFileSync(join(E,['image.png','clip.webm','note.txt','large.bin'][i])));expect(statSync(p[i]).mode&0o777).toBe(0o600);expect(p[i]).toMatch(/\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}-/);}
 expect(statSync(join(f.dir,'uploads')).mode&0o777).toBe(0o700); await shot('desktop-tray');
 const req=await t.eval<any[]>('window.qaRequests'); evidence('controller-upload-trace',req);
 const large=req.filter(x=>x.method==='PUT'&&x.url.includes(p[3].split('/').pop()!.slice(0,16)));expect(large.length).toBe(13);
 await type('controller attachment QA'); await send(); await t.until(`!document.querySelector('.dock .tray')`);
 const expected='controller attachment QA\n\n附件：\n'+p.join('\n');expect(jsonLines(join(E,'inject-calls.jsonl')).some(x=>x[0]==='lead'&&x[1]===expected)).toBe(true);
 await t.eval(`[...document.querySelectorAll('.detail [role=tab]')].find(x=>x.innerText.includes('送出紀錄')).click()`);
 await t.until(`!!document.querySelector('#panel-sent .attached img') && document.querySelector('#panel-sent .attached video')?.readyState >= 1`); expect(await t.eval(`document.querySelectorAll('#panel-sent .attached .file').length`)).toBe(2); await shot('controller-sent');
 const largeRead=await f.fetch('/api/uploads/file?path='+encodeURIComponent(p[3]),{cookie});expect(largeRead.status).toBe(200);expect(Buffer.from(await largeRead.arrayBuffer())).toEqual(readFileSync(join(E,'large.bin')));
 const range=await f.fetch('/api/uploads/file?path='+encodeURIComponent(p[1]),{cookie,headers:{range:'bytes=100-199'}});expect(range.status).toBe(206);expect(Buffer.from(await range.arrayBuffer())).toEqual(readFileSync(p[1]).subarray(100,200)); evidence('video-range',{status:range.status,headers:Object.fromEntries(range.headers)});
 await t.eval(`(()=>{const v=document.querySelector('#panel-sent video');v.currentTime=2;v.play().catch(()=>{});})()`);await t.until(`document.querySelector('#panel-sent video').currentTime >= 2 && !document.querySelector('#panel-sent video').seeking`); await shot('video-seek');
 await b!.close();b=undefined;await visit('?agent=s-plain');await pick(['image.png','clip.webm','note.txt'].map(x=>join(E,x)));await done(3);const ap=await paths();await send();await t.until(`!document.querySelector('.dock .tray')`);
 const ae='附件：\n'+ap.join('\n');expect(jsonLines(join(E,'inject-calls.jsonl')).some(x=>x[0]==='plain'&&x[1]===ae)).toBe(true);
 await log(false);await t.until(`document.querySelector('#agent-panel-log .attached img')?.naturalWidth > 0 && document.querySelector('#agent-panel-log video')?.readyState >= 1`);expect(await t.eval(`document.querySelectorAll('#agent-panel-log .attached .file').length`)).toBe(1); await shot('agent-sent');
 evidence('send-paths',{controller:p,agent:ap,injects:jsonLines(join(E,'inject-calls.jsonl'))});
},60000);
test('2+3+6: paste/drop, uploading block, recipient isolation and 390px layout',async()=>{
 await visit('?controller=s-lead',390);
 await t.eval(`window.qaRelease=null; window.fetch=async(...a)=>{if(a[1]?.method==='PUT')await new Promise(r=>window.qaRelease=r);return window.qaOriginalFetch(...a);}`);
 await t.eval(`(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob(${JSON.stringify(readFileSync(join(E,'image.png')).toString('base64'))}),c=>c.charCodeAt(0))],'paste.png',{type:'image/png'}));document.querySelector('${BOX}').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));})()`);
 await t.until(`window.qaRelease !== null && document.querySelector('.tray').innerText.includes('上傳中')`);await send();await t.until(`document.body.innerText.includes('附件還在上傳')`);await shot('uploading-block');
 await t.eval('window.fetch=window.qaOriginalFetch;window.qaRelease()');await done(1);
 await t.eval(`(()=>{const d=new DataTransfer();d.items.add(new File(['dropped bytes'],'drop.txt'));document.querySelector('${BOX}').dispatchEvent(new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true}));})()`);await done(2);
 expect(await t.eval('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
 const geo=await t.eval(`({width:innerWidth,scroll:document.documentElement.scrollWidth,button:document.querySelector('.dock .attach').getBoundingClientRect().toJSON(),tray:document.querySelector('.tray').getBoundingClientRect().toJSON(),items:document.querySelectorAll('.tray li').length})`); evidence('phone-geometry',geo);await shot('phone-tray');
 // Navigate with Svelte's own links so in-memory drafts stay alive.
 await t.eval(`document.querySelector('[data-middle="agents"]').click()`);await t.until(`!!document.querySelector('[data-agent="s-plain"]')`);await t.eval(`document.querySelector('[data-agent="s-plain"]').click()`);await t.until(`location.search.includes('s-plain')`);expect(await t.eval(`document.querySelectorAll('.dock .tray li').length`)).toBe(0);
 await t.eval(`document.querySelector('.unfolded button.person[data-controller="lead"]').click()`); await t.until(`location.search.includes('s-lead')`); await done(2);
 await t.eval(`document.querySelector('[data-middle="agents"]').click()`); await t.until(`!!document.querySelector('.inbox [data-agent="s-plain"]')`); await t.eval(`document.querySelector('.inbox [data-agent="s-plain"]').click()`);await t.until(`location.search.includes('s-plain')`);await pick([join(E,'note.txt')]);await done(1);const own=await paths();
 await t.eval(`document.querySelector('.inbox [data-agent="s-other"]').click()`);await t.until(`location.search.includes('s-other')`);expect(await t.eval(`document.querySelectorAll('.dock .tray li').length`)).toBe(0);await pick([join(E,'image.png')]);await done(1);const other=await paths();expect(other).not.toEqual(own);
 await t.eval(`document.querySelector('.inbox [data-agent="s-plain"]').click()`);await t.until(`location.search.includes('s-plain')`);await done(1);expect(await paths()).toEqual(own);evidence('recipient-isolation',{own,other});
 evidence('paste-drop-paths',await t.eval(`document.body.innerText`));
},45000);
test('3: failed upload blocks send; removing it permits send',async()=>{
 const limited=await startFixture({env:{LAT_BOARD_UPLOAD_MAX_MB:'1',LAT_BOARD_INJECT_COMMAND:JSON.stringify([NODE,join(import.meta.dir,'../fake-inject.mjs'),E])}});
 const original=f,originalCookie=cookie;try{const lead=limited.bound('lat','lead',{session_id:'s-lead'});limited.list([lead]);limited.setHcom({agents:[{name:'lead',session_id:'s-lead',status:'listening'}]});cookie=await limited.login();await limited.refresh(cookie);f=limited;await visit();await pick([join(E,'large.bin')]);await t.until(`document.querySelector('.tray .failed')?.innerText.includes('1MB')`);await type('after removing failure');await send();await t.until(`document.body.innerText.includes('有附件上傳失敗')`);await shot('failed-block');await t.pointerClick('.tray .remove');await send();await t.until(`document.querySelector('${BOX}').value === ''`);evidence('failed-removed',{injects:jsonLines(join(E,'inject-calls.jsonl'))});}finally{f=original;cookie=originalCookie;await limited.cleanup();}
},45000);
test('5: login, path containment, sandboxed HTML/SVG and pending files',async()=>{
 const trace:any[]=[]; const req=async(path:string,init:any={})=>{const r=await f.fetch(path,init);trace.push({path,status:r.status,headers:Object.fromEntries(r.headers)});return r;};
 expect((await req('/api/uploads',{method:'POST',headers:{'content-type':'application/json'},body:'{"name":"x","size":1}'})).status).toBe(401);
 expect((await req('/api/uploads/nope?offset=0',{method:'PUT',headers:{'content-type':'application/octet-stream'},body:'x'})).status).toBe(401);expect((await req('/api/uploads/file?path=/etc/passwd')).status).toBe(401);
 writeFileSync(join(f.dir,'outside.txt'),'private');symlinkSync(join(f.dir,'outside.txt'),join(f.dir,'uploads','out.txt'));
 for(const p of [join(f.dir,'outside.txt'),join(f.dir,'uploads','../outside.txt'),join(f.dir,'uploads','out.txt')])expect((await req('/api/uploads/file?path='+encodeURIComponent(p),{cookie})).status).toBe(404);
 await visit();
 for(const name of ['attack.html','attack.svg']){
 const data=name.endsWith('svg')?'<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(`/qa-executed`);parent.postMessage(`executed`,`*`)"></svg>':'<script>fetch(`/qa-executed`);parent.postMessage(`executed`,`*`)</script>';
 const start=await req('/api/uploads',{cookie,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,size:Buffer.byteLength(data)})});const {id,path}=await start.json();await req('/api/uploads/'+id+'?offset=0',{cookie,method:'PUT',headers:{'content-type':'application/octet-stream'},body:data});const r=await req('/api/uploads/file?path='+encodeURIComponent(path),{cookie});expect(r.headers.get('content-security-policy')).toBe('sandbox');expect(r.headers.get('x-content-type-options')).toBe('nosniff');if(name.endsWith('html'))expect(r.headers.get('content-disposition')).toContain('attachment');
 await t.eval(`window.qaExecuted=false;window.addEventListener('message',e=>{if(e.data==='executed')window.qaExecuted=true});(()=>{const i=document.createElement('iframe');i.src=${JSON.stringify('/api/uploads/file?path='+encodeURIComponent(path))};document.body.append(i);})()`);
 }
 await t.eval('new Promise(r=>setTimeout(r,500))');expect(await t.eval('window.qaExecuted')).toBe(false);evidence('security-http',trace);await shot('sandbox');
},45000);
test('missing non-media attachments show the missing-file message',async()=>{
 await visit();await pick([join(E,'note.txt')]);await done(1);const [path]=await paths();await send();await t.until(`!document.querySelector('.dock .tray')`);await t.until(`window.qaRequests.some(r=>r.method==='HEAD' && r.url.includes(${JSON.stringify(encodeURIComponent(path))}) && r.status===200)`, 'initial existence check');renameSync(path,path+'.removed');await t.eval(`[...document.querySelectorAll('.detail [role=tab]')].find(x=>x.innerText.includes('送出紀錄')).click()`);await t.until(`!!document.querySelector('#panel-sent .attached')`);await t.eval(`[...document.querySelectorAll('#panel-sent .attached li')].find(li=>li.title===${JSON.stringify(path)}).querySelector('.file').click()`);await t.until(`document.querySelector('#panel-sent').innerText.includes(${JSON.stringify('檔案已不在：'+path)})`, 'click detects vanished file');await shot('missing-nonmedia');evidence('missing-click-http',await t.eval('window.qaRequests'));evidence('missing-nonmedia',{path,text:await t.eval(`document.querySelector('#panel-sent').innerText`)});const mounted=await t.eval(`document.querySelector('#panel-sent').innerText.includes(${JSON.stringify('檔案已不在：'+path)})`);await b!.close();b=undefined;await visit();await t.eval(`[...document.querySelectorAll('.detail [role=tab]')].find(x=>x.innerText.includes('送出紀錄')).click()`);await t.until(`document.querySelector('#panel-sent').innerText.includes(${JSON.stringify('檔案已不在：'+path)})`, 'fresh browser detects missing file');await shot('missing-nonmedia-fresh');evidence('missing-nonmedia-states',{path,mounted,fresh:true});expect(mounted).toBe(true);
},30000);
test('5: partial uploads remain unavailable after server restart',async()=>{
 const isolated=await startFixture();try{const c=await isolated.login();const r=await isolated.fetch('/api/uploads',{cookie:c,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'partial.txt',size:20})});const {id,path}=await r.json();await isolated.fetch('/api/uploads/'+id+'?offset=0',{cookie:c,method:'PUT',headers:{'content-type':'application/octet-stream'},body:'short'});const complete=await isolated.fetch('/api/uploads',{cookie:c,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'complete.txt',size:0})});const completePath=(await complete.json()).path;const url='/api/uploads/file?path='+encodeURIComponent(path);const before=await isolated.fetch(url,{cookie:c});const uploadRoot=join(isolated.dir,'uploads');const staged=join(uploadRoot,readdirSync(uploadRoot,{recursive:true}).map(String).find(x=>x.includes(id)&&statSync(join(uploadRoot,x)).isFile())!);const beforePart=await isolated.fetch('/api/uploads/file?path='+encodeURIComponent(staged),{cookie:c});await isolated.stop();await isolated.start();const after=await isolated.fetch(url,{cookie:c});const afterPart=await isolated.fetch('/api/uploads/file?path='+encodeURIComponent(staged),{cookie:c});evidence('partial-restart',{path,staged,before:before.status,after:after.status,beforePart:beforePart.status,afterPart:afterPart.status,body:await after.text()});expect(beforePart.status).toBe(404);expect(afterPart.status).toBe(404);expect((await isolated.fetch('/api/uploads/file?path='+encodeURIComponent(completePath),{cookie:c})).status).toBe(200);expect(before.status).toBe(404);expect(after.status).toBe(404);}finally{await isolated.cleanup();}
},30000);
test('completed user files named .part can still download',async()=>{
 const started=await f.fetch('/api/uploads',{cookie,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'archive.part',size:3})});const {id,path}=await started.json();const put=await f.fetch('/api/uploads/'+id+'?offset=0',{cookie,method:'PUT',headers:{'content-type':'application/octet-stream'},body:'abc'});const got=await f.fetch('/api/uploads/file?path='+encodeURIComponent(path),{cookie});const body=await got.text();evidence('completed-part-name',{path,start:started.status,put:put.status,get:got.status,body,bytesOnDisk:readFileSync(path).toString()});expect(got.status).toBe(200);expect(body).toBe('abc');
});
