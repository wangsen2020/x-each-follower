import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {parse} from '@babel/parser';
import {createProfileTab,updateProfileTab} from '../src/platform/x/profile-access.js';

function callsUnder(dir) {
 const calls=[];
 for(const item of readdirSync(dir,{withFileTypes:true})){
  const file=join(dir,item.name);
  if(item.isDirectory()){calls.push(...callsUnder(file));continue;}
  if(!file.endsWith('.js'))continue;
  const source=readFileSync(file,'utf8');
  function visit(node){
   if(!node||typeof node!=='object')return;
   if(node.type==='CallExpression'&&['createProfileTab','updateProfileTab'].includes(node.callee.name))calls.push({file,line:node.loc.start.line,expression:source.slice(node.start,node.end)});
   for(const [key,value] of Object.entries(node))if(!['loc','extra'].includes(key)){if(Array.isArray(value))value.forEach(visit);else visit(value);}
  }
  visit(parse(source,{sourceType:'module'}));
 }
 return calls;
}

const calls=callsUnder(fileURLToPath(new URL('../src',import.meta.url)));
test('every production profile-tab call forwards valid native arguments without altering them',async()=>{
 assert.ok(calls.length>=25,'audit must include all migrated call sites');
 for(const call of calls)for(const sourceTab of [undefined,{windowId:0},{windowId:42}]){
  const nativeCalls=[];
  const validate=options=>{
   assert.equal(typeof options,'object');assert.ok(!Array.isArray(options));
   for(const key of Object.keys(options))assert.ok(['url','active','windowId'].includes(key),`Unexpected property: ${key}`);
   if('url'in options)assert.equal(typeof options.url,'string');
   if('active'in options)assert.equal(typeof options.active,'boolean');
   if('windowId'in options)assert.ok(Number.isInteger(options.windowId));
   nativeCalls.push(options);return {id:17,...options};
  };
  const api={tabs:{create:async options=>validate(options),update:async(id,options)=>{assert.ok(Number.isInteger(id));return validate(options);}}};
  const context={api,chrome:api,sourceTab,handle:'writer',url:'https://x.com/writer',targetUrl:'https://x.com/writer',source:'fixture',suffix:'following',operation:'UserRepliesTimeline',job:{id:'job-1',handle:'writer'},binding:{handle:'viewer'},control:{runId:'run-1'},win:{id:42},tabId:17,targetId:17,inspectionTab:17,tab:{id:17},existing:{id:17},temporary:{id:17}};
  for(const [name,fn] of Object.entries({createProfileTab,updateProfileTab}))context[name]=async(...args)=>{
   const options=args[name==='createProfileTab'?1:2],origin=args[name==='createProfileTab'?2:3];
   assert.equal(typeof origin,'string');
   const result=await fn(...args);
   assert.equal(nativeCalls[0],options,'wrapper must forward the original options');
   return result;
  };
  try{await vm.runInNewContext(call.expression,context);assert.equal(nativeCalls.length,1);}
  catch(error){throw new Error(`${call.file}:${call.line} ${call.expression}: ${error.message}`,{cause:error});}
 }
});
