import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {inspectBrowserCalls,inspectBrowserSourceTree} from '../tools/check-browser-calls.mjs';

test('all production JS and Vue scripts pass browser-call contract checks',()=>{
 const result=inspectBrowserSourceTree(fileURLToPath(new URL('../src',import.meta.url)));
 assert.ok(result.files>80);
 assert.deepEqual(result.errors,[]);
});

test('detects the historical comment-tracking regression even though JavaScript parses',()=>{
 const broken="createProfileTab(chrome,{url,active:false,...(sourceTab?.windowId!=null?{windowId:sourceTab.windowId}:{},'comment-auto-follow')});";
 const errors=inspectBrowserCalls(broken);
 assert.ok(errors.some(error=>error.includes('Comma expression')));
 assert.ok(errors.some(error=>error.includes('expects 3-4 arguments')));
 assert.deepEqual(inspectBrowserCalls("createProfileTab(chrome,{url,active:false,...(sourceTab?.windowId!=null?{windowId:sourceTab.windowId}:{})},'comment-tracking');"),[]);
});

test('detects other wrapper signature and literal-spread mistakes',()=>{
 for(const source of [
  "chrome.tabs.create({url,...'source'});",
  "chrome.tabs.update(id,{url,...[windowId]});",
  "updateProfileTab(chrome,id,{url});",
  "createProfileTab(chrome,'https://x.com/writer','source');",
  "readProfileOnTab(chrome,id,handle,5);"
 ])assert.ok(inspectBrowserCalls(source).length,source);
 assert.deepEqual(inspectBrowserCalls("for(let i=0,j=0;i<3;i++,j++){const options={url,...(windowId!=null?{windowId}:{} )};createProfileTab(chrome,options,'source',{jobId});}"),[]);
});
