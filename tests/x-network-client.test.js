import {readNativeProfileResponse} from '../src/platform/x/network-client.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildXRequest,createXNetworkClient,executeXRequestOnPage,redactNetworkError} from '../src/platform/x/network-client.js';

const headers={authorization:'Bearer fixture-secret','x-csrf-token':'fixture-csrf','x-client-transaction-id':'stale-transaction','unexpected':'do-not-forward'};
const template={origin:'https://x.com',queryId:'runtime-query',headers,variables:'{"userId":"1","count":20,"cursor":"old"}'};
async function page(action,handler){
 const old=Object.fromEntries(['window','location','document','fetch'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 const calls=[],signatures=[];
 Object.assign(globalThis,{window:{__XEF_GENERATE_TRANSACTION_ID:async(method,path)=>{signatures.push({method,path});return `${method}:${path}`;}},location:{origin:'https://x.com'},document:{scripts:[{src:'https://abs.twimg.com/responsive-web/client-web/main.abc123.js'}]},fetch:async(url,init)=>{calls.push({url:String(url),init});return handler?handler(String(url),init):new Response('{"data":{"ok":true}}');}});
 try{return await action({calls,signatures});}finally{for(const[k,v]of Object.entries(old)){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}}
}
test('transport permits named operations and official web origins only',()=>{
 assert.throws(()=>buildXRequest('Anything',template),/不支持/);
 assert.throws(()=>buildXRequest('Followers',{...template,origin:'https://evil.example'}),/来源无效/);
 assert.throws(()=>buildXRequest('Followers',{...template,op:'Following'}),/未捕获/);
 assert.throws(()=>buildXRequest('DeleteTweet',template,{tweet_id:123}),/字符串/);
});
test('query builder removes stale pagination and forwards only the session header allowlist',()=>{
 const req=buildXRequest('Followers',template,{userId:'999',cursor:'next'});
 const vars=JSON.parse(new URL(req.path,'https://x.com').searchParams.get('variables'));assert.deepEqual(vars,{userId:'999',count:20,cursor:'next'});
 assert.equal(req.method,'GET');assert.equal(req.headers.unexpected,undefined);assert.equal(req.headers['x-client-transaction-id'],undefined);
 const first=buildXRequest('Followers',template,{userId:'999'});assert.equal(JSON.parse(new URL(first.path,'https://x.com').searchParams.get('variables')).cursor,undefined);
});
test('profile and relationship writes share form construction with validated targets',()=>{
 for(const[op,path]of [['Follow','friendships/create.json'],['Unfollow','friendships/destroy.json'],['Block','blocks/create.json'],['Unblock','blocks/destroy.json']]){
  const req=buildXRequest(op,template,{id:'123',handle:'@tester'});assert.equal(req.method,'POST');assert.equal(req.path,'/i/api/1.1/'+path);assert.equal(new URLSearchParams(req.body).get('screen_name'),'tester');
 }
 assert.throws(()=>buildXRequest('Block',template,{handle:'invalid name'}),/无效/);
});
test('page transport generates fresh GET signatures and sends credentials without duplicating requests',async()=>{
 await page(async({calls,signatures})=>{
  const result=await executeXRequestOnPage(buildXRequest('Following',template,{userId:'123'}));assert.equal(result.status,200);assert.equal(result.error,'');assert.equal(calls.length,1);
  assert.deepEqual(signatures,[{method:'GET',path:'/i/api/graphql/runtime-query/Following'}]);assert.equal(calls[0].init.credentials,'include');assert.equal(calls[0].init.__xefInternal,true);assert.equal(calls[0].init.headers['x-client-transaction-id'],'GET:/i/api/graphql/runtime-query/Following');
 });
});
test('mutation discovers current operation ID and only sends one POST JSON',async()=>{
 await page(async({calls,signatures})=>{
  const result=await executeXRequestOnPage(buildXRequest('DeleteTweet',template,{tweet_id:'2112818349029900798'}));assert.equal(result.status,200);assert.equal(calls.length,2);
  assert.equal(calls[1].url,'https://x.com/i/api/graphql/new-runtime-id/DeleteTweet');assert.equal(calls[1].init.method,'POST');assert.deepEqual(JSON.parse(calls[1].init.body),{queryId:'new-runtime-id',variables:{tweet_id:'2112818349029900798'}});assert.equal(signatures[0].method,'POST');
 },url=>url.includes('main.')?new Response('queryId:"new-runtime-id",operationName:"DeleteTweet",operationType:"mutation"'):new Response('{"data":{}}'));
});
test('missing mutation metadata never sends a deletion and cannot invent an operation ID',async()=>{
 await page(async({calls})=>{const r=await executeXRequestOnPage(buildXRequest('DeleteTweet',template,{tweet_id:'123'}));assert.equal(r.status,0);assert.equal(r.attempted,false);assert.equal(calls.length,1);},()=>new Response('no supported mutation'));
});

test('RemoveFollower discovers its own runtime ID, posts exact User Rest ID once and signs the mutation',async()=>{
 assert.throws(()=>buildXRequest('RemoveFollower',template,{target_user_id:123}),/字符串/);
 await page(async({calls,signatures})=>{
  const r=await executeXRequestOnPage(buildXRequest('RemoveFollower',template,{target_user_id:'2114587898162950144'}));
  assert.equal(r.status,200);assert.equal(calls.length,2);
  assert.equal(calls[1].url,'https://x.com/i/api/graphql/runtime-remove-id/RemoveFollower');
  assert.deepEqual(JSON.parse(calls[1].init.body),{queryId:'runtime-remove-id',variables:{target_user_id:'2114587898162950144'}});
  assert.equal(signatures[0].method,'POST');
 },url=>url.includes('main.')?new Response('queryId:"runtime-remove-id",operationName:"RemoveFollower",operationType:"mutation"'):new Response('{"data":{"remove_follower":true}}'));
});
test('write timeouts do not retry and never expose captured auth in errors',async()=>{
 await page(async({calls})=>{const r=await executeXRequestOnPage(buildXRequest('Block',template,{id:'123'}));assert.equal(r.status,0);assert.equal(r.attempted,true);assert.equal(calls.length,1);assert.equal(r.error.includes('fixture-secret'),false);assert.equal(r.error.includes('fixture-csrf'),false);},()=>{throw Error('timeout Bearer fixture-secret fixture-csrf');});
 assert.equal(redactNetworkError('fixture-csrf Bearer fixture-secret',headers).includes('fixture'),false);
});
test('GraphQL errors on HTTP 200 are failures and rate-limit backoff remains visible',async()=>{
 await page(async()=>{const r=await executeXRequestOnPage(buildXRequest('Followers',template,{}));assert.equal(r.status,200);assert.match(r.error,/denied/);},()=>new Response('{"errors":[{"message":"denied"}]}'));
 await page(async()=>{const r=await executeXRequestOnPage(buildXRequest('Follow',template,{id:'123'}));assert.equal(r.status,429);assert.equal(r.retryAfterSeconds,7200);},()=>new Response('{"errors":[{"message":"rate limited"}]}',{status:429,headers:{'retry-after':'7200'}}));
});
test('the injected leaf rejects forged absolute or unapproved paths before fetching',async()=>{
 await page(async({calls})=>{const req=buildXRequest('Followers',template,{});req.path='https://evil.example/steal';const r=await executeXRequestOnPage(req);assert.equal(r.status,0);assert.equal(r.attempted,false);assert.equal(calls.length,0);});
});
test('public client keeps read APIs explicit and treats execution-context loss as uncertain delivery',async()=>{
 const api={storage:{local:{get:async()=>({networkTemplates:{UserByScreenName:template,Followers:template,Following:template,UserTweets:template,contentPageQuery:template}})}},scripting:{executeScript:async req=>{
  if(req.func===executeXRequestOnPage)throw Error('execution context lost');return [{result:true}];
 }}};
 const client=createXNetworkClient(api);for(const key of ['profile','userPosts','followers','following','follow','unfollow','block','unblock','ownAnalytics','deleteOwnPost'])assert.equal(typeof client[key],'function');
 const r=await client.block(1,{id:'123'});assert.equal(r.attempted,true);assert.match(r.error,/context lost/);
 assert.equal((await client.query(1,'DeleteTweet',{})).attempted,false);
});

test('delete metadata is cached per exact client script while every write remains individually signed',async()=>{
 await page(async({calls,signatures})=>{
  for(const id of ['11','12']){const r=await executeXRequestOnPage(buildXRequest('DeleteTweet',template,{tweet_id:id}));assert.equal(r.status,200);assert.ok(Number.isFinite(r.timings.requestMs));}
  assert.equal(calls.filter(x=>x.url.includes('main.')).length,1);assert.equal(calls.filter(x=>x.init?.method==='POST').length,2);assert.equal(signatures.length,2);
  document.scripts[0].src='https://abs.twimg.com/responsive-web/client-web/main.newhash.js';const r=await executeXRequestOnPage(buildXRequest('DeleteTweet',template,{tweet_id:'13'}));assert.equal(r.status,200);assert.equal(calls.filter(x=>x.url.includes('main.')).length,2);assert.equal(calls.filter(x=>x.init?.method==='POST').length,3);
 },url=>url.includes('main.')?new Response('queryId:"runtime-delete-id",operationName:"DeleteTweet",operationType:"mutation"'):new Response('{"data":{}}'));
});

test('queue reuse requires current target and fresh native response, verification remains uncached',async()=>{
 await page(async()=>{
   location.pathname='/target';
   const cached={handle:'target',path:'/target',at:Date.now(),json:{data:{user:{result:{rest_id:'123'}}}}};
   window.__xefNativeProfile=cached;
   assert.equal(readNativeProfileResponse('TARGET').source,'native-page');
   assert.equal(readNativeProfileResponse('other'),null);
   cached.at-=31000;assert.equal(readNativeProfileResponse('target'),null);
   cached.at=Date.now();location.pathname='/other';assert.equal(readNativeProfileResponse('target'),null);
 });
 let nativeCalls=0,networkCalls=0;
 const api={storage:{local:{get:async()=>({networkTemplates:{UserByScreenName:template}})}},scripting:{executeScript:async req=>{
   if(req.func===readNativeProfileResponse){nativeCalls++;return [{result:{status:200,json:{data:{}},source:'native-page'}}];}
   if(req.func===executeXRequestOnPage){networkCalls++;return [{result:{status:200,json:{data:{}}}}];}
   return [{result:true}];
 }}};
 const client=createXNetworkClient(api);
 assert.equal((await client.profile(1,'target',{preferPageResponse:true})).source,'native-page');
 assert.equal(networkCalls,0);await client.profile(1,'target');assert.equal(nativeCalls,1);assert.equal(networkCalls,1);
});
test('HTTP rate-limit evidence preserves server quota and reset separately from retry-after',async()=>{
 await page(async()=>{
   const r=await executeXRequestOnPage(buildXRequest('UserByScreenName',template,{screen_name:'target'}));
   assert.equal(r.status,429);assert.equal(r.operation,'UserByScreenName');
   assert.deepEqual(r.rateLimit,{limit:150,remaining:0,resetAt:1792867917000});
 },()=>new Response('Rate limit exceeded',{status:429,headers:{'x-rate-limit-limit':'150','x-rate-limit-remaining':'0','x-rate-limit-reset':'1792867917'}}));
});

test('identical concurrent reads share one request and return independent results; later reads are fresh',async()=>{
 let release;const gate=new Promise(r=>release=r);
 await page(async({calls})=>{
   const req=buildXRequest('Followers',template,{userId:'123',cursor:'one'});
   const a=executeXRequestOnPage(req),b=executeXRequestOnPage({...req});
   await new Promise(r=>setImmediate(r));assert.equal(calls.length,1);release();
   const [x,y]=await Promise.all([a,b]);assert.deepEqual(x,y);x.json.data.changed=true;assert.equal(y.json.data.changed,undefined);
   await executeXRequestOnPage(req);assert.equal(calls.length,2);assert.equal(window.__xefPendingReads.size,0);
 },async()=>{await gate;return new Response('{"data":{}}');});
});

test('different cursors, targets and session headers never coalesce',async()=>{
 await page(async({calls})=>{
   const a=buildXRequest('Followers',template,{userId:'123',cursor:'one'});
   const b=buildXRequest('Followers',template,{userId:'123',cursor:'two'});
   const c=buildXRequest('Followers',template,{userId:'456',cursor:'one'});
   const d={...a,headers:{...a.headers,'x-csrf-token':'different-session'}};
   await Promise.all([a,b,c,d].map(executeXRequestOnPage));assert.equal(calls.length,4);
 });
});

test('writes are never merged and invalidate pending reads before and after mutation',async()=>{
 let release;const gate=new Promise(r=>release=r);let reads=0;
 await page(async({calls})=>{
   const read=buildXRequest('UserByScreenName',template,{screen_name:'target'});
   window.__xefNativeProfile={at:Date.now()};
   const old=executeXRequestOnPage(read);await new Promise(r=>setImmediate(r));
   const write=buildXRequest('Follow',template,{id:'123'});
   await Promise.all([executeXRequestOnPage(write),executeXRequestOnPage(write)]);
   assert.equal(window.__xefNativeProfile,null);
   const fresh=await executeXRequestOnPage(read);assert.equal(fresh.json.read,2);
   release();await old;assert.equal(calls.length,4);assert.equal(window.__xefPendingReads.size,0);
 },async(url,init)=>{if(init.method==='GET'){const n=++reads;if(n===1)await gate;return new Response(JSON.stringify({read:n}));}return new Response('{"ok":true}');});
});

test('failed reads leave no pending cache and permit the next attempt',async()=>{
 await page(async({calls})=>{
   const req=buildXRequest('Followers',template,{userId:'123'});
   const results=await Promise.all([executeXRequestOnPage(req),executeXRequestOnPage(req)]);
   assert.equal(results[0].status,0);assert.equal(calls.length,1);
   await executeXRequestOnPage(req);assert.equal(calls.length,2);assert.equal(window.__xefPendingReads.size,0);
 },()=>{throw Error('offline');});
});
test('query can pin a native page template without reading a competing global cache',async()=>{
 const native={...template,op:'HomeLatestTimeline',queryId:'same-page',features:'{"required_flag":true}'};let sent;
 const api={storage:{local:{get:async()=>{throw Error('global cache must not be used');}}},scripting:{executeScript:async args=>{if(args.func===executeXRequestOnPage){sent=args.args[0];return [{result:{status:200,json:{data:{}}}}];}return [{result:true}];}}};
 const r=await createXNetworkClient(api).query(7,'HomeLatestTimeline',{cursor:'next'},{template:native});
 assert.equal(r.status,200);const url=new URL(sent.path,'https://x.com');assert.match(url.pathname,/same-page/);assert.equal(JSON.parse(url.searchParams.get('features')).required_flag,true);assert.equal(JSON.parse(url.searchParams.get('variables')).cursor,'next');
});
test('home pagination supplies required includePromotedContent while preserving explicit false',()=>{
 for(const op of ['HomeTimeline','HomeLatestTimeline'])for(const flag of [undefined,null,true,false]){
  const request=buildXRequest(op,{...template,op,variables:JSON.stringify({count:20,includePromotedContent:flag})},{cursor:'next'});
  const vars=JSON.parse(new URL(request.path,'https://x.com').searchParams.get('variables'));
  assert.equal(vars.includePromotedContent,typeof flag==='boolean'?flag:true);assert.equal(vars.cursor,'next');
 }
 const request=buildXRequest('Followers',template,{cursor:'next'});assert.equal(Object.hasOwn(JSON.parse(new URL(request.path,'https://x.com').searchParams.get('variables')),'includePromotedContent'),false);
});
