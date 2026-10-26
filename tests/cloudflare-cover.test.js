import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudflareCoverService,CLOUDFLARE_IMAGE_MODEL} from '../src/features/publishing/cloudflare-cover.js';
import {createCloudflareImagesController} from '../src/entries/panel/composables/useCloudflareImages.js';
const accountId='a'.repeat(32),token='test-token-not-a-real-credential';
const cover={dataUrl:'data:image/png;base64,AAAA',width:1200,height:480,provider:'cloudflare'};
const ok=()=>({status:200,body:{success:true,result:{image:'AAAA'}}});
function fixture(responses,{initial,normalize=async()=>cover}={}){
  let value=initial;const calls=[];
  const credentials={get:async()=>value,put:async row=>{value=row;},clear:async()=>{value=undefined;}};
  const service=createCloudflareCoverService({credentials,fetchImpl:async(url,options)=>{calls.push({url,options});const r=responses.shift();return {ok:r.status<400,status:r.status,json:async()=>r.body};},normalize});
  return {service,calls,value:()=>value};
}
test('binding is persisted only after a real image response is decoded, and status never returns secrets',async()=>{
  let release;const decoding=new Promise(r=>{release=r;});
  const f=fixture([ok(),ok()],{normalize:async()=>{await decoding;return cover;}});
  const binding=f.service.connect({accountId,token});
  await new Promise(r=>setImmediate(r));assert.equal(f.value(),undefined);
  release();const result=await binding;assert.deepEqual(result.cover,cover);assert.equal(result.connected,true);
  assert.ok((await f.service.status()).testedAt);assert.equal(JSON.stringify(await f.service.status()).includes(token),false);
  assert.ok(f.calls[1].url.includes(`/accounts/${accountId}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`));
  assert.equal(f.calls[1].options.headers.Authorization,'Bearer '+token);
  const imageRequest=JSON.parse(f.calls[1].options.body);
  assert.match(imageRequest.prompt,/editorial poster/);
  assert.match(imageRequest.prompt,/5:2/);
  assert.match(imageRequest.prompt,/No text or watermarks/);
  await f.service.disconnect();assert.equal((await f.service.status()).connected,false);
});

test('status refresh restores binding without resetting an in-progress wizard',async()=>{
  let connected=true;
  const c=createCloudflareImagesController({service:{status:async()=>({connected,accountId})},api:{}});
  c.accountId.value='replacement';c.token.value='unsaved';c.step.value=3;
  await c.refreshStatus();assert.equal(c.connected.value,true);assert.equal(c.boundAccountId.value,accountId);
  assert.equal(c.accountId.value,'replacement');assert.equal(c.token.value,'unsaved');assert.equal(c.step.value,3);
  connected=false;await c.refreshStatus();assert.equal(c.connected.value,false);assert.equal(c.boundAccountId.value,'');
});
test('permission, quota and invalid image failures do not bind or replace a working connection',async()=>{
  const initial={accountId,token,testedAt:'2026-10-26T00:00:00Z'};
  for(const responses of [[{status:403,body:{errors:[{message:token}]}}],[ok(),{status:429,body:{success:false}}],[ok(),{status:200,body:{success:true,result:{}}}]]){
    const f=fixture(responses,{initial});
    await assert.rejects(f.service.connect({accountId:'b'.repeat(32),token:'replacement'}),e=>!e.message.includes(token));assert.equal(f.value(),initial);
  }
  const f=fixture([ok(),ok()],{normalize:async()=>{throw Error('invalid image');}});
  await assert.rejects(f.service.connect({accountId,token}),/invalid image/);assert.equal(f.value(),undefined);
});
test('missing credentials do not make a model request; normal generation does not resurrect an unbound connection',async()=>{
  const f=fixture([]);assert.equal((await f.service.generate({prompt:'cover'})).connectionRequired,true);assert.equal(f.calls.length,0);
  let release;const pending=new Promise(r=>{release=r;});
  const running=fixture([ok()],{initial:{accountId,token,testedAt:'today'},normalize:async()=>{await pending;return cover;}});
  const generation=running.service.generate({prompt:'cover'});await new Promise(r=>setImmediate(r));await running.service.disconnect();release();await generation;
  assert.equal((await running.service.status()).connected,false);
});
test('wizard validates each step, rejects denied access and only reports success after image test resolves',async()=>{
  let saves=0,allowed=false,resolve;
  const pending=new Promise(r=>{resolve=r;});
  const service={status:async()=>({connected:false,accountId:''}),connect:async()=>{saves++;await pending;return {accountId,cover};},disconnect:async()=>{}};
  const c=createCloudflareImagesController({service,api:{permissions:{contains:async()=>false,request:async()=>allowed}}});
  await c.open();assert.equal(c.step.value,1);c.next();c.next();assert.equal(c.step.value,2);assert.match(c.error.value,/32位/);
  c.accountId.value=accountId;c.next();assert.equal(c.step.value,3);c.token.value=token;
  await c.connect();assert.equal(saves,0);assert.match(c.error.value,/访问权限/);
  allowed=true;const connecting=c.connect();await new Promise(r=>setImmediate(r));assert.equal(c.connected.value,false);assert.equal(c.step.value,3);
  await c.connect();assert.equal(saves,1);c.close();assert.equal(c.isOpen.value,true);
  resolve();await connecting;assert.equal(c.token.value,'');assert.equal(c.connected.value,true);assert.equal(c.step.value,4);assert.equal(c.preview.value,cover.dataUrl);
});
test('reopen, failed replacement, retry and unbind preserve the correct binding state',async()=>{
  const f=fixture([ok(),ok(),ok(),{status:403,body:{success:false}},ok(),ok()]);
  const c=createCloudflareImagesController({service:f.service,api:{}});
  await c.open();c.next();c.accountId.value=accountId;c.next();c.token.value=token;await c.connect();c.close();await c.open();assert.equal(c.step.value,4);
  c.rebind();c.next();c.accountId.value='b'.repeat(32);c.next();c.token.value='replacement';await c.connect();assert.equal(c.step.value,3);assert.equal(c.connected.value,true);assert.equal(c.boundAccountId.value,accountId);assert.match(c.error.value,/权限不足/);
  await c.connect();assert.equal(c.step.value,4);assert.equal(c.boundAccountId.value,'b'.repeat(32));
  await c.disconnect();assert.equal(c.connected.value,false);assert.equal(c.step.value,1);assert.equal(c.token.value,'');c.close();await c.open();assert.equal(c.step.value,1);
});
