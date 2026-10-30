// Compare fetch/XHR body delivery by content type on a loopback fixture.
// node stream-content-types.mjs moli /path/to/moli [results.json]
// node stream-content-types.mjs chromium /path/to/chromium [results.json]
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const [kind,binaryArg,resultArg]=process.argv.slice(2);
assert(['moli','chromium'].includes(kind)&&binaryArg,'Expected engine and executable path');
const binary=resolve(binaryArg);
const directory=await mkdtemp(join(tmpdir(),'chat-stream-content-types-'));
const resultPath=resultArg?resolve(resultArg):join(directory,'results.json');
const events=[];
const fixture=createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname!=='/body'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><body>stream fixture</body>');return;}
 res.writeHead(200,{'content-type':url.searchParams.get('type'),'cache-control':'no-cache'});res.flushHeaders();
 let n=0;const timer=setInterval(()=>{
  res.write(Buffer.from('data: '+(++n)+'\n\n'));
  if(n===10){clearInterval(timer);res.end();}
 },300);
 res.on('close',()=>clearInterval(timer));
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+fixture.address().port;
const temporary=createServer();await new Promise(r=>temporary.listen(0,'127.0.0.1',r));const port=temporary.address().port;await new Promise(r=>temporary.close(r));
const log=await open(join(directory,'browser.log'),'a');
const args=kind==='moli'?['serve','--port',String(port),'--profile-dir',directory+'/profile','--http-no-proxy','*']:['--headless=new','--remote-debugging-port='+port,'--user-data-dir='+directory+'/profile','--no-first-run','--no-default-browser-check','about:blank'];
let spawnError;const child=spawn(binary,args,{stdio:['ignore',log.fd,log.fd]});child.on('error',error=>{spawnError=error;});await log.close();
let ws;let sequence=0;const pending=new Map();let sessionId;
function send(method,params={},session){
 return new Promise((resolve,reject)=>{
  const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout '+method));},15000);
  pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(session?{sessionId:session}:{})}));
 });
}
async function evaluate(expression){
 const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:false},sessionId);
 if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;
}
const report={engine:kind,startedAt:new Date().toISOString(),chunks:10,intervalMs:300,cases:[]};
try{
 let endpoint;
 for(let n=0;n<150;n++){
  if(spawnError)throw spawnError;
  if(child.exitCode!==null)throw new Error('Browser exited '+child.exitCode);
  try{endpoint=await(await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(500)})).json();if(endpoint.webSocketDebuggerUrl)break;}catch{}await delay(100);
 }
 assert(endpoint?.webSocketDebuggerUrl,'Browser endpoint unavailable');
 report.browser=endpoint.Browser;report.moliVersion=endpoint['Moli-Version'];
 ws=new WebSocket(endpoint.webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
 ws.addEventListener('message',({data})=>{
  const m=JSON.parse(data);
  if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}}
  else if(m.method==='Runtime.bindingCalled'&&m.params.name==='__fixtureEvent')events.push(JSON.parse(m.params.payload));
 });
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});
 ({sessionId}=await send('Target.attachToTarget',{targetId,flatten:true}));
 await send('Runtime.enable',{},sessionId);await send('Page.enable',{},sessionId);
 await send('Runtime.addBinding',{name:'__fixtureEvent'},sessionId);
 await send('Page.navigate',{url:origin},sessionId);
 for(let n=0;n<100;n++){if(await evaluate('document.readyState!=="loading"&&location.href.startsWith('+JSON.stringify(origin)+')'))break;await delay(50);}
 const types=['text/event-stream','application/connect+json','application/octet-stream','text/plain'];
 const cases=types.map(type=>({type,redirect:'follow',realistic:false}));
 for(const redirect of ['follow','error','manual'])cases.push({type:'application/connect+json',redirect,realistic:true});
 for(const config of cases){
  const {type}=config;const key='fetch:'+type+(config.realistic?':request-options:'+config.redirect:'');const start=events.length;
  await evaluate('('+function(type,key,config){
   const t=performance.now();const emit=(kind,extra={})=>__fixtureEvent(JSON.stringify({key,kind,ms:performance.now()-t,...extra}));
   (async()=>{
    try{
     const options={method:'POST',redirect:config.redirect};
     if(config.realistic)Object.assign(options,{headers:{'content-type':'application/connect+json',authorization:'Bearer local-fixture-only'},body:new TextEncoder().encode('{\"fixture\":true}'),credentials:'include',mode:'cors',signal:new AbortController().signal});
     const response=await fetch('/body?type='+encodeURIComponent(type),options);emit('headers');
     const clone=response.clone();
     await Promise.all([['original',response],['clone',clone]].map(async([readerName,r])=>{
      const reader=r.body.getReader();let bytes=0;let body='';const decoder=new TextDecoder();for(;;){const v=await reader.read();if(v.done)break;bytes+=v.value.length;body+=decoder.decode(v.value,{stream:true});emit('chunk',{reader:readerName,bytes:v.value.length});}
      body+=decoder.decode();emit('done',{reader:readerName,totalBytes:bytes,body});
     }));
    }catch(e){emit('error',{message:String(e)});}
   })();return true;
  }.toString()+')('+JSON.stringify(type)+','+JSON.stringify(key)+','+JSON.stringify(config)+')');
  for(let n=0;n<200;n++){const current=events.slice(start);if(current.some(e=>e.kind==='error')||current.filter(e=>e.kind==='done').length===2)break;await delay(50);}
  const current=events.slice(start);assert.equal(current.filter(e=>e.kind==='done').length,2,JSON.stringify(current));
  for(const done of current.filter(e=>e.kind==='done'))assert.equal(done.body,Array.from({length:10},(_,i)=>'data: '+(i+1)+'\n\n').join(''));
  report.cases.push({key,events:current});
 }
 const key='xhr:text/event-stream';const start=events.length;
 await evaluate('('+function(key){
  const start=performance.now();const emit=(kind,extra={})=>__fixtureEvent(JSON.stringify({key,kind,ms:performance.now()-start,...extra}));
  const xhr=new XMLHttpRequest();let previous=0;
  xhr.open('POST','/body?type=text%2Fevent-stream');
  xhr.addEventListener('readystatechange',()=>{if(xhr.readyState===2)emit('headers');});
  xhr.addEventListener('progress',()=>{emit('chunk',{bytes:xhr.responseText.length-previous});previous=xhr.responseText.length;});
  xhr.addEventListener('load',()=>emit('done',{totalBytes:xhr.responseText.length,body:xhr.responseText}));
  xhr.addEventListener('error',()=>emit('error'));xhr.send();return true;
 }.toString()+')('+JSON.stringify(key)+')');
 for(let n=0;n<200;n++){if(events.slice(start).some(e=>e.kind==='done'||e.kind==='error'))break;await delay(50);}
 const current=events.slice(start);assert(current.some(e=>e.kind==='done'),JSON.stringify(current));assert.equal(current.find(e=>e.kind==='done').body,Array.from({length:10},(_,i)=>'data: '+(i+1)+'\n\n').join(''));report.cases.push({key,events:current});
 for(const c of report.cases)console.log(c.key,JSON.stringify({headersMs:c.events.find(e=>e.kind==='headers')?.ms,firstChunkMs:c.events.find(e=>e.kind==='chunk')?.ms,chunks:c.events.filter(e=>e.kind==='chunk').length,doneMs:c.events.find(e=>e.kind==='done')?.ms}));
}catch(error){report.error=String(error);throw error;}finally{
 report.endedAt=new Date().toISOString();await writeFile(resultPath,JSON.stringify(report,null,2),{mode:0o600});
 if(ws?.readyState===WebSocket.OPEN)await send('Browser.close').catch(()=>{});
 if(child.pid&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(r=>child.once('exit',r));await Promise.race([exited,delay(3000)]);if(child.pid&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([exited,delay(1000)]);if(child.pid&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}}
 ws?.close();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Browser closed'));}pending.clear();
 await new Promise(r=>fixture.close(r));
}
console.log('Results:',resultPath);
