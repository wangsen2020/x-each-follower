import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import Dexie from 'dexie';
import {createAgentRelayClient,createRelayRepository,connectionUrl} from '../src/features/grok/agent-relay-client.js';
function fixture(engine='codex'){
 let config={baseUrl:'http://127.0.0.1:8787',token:'private-token',bot:'session-a',engine,protocol:'unified',testedAt:1},state='completed',serial=0;
 const jobs=new Map(),requests=[];
 const repository={config:async()=>config,saveConfig:async c=>{config=c;},job:async id=>jobs.get(id),saveJob:async j=>jobs.set(j.id,j),reserve:async j=>{const old=[...jobs.values()].find(v=>v.key===j.key&&!v.delivered);if(old)return {job:old,created:false};jobs.set(j.id,j);return {job:j,created:true};}};
 const fetchImpl=async(url,options)=>{requests.push({url,options});const data=url.endsWith('/sessions')?(options.method==='POST'?{session:{id:'new-session',name:'Created'}}:{sessions:[{id:'session-a',name:'A'},{id:'session-b',name:'B'}]}):url.endsWith('/bots')?{bots:[{id:'session-a',name:'A'}]}:options.method==='POST'?{status:'queued'}:{jobId:url.split('/').at(-1),status:state,result:{text:'完整回复'}};return {ok:true,json:async()=>data};};
 const client=createAgentRelayClient({engine,repository,fetchImpl,uuid:()=>String(++serial)});
 return {client,repository,requests,jobs,setState:v=>{state=v;},setConfig:v=>{config=v;},get config(){return config;}};
}
for(const engine of ['grokbot','codex','antigravity'])test(engine+' uses one client with the correct prefix, session and normalized result',async()=>{
 const f=fixture(engine);const result=await f.client.generate('只分析这个样本',{botId:'session-b',onJobCreated:async receipt=>assert.ok(f.jobs.has(receipt.id))});assert.equal(result.text,'完整回复');
 const post=f.requests.find(r=>r.options.method==='POST');assert.equal(post.url,'http://127.0.0.1:8787/'+engine+'/jobs');const body=JSON.parse(post.options.body);assert.equal(body.sessionId,'session-b');assert.equal('bot' in body,false);assert.equal(f.config.bot,'session-a');assert.equal((await f.client.status()).token,undefined);
});
test('unknown task survives changed engine configuration, session, token and URL without being resubmitted',async()=>{
 const f=fixture();f.setState('unknown');const first=await f.client.generate('分析',{requestKey:'stable-key'});assert.equal(first.pending,true);
 await f.client.generate('分析',{requestKey:'stable-key'});assert.equal(f.requests.filter(r=>r.options.method==='POST').length,1);
 f.setConfig({...f.config,baseUrl:'https://another.example',token:'replacement',bot:'session-b'});f.setState('completed');const result=await f.client.resume(first.jobId);assert.equal(result.ok,true);
 const lookup=f.requests.at(-1);assert.match(lookup.url,/^http:\/\/127\.0\.0\.1:8787\/codex\/jobs\//);assert.equal(lookup.options.headers.authorization,'Bearer private-token');assert.equal(f.requests.filter(r=>r.options.method==='POST').length,1);
});
test('new client can recover a legacy unprefixed Grok task using its frozen protocol',async()=>{
 const f=fixture('antigravity');await f.repository.saveJob({id:'local:old',status:'unknown',connection:{port:9876,token:'legacy-token',bot:'old'}});
 const result=await f.client.resume('local:old');assert.equal(result.ok,true);assert.equal(f.requests.at(-1).url,'http://127.0.0.1:9876/jobs/old');assert.equal(f.requests.at(-1).options.method,undefined);
});
test('creating a session is explicit and unavailable for Grok; testing persists only after a completed reply',async()=>{
 const f=fixture();const created=await f.client.createSession(f.config,'New session');assert.equal(created.session.id,'new-session');assert.equal(JSON.parse(f.requests[0].options.body).name,'New session');
 const g=fixture('grokbot');await assert.rejects(g.client.createSession(g.config,'No'),/已有Bot/);assert.equal(g.requests.length,0);
 f.setState('unknown');const old=f.config;await assert.rejects(f.client.test({...f.config,bot:'session-b'}));assert.equal(f.config,old);
});
test('invalid endpoints never carry a token to a path, credential-bearing URL or non-local plaintext address',()=>{
 for(const baseUrl of ['http://remote.example:8787','https://a:b@example.com','https://example.com/codex','https://example.com?token=x'])assert.throws(()=>connectionUrl({baseUrl}));
 assert.equal(connectionUrl({port:9876}),'http://127.0.0.1:9876');assert.equal(connectionUrl({baseUrl:'https://relay.example/'}),'https://relay.example');
});
test('additive shared connection preserves the original Grok config and job rows and keeps engine sessions independent',async t=>{
 const db=new Dexie('xfollower-grok-local');db.version(1).stores({config:'id',jobs:'id,key'});await db.config.put({id:'local',port:9876,token:'old-secret',bot:'legacy-bot',botName:'Legacy',testedAt:42});await db.jobs.put({id:'local:existing',key:'legacy-key',status:'unknown',connection:{port:9876,token:'old-secret',bot:'legacy-bot'}});
 const grok=createRelayRepository(),codex=createRelayRepository('codex'),ag=createRelayRepository('antigravity');const old=await grok.config();assert.equal(old.bot,'legacy-bot');assert.equal(old.testedAt,42);
 await codex.saveConfig({...old,engine:'codex',protocol:'unified',bot:'codex-session',testedAt:43});assert.equal((await grok.config()).bot,'legacy-bot');assert.equal((await grok.config()).testedAt,42);assert.equal((await codex.config()).bot,'codex-session');assert.equal((await ag.config()).testedAt,null);assert.equal((await ag.config()).token,'old-secret');assert.equal((await codex.job('local:existing')).connection.bot,'legacy-bot');
 await ag.saveConfig({...await ag.config(),baseUrl:'https://changed.example',token:'new-secret',bot:'ag-session',testedAt:44});assert.equal((await grok.config()).testedAt,null);assert.equal((await codex.config()).testedAt,null);assert.equal((await grok.job('local:existing')).connection.token,'old-secret');
 db.close();
});

test('a terminal failed result remains recorded without masquerading as an ongoing generation',async()=>{
 const f=fixture();f.setState('failed');const result=await f.client.generate('sample');assert.equal(result.ok,false);assert.equal(result.pending,false);assert.equal(f.jobs.get(result.jobId).status,'failed');
});

 test('session menu labels collapse whitespace and controls, bound long text and retain stable IDs',async()=>{
 const {sessionLabel}=await import('../src/features/grok/agent-relay-client.js');
 assert.equal(sessionLabel(' \n\t标题\u200b '),'标题');
 assert.match(sessionLabel('  ','thread-id'),/未命名会话.*thread-id/);
 assert.equal(Array.from(sessionLabel('中'.repeat(5000))).length,48);
 const client=createAgentRelayClient({engine:'codex',fetchImpl:async()=>({ok:true,json:async()=>({sessions:[{id:'stable',name:'\n'.repeat(10)+'长'.repeat(9000)}]})})});
 const rows=await client.list({baseUrl:'http://127.0.0.1:8787',token:'test',engine:'codex'});
 assert.equal(rows[0].id,'stable');assert.equal(rows[0].name.length,48);assert.ok(!rows[0].name.includes('\n'));
 });
