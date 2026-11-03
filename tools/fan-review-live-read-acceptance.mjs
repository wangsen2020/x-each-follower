import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createXNetworkClient} from '../src/platform/x/network-client.js';
import {parseNetworkUsers} from '../src/features/relationships/network-api.js';
import {readProfileBundle} from '../src/platform/x/page-reader.js';
import {readScoredPosts} from '../src/features/follow-queue/scored-posts.js';
import {selectQueueScreeningPosts,detectLocalHardRule} from '../src/features/relationships/follow-review-engine.js';

// Attach after tools/cdp-session.ps1. Only one inactive test-owned tab is created;
// all signed X operations are constrained to GET queries, with no AI requests.
const targets=await(await fetch('http://127.0.0.1:9222/json/list')).json();
const panel=targets.find(target=>target.type==='page'&&target.url.startsWith('chrome-extension://')&&target.url.includes('/panel.html'));
assert.ok(panel,'Existing authenticated extension panel required');
const socket=new WebSocket(panel.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
let serial=0;const pending=new Map();
socket.onmessage=event=>{const reply=JSON.parse(event.data),task=pending.get(reply.id);if(task){pending.delete(reply.id);clearTimeout(task.timer);reply.error?task.reject(Error(reply.error.message)):task.resolve(reply.result);}};
function call(method,params){return new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>{pending.delete(id);reject(Error('Live read CDP timeout'));},45000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});}
async function expression(source){const result=await call('Runtime.evaluate',{expression:source,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;}
const evaluate=(fn,...args)=>expression(`(${fn.toString()})(...${JSON.stringify(args)})`);
const api={storage:{local:{get:keys=>evaluate(keys=>chrome.storage.local.get(keys),keys),set:async()=>{}}},scripting:{
  executeScript:async options=>{
    if(options.func?.name==='executeXRequestOnPage'){
      assert.equal(options.args[0].kind,'query','Live acceptance forbids mutations');assert.equal(options.args[0].method,'GET');
    }
    const {func,...data}=options;
    return expression(`chrome.scripting.executeScript({...${JSON.stringify(data)}${func?`,func:(${func.toString()})`:''}})`);
  }
}};
let tab;
try{
  const before=await evaluate(async()=>({version:chrome.runtime.getManifest().version,binding:(await chrome.storage.local.get('followQueueBinding')).followQueueBinding}));
  assert.equal(before.binding?.activated,true,'A confirmed owner is required');
  const file='C:/jtmp/xf-fan-review-implementation/live-data-before/x-each-follower-follow-queue--jobs.jsonl';
  const candidate=(await fs.readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).find(job=>job.accountId===before.binding.accountId&&job.state==='pending'&&/^\d+$/.test(job.targetUserId||'')&&/^[a-z0-9_]{1,15}$/i.test(job.handle)&&job.profile?.bio);
  assert.ok(candidate,'Snapshot must contain a stable queued target');
  tab=await evaluate(handle=>chrome.tabs.create({url:'https://x.com/'+encodeURIComponent(handle),active:false}),candidate.handle);
  const viewer=async()=>(await api.scripting.executeScript({target:{tabId:tab.id},func:()=>document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.split('/')[1]||'',args:[]}))?.[0]?.result;
  for(let i=0;i<60;i++){if(await viewer())break;await new Promise(resolve=>setTimeout(resolve,500));}
  const guard=async()=>{
    const current=(await api.storage.local.get('followQueueBinding')).followQueueBinding;
    assert.equal(current.accountId,before.binding.accountId);assert.equal(String(await viewer()).toLowerCase(),before.binding.handle.toLowerCase());
  };
  await guard();
  const client=createXNetworkClient(api);
  const ownerResponse=await client.profile(tab.id,before.binding.handle,{refreshAvailability:true,preferPageResponse:false});
  assert.equal(ownerResponse.status,200,ownerResponse.error);
  const owner=parseNetworkUsers(ownerResponse.json).find(user=>user.handle.toLowerCase()===before.binding.handle.toLowerCase());
  assert.equal(owner?.id,before.binding.accountId,'Live viewer must resolve to the bound stable owner ID');
  const response=await client.profile(tab.id,candidate.handle,{refreshAvailability:true,preferPageResponse:false});
  assert.equal(response.status,200,response.error);
  const target=parseNetworkUsers(response.json).find(user=>user.handle.toLowerCase()===candidate.handle.toLowerCase());
  assert.equal(target?.id,candidate.targetUserId,'The queued handle must still identify the frozen user');
  assert.equal(typeof target.relationship.following,'boolean');assert.equal(typeof target.relationship.followedBy,'boolean');
  const timeline=await readScoredPosts({api,tabId:tab.id,userId:target.id,handle:target.handle,guard});
  const dom=(await api.scripting.executeScript({target:{tabId:tab.id},func:readProfileBundle,args:[target.handle,20]}))?.[0]?.result;
  const posts=selectQueueScreeningPosts(timeline?.posts?.length?timeline.posts:dom?.posts,target.handle,10);
  assert.ok(posts.length>0&&posts.length<=10,'Read actual authored non-pinned posts');
  await guard();
  const localRule=detectLocalHardRule(target,posts);
  const result={at:new Date().toISOString(),sourceVersion:JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version,
    loadedVersion:before.version,ownerStableIdVerified:true,targetStableIdVerified:true,target:target.handle,
    relationship:target.relationship,posts:posts.length,postSource:timeline?.posts?.length?'UserOriginalsTimeline':'profile DOM',
    localRule:{blocked:localRule.blocked,category:localRule.category},signedOperations:'GET queries only',aiRequests:0,followRequests:0,removalRequests:0,
    note:'Current source readers exercised on authenticated live X; loaded extension was not reloaded or replaced.'};
  const folder=path.resolve(import.meta.dirname,'../artifacts/fan-review-live-read');await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  if(tab)await evaluate(id=>chrome.tabs.remove(id),tab.id).catch(()=>{});
  socket.close();
}
