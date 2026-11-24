// Chromium mechanism fixture: synthetic HTTPS origins via CDP response interception.
// Usage: node scripts/test-gemini-callback-browser.mjs <chromium executable>
// Uses a disposable browser profile, no real OAuth credentials or network endpoints.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
if (!process.argv[2]) throw new Error('Pass the Chromium executable path');
const chrome=process.argv[2], profile=await mkdtemp(join(tmpdir(),'odr-csp-fixture-'));
const A='https://origin-a.example.test',B='https://origin-b.example.test',C='https://origin-c.example.test';
const params='code=fixture-code&state=fixture%26state&iss=https%3A%2F%2Fissuer.example.test%2F';
const csp="default-src 'none'; style-src 'unsafe-inline'; form-action 'self' "+B+"; frame-ancestors 'none'; base-uri 'none'";
const bridgeCsp="default-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const browser=spawn(chrome,['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore',windowsHide:true});
let socket;
const watchdog=setTimeout(()=>{console.error('Browser fixture timeout');socket?.close();browser.kill();process.exit(2)},45000);
try{
 let port;
 for(let i=0;i<60;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];if(port)break}catch{}await pause(150)}
 if(!port)throw Error('No CDP endpoint');console.log('CDP ready');
 let page;for(let i=0;i<20;i++){try{page=(await (await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(3000)})).json()).find(p=>p.type==='page');if(page)break}catch{}await pause(250)}
 if(!page)page=await (await fetch('http://127.0.0.1:'+port+'/json/new?about:blank',{method:'PUT',signal:AbortSignal.timeout(3000)})).json();
 console.log('Page target ready');
 socket=new WebSocket(page.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})});
 console.log('CDP connected');
 let id=0,mode='',events=[],pending=new Map();
 function send(method,params={}){const n=++id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout: '+method))},6000);pending.set(n,{resolve,reject,timer});socket.send(JSON.stringify({id:n,method,params}))})}
 const esc=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 async function fulfill(p,status,headers,body=''){await send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:status,responseHeaders:Object.entries({'Content-Type':'text/html; charset=utf-8',...headers}).map(([name,value])=>({name,value})),body:Buffer.from(body).toString('base64')})}
 socket.addEventListener('message',async e=>{const m=JSON.parse(e.data);if(m.id){const q=pending.get(m.id);if(q){clearTimeout(q.timer);pending.delete(m.id);m.error?q.reject(Error(m.error.message)):q.resolve(m.result)}return}
 const p=m.params;
 try{
 if(m.method==='Fetch.requestPaused'){
 const u=new URL(p.request.url),method=p.request.method;events.push({request:method+' '+u.origin+u.pathname,query:u.search});
 if(u.origin===A&&method==='GET')await fulfill(p,200,{'Content-Security-Policy':csp},'<form method="post" action="'+A+'/consent"><button>Allow access</button></form>');
 else if(u.origin===A&&method==='POST'){const target=B+'/'+(mode==='single'?'single':'chain')+'?'+params;
 if(mode==='bridge'||mode==='manual'){const x=esc(target);await fulfill(p,200,{'Content-Security-Policy':bridgeCsp,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'},(mode==='bridge'?'<meta http-equiv="refresh" content="0;url='+x+'">':'')+'<a href="'+x+'" rel="noreferrer">Continue</a>')}
 else await fulfill(p,302,{Location:target});
 }else if(u.origin===B&&u.pathname==='/chain')await fulfill(p,302,{Location:C+'/done?'+params});
 else if(u.origin===B||u.origin===C)await fulfill(p,200,{},'<h1>Done</h1>');
 else await fulfill(p,404,{},'not found')
 }else if(m.method==='Log.entryAdded')events.push({console:p.entry.text,source:p.entry.source});
 else if(m.method==='Network.loadingFailed')events.push({failure:p.errorText,blockedReason:p.blockedReason});
 }catch(err){events.push({error:String(err)})}
 });
 await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Log.enable');
 await send('Fetch.enable',{patterns:[{urlPattern:'https://*.example.test/*',requestStage:'Request'}]});console.log('Fixture active');
 async function click(selector){const e=await send('Runtime.evaluate',{expression:'(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',returnByValue:true});if(!e.result.value)throw Error('No element '+selector);const {x,y}=e.result.value;await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1})}
 for(const test of ['single','chain','bridge','manual']){
 mode=test;events=[];await send('Page.navigate',{url:A+'/'+test});await pause(700);await click('button');await pause(1000);
 if(mode==='manual'){await click('a');await pause(1000)}
 const result=await send('Runtime.evaluate',{expression:'location.href',returnByValue:true});
 const final=result.result?.value;
 console.log(JSON.stringify({mode,final,events}));
 const expected=test==='single'?B+'/single?'+params:test==='chain'?A+'/chain':C+'/done?'+params;
 if(final!==expected)throw Error('Unexpected final navigation for '+test);
 if(test==='chain'&&!events.some(e=>e.console?.includes('form-action')))throw Error('Expected form-action violation');
 if(test==='chain'&&events.some(e=>e.request?.startsWith('GET '+C)))throw Error('Blocked destination was reached');
 if((test==='bridge'||test==='manual')&&!events.some(e=>e.request==='GET '+C+'/done'))throw Error('Independent navigation did not reach final origin');
 }
 await send('Browser.close').catch(()=>{});
}finally{clearTimeout(watchdog);socket?.close();browser.kill();await pause(250);try{await rm(profile,{recursive:true,force:true,maxRetries:3})}catch{}}
