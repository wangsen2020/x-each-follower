import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {Webhook} from 'standardwebhooks';

test('real Workers runtime dispatches a signed webhook and persists an authenticated callback in D1',async()=>{
  const bundle=await build({stdin:{contents:"import handler from './worker.js';export default handler;",resolveDir:fileURLToPath(new URL('../',import.meta.url))},bundle:true,format:'esm',platform:'browser',write:false});
  let payload,deliveries=0;
  const secret='whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],
    bindings:{CLIENT_TOKEN:'test-only-token',WEBHOOK_URL:'https://grok.com/webhook/automation/test-only',WEBHOOK_SECRET:secret,PUBLIC_BASE_URL:'https://relay.example',BOT_NAME:'Test Bot'},d1Databases:['DB'],
    outboundService:async request=>{
      deliveries++;assert.equal(request.url,'https://grok.com/webhook/automation/test-only');
      const text=await request.text();payload=JSON.parse(text);
      assert.deepEqual(Object.keys(payload).sort(),['callback','callbackToken','jobId','text']);
      new Webhook(secret).verify(text,{'webhook-id':request.headers.get('webhook-id'),'webhook-timestamp':request.headers.get('webhook-timestamp'),'webhook-signature':request.headers.get('webhook-signature')});
      return new Response(null,{status:202});
    }}));
  try{
    const db=await mf.getD1Database('DB');
    const sql=(await readFile(new URL('../schema.sql',import.meta.url),'utf8')).replace(/^--.*$/gm,'').replace(/--[^\n]*/g,'');
    for(const statement of sql.split(';').map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
    const auth={authorization:'Bearer test-only-token','content-type':'application/json'};
    const landing=await mf.dispatchFetch('https://relay.example/');assert.equal(landing.status,200);assert.equal((await landing.json()).protocolVersion,1);
    const health=await mf.dispatchFetch('https://relay.example/v1/health',{headers:auth});assert.equal(health.status,200);
    const response=await mf.dispatchFetch('https://relay.example/v1/jobs',{method:'POST',headers:auth,body:JSON.stringify({jobId:'real-runtime-test',prompt:'完整测试文本'})});
    assert.equal(response.status,202);assert.equal((await response.json()).status,'accepted');assert.equal(deliveries,1);
    const repeated=await mf.dispatchFetch('https://relay.example/v1/jobs',{method:'POST',headers:auth,body:JSON.stringify({jobId:'real-runtime-test',prompt:'完整测试文本'})});assert.equal(repeated.status,202);assert.equal(deliveries,1);
    const callback=await mf.dispatchFetch(payload.callback,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jobId:payload.jobId,token:payload.callbackToken,result:'运行时完整结果'})});assert.equal(callback.status,200);
    const result=await mf.dispatchFetch('https://relay.example/v1/jobs/real-runtime-test',{headers:auth});
    assert.equal(result.headers.get('access-control-allow-origin'),'*');
    assert.deepEqual(Object.keys(await result.clone().json()).sort(),['jobId','reasonCode','result','status','updatedAt']);
    assert.equal((await result.json()).result,'运行时完整结果');
  }finally{await mf.dispose();}
});
