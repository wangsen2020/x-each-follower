import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../src/entries/content/exception-capture.js',import.meta.url),'utf8');

test('content capture ignores page errors, sends only extension errors and redacts pending fallback',async()=>{
  const listeners={},saved={},sent=[];
  const chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,getManifest:()=>({version:'4.12.0'}),sendMessage:(message,callback)=>{sent.push(message);callback();},lastError:{message:'worker absent'}},storage:{local:{get:async()=>saved,set:async data=>Object.assign(saved,data),remove:async keys=>{for(const key of keys)delete saved[key];}}}};
  const scope=vm.createContext({chrome,crypto,URL,location:{origin:'https://x.com',pathname:'/home'},console:{warn(){},error(){}},addEventListener:(name,listener)=>listeners[name]=listener});
  vm.runInContext(script,scope);vm.runInContext(script,scope);
  listeners.error({filename:'https://x.com/app.js',message:'page error'});assert.equal(sent.length,0);
  listeners.error({filename:'chrome-extension://test/bridge.js',message:'Bearer secret token=hidden https://example.com/test?token=query'});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,1);assert.equal(Object.keys(saved).length,1);
  const text=JSON.stringify(saved);for(const word of ['secret','hidden','query'])assert.ok(!text.includes(word));
  vm.runInContext("console.warn('warning',{token:'private'})",scope);assert.equal(sent.length,2);assert.ok(!JSON.stringify(sent).includes('private'));
  chrome.runtime.getManifest=()=>{throw Error('Extension context invalidated');};
  assert.doesNotThrow(()=>listeners.error({filename:'chrome-extension://test/bridge.js',message:'stale'}));assert.equal(sent.length,2);
});
