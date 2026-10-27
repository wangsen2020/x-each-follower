import test from 'node:test';
import assert from 'node:assert/strict';
import {createGrokBotRelay,relayOrigin,withGrokBotFallback,BOT_POLL_MS} from '../src/features/grok/grok-bot-relay.js';

function fixture(fetcher){
  let connection,clock=1000,serial=0;const jobs=new Map(),calls=[],sleeps=[];
  const store={connection:async()=>connection,saveConnection:async c=>{connection=structuredClone(c)},disconnect:async()=>{connection=undefined},jobs:async()=>[...jobs.values()].map(j=>structuredClone(j)),saveJob:async j=>{jobs.set(j.id,structuredClone(j))}};
  const service=createGrokBotRelay({store,now:()=>clock,uuid:()=>`job-${++serial}`,sleep:async ms=>{sleeps.push(ms);clock+=ms},fetchImpl:async(url,options)=>{calls.push({url,options});if(url.endsWith('/v1/health'))return Response.json({provider:'grok-bot',protocolVersion:1,botName:'测试Bot'});return fetcher(url,options,jobs)}});
  return {service,store,jobs,calls,sleeps,bind:()=>service.connect({origin:'https://relay.example',token:'a'.repeat(48)}),activate:async()=>{await store.saveConnection({...connection,testedAt:1000,enabled:true})}};
}

test('queue checkpoint retains the reserved Bot ID before POST and on a deduplicated resume',async()=>{
  let savedId,posts=0;const checkpoints=[];
  const f=fixture((_url,options,jobs)=>{assert.equal(savedId,[...jobs.keys()][0]);if(options.method==='POST')posts++;return Response.json({jobId:savedId,status:'accepted'});});
  await f.bind();await f.activate();
  const options={timeoutMs:0,onJobCreated:async job=>{assert.equal(f.jobs.has(job.id),true);savedId=job.id;checkpoints.push(job.id);}};
  const first=await f.service.generate('one queue source',options);
  const resumed=await f.service.generate('one queue source',options);
  assert.equal(first.jobId,resumed.jobId);assert.equal(posts,1);assert.deepEqual(checkpoints,[first.jobId,first.jobId]);
});

test('a failed queue checkpoint prevents the paid Bot dispatch',async()=>{
  const f=fixture(()=>assert.fail('must not dispatch before the owner saves its ID'));
  await f.bind();await f.activate();
  await assert.rejects(f.service.generate('source',{onJobCreated:async()=>{throw Error('checkpoint failed');}}),/checkpoint failed/);
  assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
});
test('relay permits only an HTTPS origin without credentials or query',()=>{
  assert.equal(relayOrigin(' https://relay.example/ '),'https://relay.example');
  for(const url of ['http://relay.example','https://a:b@relay.example','https://relay.example/path','https://relay.example?token=secret','https://relay.example/#a'])assert.throws(()=>relayOrigin(url));
});
test('ordinary errors and unknown results never trigger Bot fallback',async()=>{
  let queried=0;const service={status:async()=>{queried++;return {enabled:true}},generate:async()=>assert.fail('must not generate')};
  for(const primary of [{ok:false,reason:'network'},{ok:false,pending:true},{ok:false,quotaExhausted:true,channel:'grok.com'},{ok:false,quotaExhausted:true,channel:'x.com',generationAttempted:true}])assert.equal(await withGrokBotFallback(primary,'prompt',{service}),primary);
  assert.equal(queried,0);
});
test('only confirmed X quota exhaustion uses the enabled relay',async()=>{
  const primary={ok:false,quotaExhausted:true,channel:'x.com'};
  const calls=[];const service={status:async()=>({enabled:true}),generate:async(p,o)=>{calls.push(p);return {ok:true,text:'done'}}};
  assert.equal((await withGrokBotFallback(primary,'original prompt',{service})).text,'done');assert.deepEqual(calls,['original prompt']);
});
test('failed rebind leaves previous credentials and token never appears in public status',async()=>{
  const f=fixture(()=>Response.json({}));await f.bind();await f.activate();
  await assert.rejects(f.service.connect({origin:'https://relay.example/path',token:'b'.repeat(48)}));
  assert.equal((await f.service.status()).enabled,true);assert.equal(JSON.stringify(await f.service.status()).includes('aaaa'),false);
});
test('job is saved before sending; accepted response polls at thirty seconds then returns full result',async()=>{
  const f=fixture((url,opts,jobs)=>{
    if(opts.method==='POST'){const input=JSON.parse(opts.body);assert.ok(jobs.has(input.jobId));return Response.json({jobId:input.jobId,status:'accepted'},{status:202})}
    return Response.json({jobId:[...jobs.keys()][0],status:'completed',result:'完整生成结果'});
  });await f.bind();await f.activate();
  const result=await f.service.generate('prompt');assert.equal(result.text,'完整生成结果');assert.deepEqual(f.sleeps,[BOT_POLL_MS]);assert.equal(f.calls[1].options.redirect,'error');assert.equal((await f.service.jobs())[0].result,'完整生成结果');
});
test('lost POST response is retained and reopening only queries the original job',async()=>{
  let posts=0;const f=fixture((url,opts,jobs)=>{if(opts.method==='POST'){posts++;throw Error('lost response')}return Response.json({jobId:[...jobs.keys()][0],status:'completed',result:'late result'})});await f.bind();await f.activate();
  const first=await f.service.generate('prompt');assert.equal(first.pending,true);
  const second=await f.service.generate('prompt');assert.equal(second.text,'late result');assert.equal(posts,1);assert.equal(second.jobId,first.jobId);
});
test('malformed remote result does not overwrite saved job or mark a test as verified',async()=>{
  const f=fixture((url,opts,jobs)=>Response.json(opts.method==='POST'?{jobId:JSON.parse(opts.body).jobId,status:'accepted'}:{jobId:[...jobs.keys()][0],status:'completed',result:''}));await f.bind();
  const result=await f.service.generate('test',{test:true,timeoutMs:0});assert.equal(result.pending,true);
  await assert.rejects(f.service.query(result.jobId),/有效结果/);assert.equal((await f.service.status()).enabled,false);assert.equal((await f.service.jobs())[0].status,'accepted');
});
test('completed test enables its connection; staged rebind preserves the old connection until its own test completes',async()=>{
  const f=fixture((url,opts,jobs)=>Response.json(opts.method==='POST'?{jobId:JSON.parse(opts.body).jobId,status:'accepted'}:{jobId:[...jobs.keys()][0],status:'completed',result:'连接成功'}));await f.bind();
  const result=await f.service.generate('test',{test:true,timeoutMs:0});await f.service.query(result.jobId);assert.equal((await f.service.status()).enabled,true);
  await f.bind();assert.equal((await f.service.status()).enabled,true);assert.equal((await f.service.status()).pendingOrigin,'https://relay.example');await f.service.query(result.jobId);assert.equal((await f.service.status()).pendingOrigin,'https://relay.example');
});

test('a healthy new endpoint whose generation fails cannot replace the previously verified connection',async()=>{
  const f=fixture((url,options)=>Response.json({jobId:JSON.parse(options.body).jobId,status:'failed',reasonCode:'REJECTED'}));await f.bind();await f.activate();
  await f.service.connect({origin:'https://new.example',token:'b'.repeat(48)});
  const result=await f.service.generate('test replacement',{test:true,timeoutMs:0});assert.equal(result.ok,false);
  const status=await f.service.status();assert.equal(status.origin,'https://relay.example');assert.equal(status.enabled,true);assert.equal(status.pendingOrigin,'https://new.example');
});


test('Bot default waits five minutes and retains thirty-second polling without re-submitting',async()=>{
  let polls=0,posts=0;const f=fixture((url,options,jobs)=>{
    const jobId=[...jobs.keys()][0];
    if(options.method==='POST'){posts++;return Response.json({jobId,status:'accepted'});}
    polls++;return Response.json(polls===10?{jobId,status:'completed',result:'late at five minutes'}:{jobId,status:'accepted'});
  });await f.bind();await f.activate();
  const result=await f.service.generate('long generation');
  assert.equal(result.text,'late at five minutes');assert.equal(posts,1);assert.equal(polls,10);
  assert.deepEqual(f.sleeps,Array(10).fill(30000));
});
