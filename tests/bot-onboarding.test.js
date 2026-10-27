import test from 'node:test';
import assert from 'node:assert/strict';
import {createBotOnboarding,SETUP_KEY,SETUP_VAULT_KEY} from '../src/features/grok/bot-onboarding.js';

function storage(){const values={};return {values,get:async key=>({[key]:structuredClone(values[key])}),set:async patch=>Object.assign(values,structuredClone(patch)),remove:async key=>{delete values[key];}};}
function fixture(){
  const local=storage(),session=storage(),tabs=new Map(),calls=[],alarms=new Map();let clock=1000,tabSerial=0,permission=true;
  const accountId='a'.repeat(32),responses={cloudflare:[],grok:[]};
  const api={storage:{local,session},permissions:{contains:async()=>permission},tabs:{
    create:async options=>{const tab={...options,id:++tabSerial};tabs.set(tab.id,tab);calls.push(['create-tab',tab.id]);return tab;},
    get:async id=>{if(!tabs.has(id))throw Error('closed');return tabs.get(id);},
    update:async(id,patch)=>{Object.assign(tabs.get(id),patch);return tabs.get(id);}
  },scripting:{executeScript:async options=>{calls.push(['script',options.target.tabId]);const provider=options.args[0].provider;return [{result:responses[provider].shift()||{state:'loading'}}];}},alarms:{create:async(name,value)=>alarms.set(name,value),clear:async name=>alarms.delete(name)}};
  const provisioner={inspect:async token=>{assert.equal(token,'cf-secret');return {accountId,accounts:[{id:accountId,name:'test'}]};},prepareResources:async options=>{calls.push(['prepare']);await options.onCheckpoint({databaseId:'db-id',preflightAbsent:true});return {setupId:options.setupId,accountId,workerName:options.resourceName,databaseId:'db-id',origin:`https://${options.resourceName}.test.workers.dev`};},configureWorker:async options=>{calls.push(['configure']);assert.equal(options.webhookSecret,'whsec_private-only');return {origin:options.origin};}};
  const jobs=[];const relay={connect:async c=>{calls.push(['connect']);assert.ok(c.token.length>=32);},generate:async(_prompt,options)=>{calls.push(['generate']);assert.equal(options.timeoutMs,0);const job={id:'existing-test',test:true,requestTag:options.requestTag,createdAt:clock,status:'accepted'};jobs.push(job);return {pending:true,jobId:job.id};},jobs:async()=>jobs,query:async id=>{calls.push(['query',id]);return {id,status:'completed',result:'connection confirmed'};}};
  const service=createBotOnboarding({api,provisioner,relay,workerSource:'fixed module',schema:'fixed schema',now:()=>clock});
  return {service,api,local,session,tabs,calls,responses,alarms,accountId,setTime:t=>{clock=t;},setPermission:v=>{permission=v;},provisioner,relay,
    cloudflareReady:async()=>{await service.start();responses.cloudflare.push({state:'account',accountId});await service.advance();responses.cloudflare.push({state:'token',token:'cf-secret'});await service.advance();await service.advance();},
    grokReady:async()=>{responses.grok.push({state:'webhook-draft',webhookUrl:'https://grok.com/webhook/automation/'+crypto.randomUUID(),webhookSecret:'whsec_private-only'},{state:'saving'},{state:'saved'});await service.advance();await service.advance();await service.advance();}};
}

test('full wizard creates owned resources and binds once; secrets never enter public status or local storage',async()=>{
  const f=fixture();await f.cloudflareReady();await f.grokReady();await f.service.advance();
  assert.equal((await f.service.status()).stage,'testing');
  assert.equal(f.calls.filter(c=>c[0]==='generate').length,1);
  const serialized=JSON.stringify({status:await f.service.status(),local:f.local.values});
  assert.doesNotMatch(serialized,/cf-secret|whsec_private-only|clientToken/);
  assert.equal(f.session.values[SETUP_VAULT_KEY].cloudflareToken,'cf-secret');
  await f.service.advance();assert.equal(f.calls.filter(c=>c[0]==='query').length,0,'no query before 30 seconds');
  f.setTime(31000);await f.service.advance();
  assert.equal((await f.service.status()).stage,'completed');assert.equal(f.session.values[SETUP_VAULT_KEY],undefined);assert.equal(f.alarms.size,0);
});

test('reopening and duplicate advance never create another setup or generation',async()=>{
  const f=fixture();await Promise.all([f.service.start(),f.service.status()]);const original=await f.service.status();await f.service.start();assert.equal((await f.service.status()).setupId,original.setupId);
  f.responses.cloudflare.push({state:'account',accountId:f.accountId});await Promise.all([f.service.advance(),f.service.advance()]);
  assert.equal((await f.service.status()).stage,'cloudflare-token');assert.equal(f.calls.filter(c=>c[0]==='create-tab').length,1);
});

test('permission is required before binding and generating; user grant resumes the same deployed resources',async()=>{
  const f=fixture();await f.cloudflareReady();await f.grokReady();f.setPermission(false);await f.service.advance();
  assert.equal((await f.service.status()).needsWorkerPermission,true);assert.equal(f.calls.filter(c=>c[0]==='connect').length,0);
  f.setPermission(true);await f.service.advance();assert.equal((await f.service.status()).stage,'testing');assert.equal(f.calls.filter(c=>c[0]==='prepare').length,1);
});

test('a tab moved to an untrusted origin is never inspected',async()=>{
  const f=fixture();await f.service.start();const s=await f.service.status();f.tabs.get(s.cloudflareTabId).url='https://evil.example/';await f.service.advance();
  assert.equal(f.calls.filter(c=>c[0]==='script').length,0);assert.equal((await f.service.status()).errorCode,'TAB_MISSING');
});

test('login and human verification only wait, do not call Cloudflare deployment APIs',async()=>{
  const f=fixture();await f.service.start();f.responses.cloudflare.push({state:'login'},{state:'verification'});await f.service.advance();await f.service.advance();
  assert.equal((await f.service.status()).stage,'cloudflare-login');assert.equal(f.calls.filter(c=>c[0]==='prepare').length,0);
});

test('unsupported Grok form stops before modifying any existing binding',async()=>{
  const f=fixture();await f.cloudflareReady();f.responses.grok.push({state:'unsupported'});await f.service.advance();assert.ok((await f.service.status()).error);assert.equal(f.calls.filter(c=>c[0]==='connect').length,0);
});

test('cancel clears session secrets and stops work while preserving cloud resource checkpoints and owned tabs',async()=>{
  const f=fixture();await f.cloudflareReady();const before=await f.service.status();await f.service.cancel();await f.service.advance();
  assert.equal((await f.service.status()).stage,'cancelled');assert.equal((await f.service.status()).databaseId,before.databaseId);assert.equal(f.session.values[SETUP_VAULT_KEY],undefined);assert.ok(f.tabs.size);assert.equal(f.calls.filter(c=>c[0]==='configure').length,0);
});

test('expired auth requires reauthorization but preserves the same resource creation checkpoint',async()=>{
  const f=fixture();await f.cloudflareReady();f.setTime(3601001);await f.service.advance();assert.equal((await f.service.status()).errorCode,'AUTH_EXPIRED');
  const name=(await f.service.status()).resourceName;await f.service.resume();assert.equal((await f.service.status()).stage,'cloudflare-login');assert.equal((await f.service.status()).resourceName,name);assert.equal((await f.service.status()).checkpoint.databaseId,'db-id');
});

test('pending connection test can finish after browser session secrets were cleared, without another generate',async()=>{
  const f=fixture();await f.cloudflareReady();await f.grokReady();await f.service.advance();await f.session.remove(SETUP_VAULT_KEY);await f.service.resume();f.setTime(31000);await f.service.advance();
  assert.equal((await f.service.status()).stage,'completed');assert.equal(f.calls.filter(c=>c[0]==='generate').length,1);
});

test('two simultaneous starts share one setup and one owned page',async()=>{const f=fixture();const [a,b]=await Promise.all([f.service.start(),f.service.start()]);assert.equal(a.setupId,b.setupId);assert.equal(f.calls.filter(c=>c[0]==='create-tab').length,1);});

test('Grok creation intent is durable before the single Save dispatch; an uncertain dispatch is not replayed',async()=>{
  const f=fixture();await f.cloudflareReady();let saves=0;const original=f.api.scripting.executeScript;
  f.api.scripting.executeScript=async details=>{
    if(details.args[0].action==='create'){
      const state=f.local.values[SETUP_KEY];assert.equal(state.grokCreateIntent,true);assert.equal(state.grokSubmissionStarted,true);saves++;throw Error('response lost after native save');
    }
    return original(details);
  };
  f.responses.grok.push({state:'ready-to-create'});await f.service.advance();assert.ok((await f.service.status()).error);
  await f.service.resume();f.responses.grok.push({state:'creation-pending'});await f.service.advance();assert.equal(saves,1);assert.equal((await f.service.status()).error,'');
});

test('expired temporary credentials are cleared by a status refresh even if the setup is paused',async()=>{
  const f=fixture();await f.cloudflareReady();f.setTime(3601001);await f.service.status();assert.equal(f.session.values[SETUP_VAULT_KEY],undefined);
});
