// Real Chromium, real candidate OAuth handlers, synthetic callback network.
// Run: node --import tsx scripts/test-gemini-oauth-browser.mjs <chromium executable>
// The issuer and downstream receiver are reserved test origins. The Google
// callback is intercepted before network dispatch and its DNS is disabled.
// Each case uses a fresh in-memory database and a fixture-only Owner session.
// This is not an actual Gemini Connected App or a Google account login.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/server/src/app.ts';
import { createDatabase } from '../apps/server/src/db/database.ts';

const chrome = process.argv[2];
if (!chrome) throw Error('Pass the Chromium executable path');
const A = 'https://issuer.example.test';
const B = 'https://oauth-redirect.googleusercontent.com';
const C = 'https://receiver.example.test';
const D = 'https://other-client.example.test';
const fixturePath = '/r/odr-browser-fixture';
const state = 'fixture & " Unicode \u96ea';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = await mkdtemp(join(tmpdir(), 'odr-real-oauth-browser-'));
const browser = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=0', '--user-data-dir='+profile,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--host-resolver-rules=MAP oauth-redirect.googleusercontent.com ~NOTFOUND, MAP *.example.test ~NOTFOUND',
  'about:blank',
], {stdio:'ignore', windowsHide:true});
let socket, current, handlerError;
const pending = new Map();
let nextId = 0;
function send(method, params={}) {
  const id=++nextId;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ pending.delete(id); reject(Error('CDP timeout: '+method)); },20000);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,method,params}));
  });
}
async function fulfill(p,status,headers,body='') {
  const responseHeaders = Object.entries(headers)
    .filter(([name,value])=>value!==undefined && !['content-length','transfer-encoding','connection'].includes(name.toLowerCase()))
    .flatMap(([name,value])=>(Array.isArray(value)?value:[value]).map(value=>({name,value:String(value)})));
  await send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:status,responseHeaders,body:Buffer.from(body).toString('base64')});
}
async function until(predicate, message, ms=10000) {
  const end=Date.now()+ms;
  while(Date.now()<end) {
    if(handlerError) throw handlerError;
    if(await predicate()) return;
    await pause(100);
  }
  throw Error(message);
}
async function click(selector) {
  const result=await send('Runtime.evaluate',{
    expression:'(()=>{const e=document.querySelector('+JSON.stringify(selector)+'); if(!e)return null; e.scrollIntoView({block:"center",inline:"center",behavior:"instant"}); const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
    returnByValue:true,
  });
  const point=result.result.value;
  assert.ok(point,'Missing browser control: '+selector);
  for(const type of ['mousePressed','mouseReleased']) await send('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
}
function hasCspViolation(entry) {
  return entry.includes('form-action') && /violat|refused|blocked/i.test(entry);
}

async function runCase(spec) {
  handlerError=undefined;
  console.log('START '+spec.name);
  const db=createDatabase(':memory:');
  const app=buildApp({db, config:{
    databasePath:':memory:',publicBaseUrl:new URL(A+'/'),environment:'production',
    geminiCallbackCompatEnabled:spec.enabled,agentInstallEnabled:false,supportEnabled:false,
  }});
  try {
    const password=randomBytes(24).toString('base64url');
    const bootstrap=await app.inject({method:'POST',url:'/api/bootstrap',payload:{password}});
    assert.equal(bootstrap.statusCode,201);
    const login=await app.inject({method:'POST',url:'/api/login',payload:{password}});
    assert.equal(login.statusCode,204);
    const cookie=String(login.headers['set-cookie']).split(';')[0];
    const callback=(spec.other?D:B)+fixturePath+'?fixed=one&fixed=two';
    const registration=await app.inject({method:'POST',url:'/oauth/register',payload:{
      redirect_uris:[callback],grant_types:['authorization_code','refresh_token'],
      response_types:['code'],token_endpoint_auth_method:'none',
    }});
    assert.equal(registration.statusCode,201);
    const clientId=registration.json().client_id;
    const verifier=randomBytes(48).toString('base64url');
    const query=new URLSearchParams({response_type:'code',client_id:clientId,
      redirect_uri:callback,scope:'mcp',state,resource:A+'/mcp',
      code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')});
    current={spec,app,cookie,postStatus:undefined,postHeaders:undefined,firstHop:undefined,finalHop:undefined,cspViolations:0};
    await send('Page.navigate',{url:A+'/oauth/authorize?'+query});
    await until(async()=>{
      const r=await send('Runtime.evaluate',{expression:'Boolean(document.querySelector("button[value=approve]"))',returnByValue:true});
      return r.result.value===true;
    },'Actual consent form did not render');
    console.log('CONSENT_RENDERED '+spec.name);
    await click('button[value='+spec.decision+']');
    await until(()=>current.postStatus!==undefined,'Consent POST was not delivered');
    assert.equal(current.postStatus,spec.enabled&&!spec.other?200:302,'Unexpected candidate HTTP status');
    if(spec.enabled&&!spec.other) {
      assert.match(current.postHeaders['content-security-policy'],/form-action 'none'/);
      assert.equal(current.postHeaders['cache-control'],'no-store');
      assert.equal(current.postHeaders['referrer-policy'],'no-referrer');
      assert.equal(current.postHeaders.location,undefined);
    }
    if(spec.manual) {
      await until(async()=>{
        const r=await send('Runtime.evaluate',{expression:'Boolean(document.querySelector("a[rel=noreferrer]"))',returnByValue:true});
        return r.result.value===true;
      },'Manual continuation link missing');
      await click('a[rel=noreferrer]');
    }
    if(spec.blocked) {
      await until(()=>current.cspViolations>0,'Legacy form-action violation was not observed');
      await pause(400);
      assert.ok(current.firstHop,'Legacy request did not reach initial callback');
      assert.equal(current.finalHop,undefined,'Legacy request unexpectedly reached downstream origin');
      console.log(JSON.stringify({case:spec.name,consent:302,cspBlocked:true,downstream:false,result:'PASS'}));
      return;
    }
    await until(()=>spec.chain?!!current.finalHop:!!current.firstHop,'Browser did not reach the expected callback receiver');
    const target=current.finalHop??current.firstHop;
    assert.equal(target.searchParams.get('state'),state);
    assert.equal(target.searchParams.get('iss'),A+'/');
    assert.deepEqual(target.searchParams.getAll('fixed'),['one','two']);
    if(spec.decision==='deny'){
      assert.equal(target.searchParams.get('error'),'access_denied');
      assert.equal(target.searchParams.has('code'),false);
      console.log(JSON.stringify({case:spec.name,consent:current.postStatus,downstream:true,denial:true,result:'PASS'}));
    }else{
      const code=target.searchParams.get('code');
      assert.ok(code,'Callback contained no authorization code');
      const body=new URLSearchParams({grant_type:'authorization_code',client_id:clientId,redirect_uri:callback,code,code_verifier:verifier}).toString();
      const exchange=await app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:body});
      assert.equal(exchange.statusCode,200,'PKCE exchange failed after browser navigation');
      const token=exchange.json().access_token;
      assert.ok(token,'No access token');
      const initializeRequest={method:'POST',url:'/mcp',headers:{host:new URL(A).host,authorization:'Bearer '+token,accept:'application/json, text/event-stream'},payload:{
        jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'browser-fixture',version:'0.0.0'}},
      }};
      const initialize=await app.inject(initializeRequest);
      assert.equal(initialize.statusCode,200,'MCP initialize failed');
      // Reusing an authorization code revokes its descendant tokens. Check this
      // only after successful MCP initialization with the fresh token.
      const replay=await app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:body});
      assert.equal(replay.statusCode,400,'Authorization code replay accepted');
      const revoked=await app.inject(initializeRequest);
      assert.equal(revoked.statusCode,401,'Replayed code did not revoke its access token');
      console.log(JSON.stringify({case:spec.name,consent:current.postStatus,downstream:true,token:200,initialize:200,replay:400,revoked:401,result:'PASS'}));
    }
  } finally {
    current=undefined;
    await app.close();
    db.close();
  }
}

try {
  let port;
  await until(async()=>{try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0];return !!port}catch{return false}},'Chromium debugging endpoint unavailable',20000);
  const page=(await (await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(4000)})).json()).find(p=>p.type==='page');
  assert.ok(page,'Chromium page missing');
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})});
  socket.addEventListener('message',async e=>{
    const m=JSON.parse(e.data);
    if(m.id){
      const q=pending.get(m.id);
      if(q){clearTimeout(q.timer);pending.delete(m.id);m.error?q.reject(Error(m.error.message)):q.resolve(m.result)}
      return;
    }
    if(m.method==='Log.entryAdded' && current && hasCspViolation(m.params.entry.text)) current.cspViolations++;
    if(m.method!=='Fetch.requestPaused')return;
    const p=m.params,u=new URL(p.request.url);
    try {
      const ctx=current;
      if(!ctx){await fulfill(p,404,{});return}
      if(u.origin===A){
        // Forward the browser's real form POST and response bytes through the actual
        // Fastify routes. The authenticated fixture session is injected only here.
        const method=p.request.method;
        if(!['GET','POST'].includes(method)){await fulfill(p,405,{});return}
        const contentType=Object.entries(p.request.headers).find(([k])=>k.toLowerCase()==='content-type')?.[1];
        const result=await ctx.app.inject({method,url:u.pathname+u.search,
          headers:{host:new URL(A).host,cookie:ctx.cookie,...(contentType?{'content-type':contentType}:{})},
          ...(method==='POST'?{payload:p.request.postData??(await send('Network.getRequestPostData',{requestId:p.networkId})).postData}:{})});
        let body=result.body;
        if(method==='POST' && u.pathname==='/oauth/authorize'){
          ctx.postStatus=result.statusCode;ctx.postHeaders=result.headers;
          // Simulate automatic refresh being unavailable while preserving the
          // real renderer's anchor and every other response header.
          if(ctx.spec.manual)body=body.replace(/<meta http-equiv="refresh"[^>]*>/i,'');
        }
        await fulfill(p,result.statusCode,result.headers,body);
      }else if((u.origin===B||u.origin===D)&&u.pathname===fixturePath){
        ctx.firstHop=u;
        if(ctx.spec.chain)await fulfill(p,302,{Location:C+'/done'+u.search});
        else await fulfill(p,200,{'Content-Type':'text/html'},'<h1>Fixture callback received</h1>');
      }else if(u.origin===C&&u.pathname==='/done'){
        ctx.finalHop=u;
        await fulfill(p,200,{'Content-Type':'text/html'},'<h1>Fixture downstream received</h1>');
      }else await fulfill(p,404,{});
    }catch{
      // Never print callback URLs, code, cookies, form bodies or token values.
      handlerError=Error('Fixture HTTP interception failed');
      await send('Fetch.failRequest',{requestId:p.requestId,errorReason:'Failed'}).catch(()=>{});
    }
  });
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Fetch.enable',{patterns:[
    {urlPattern:'https://*.example.test/*',requestStage:'Request'},
    {urlPattern:'https://oauth-redirect.googleusercontent.com/*',requestStage:'Request'},
  ]});
  for(const spec of [
    {name:'legacy-single-hop',enabled:false,chain:false,decision:'approve'},
    {name:'legacy-chained-CSP',enabled:false,chain:true,blocked:true,decision:'approve'},
    {name:'candidate-automatic-approval',enabled:true,chain:true,decision:'approve'},
    {name:'candidate-manual-approval',enabled:true,chain:true,manual:true,decision:'approve'},
    {name:'candidate-denial',enabled:true,chain:true,decision:'deny'},
    {name:'non-Gemini-unchanged',enabled:true,other:true,chain:false,decision:'approve'},
  ]) {
    await runCase(spec);
    await send('Page.navigate',{url:'about:blank'});
    await pause(250);
  }
  console.log('ACTUAL_CANDIDATE_CHROMIUM_FIXTURE=6/6 PASS; REAL_GEMINI=NOT_TESTED');
} finally {
  if(socket){await send('Browser.close').catch(()=>{});socket.close()}
  browser.kill();
  await pause(500);
  await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250});
}
