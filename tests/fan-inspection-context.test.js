import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {fanInspectionContextChange} from '../src/features/relationships/fan-inspection-batch.js';
const source=readFileSync(new URL('../src/entries/panel/panel.js',import.meta.url),'utf8');
const block=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
test('a row action cannot submit another inspection while a batch owns the selection',async()=>{
  const context=vm.createContext({fanInspectBusy:new Set(),fanSelectionLocked:()=>true,
    chrome:{runtime:{sendMessage:()=>assert.fail('no duplicate inspection')}},renderMonitorList:()=>assert.fail('no duplicate render')});
  await vm.runInContext(block('async function inspectFanRelationship(', '\nlet fanDeleteRunning')+'\ninspectFanRelationship({handle:"one"})',context);
  assert.equal(context.fanInspectBusy.size,0);
});
function panel(){
  const calls=[],reports=[],nodes=new Map(),tab={dataset:{followerTab:'fanUnknown'},addEventListener:(_,fn)=>tab.click=fn};
  const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',disabled:false});return nodes.get(id)};
  const ctx=vm.createContext({fanViewEpoch:0,fanStartToken:null,fanContextChanging:false,fanBatchTimer:null,fanBatchError:'',
    fanBatchState:{id:'active',stage:'running'},followerSearch:'',followerReviewResult:'',activeFollowerTab:'fanUnknown',followerPage:1,
    fanInspectionContextChange,clearTimeout(){},clearFollowerSelection:()=>calls.push('clear'),renderFanBatch(){},renderMonitorList(){},
    $:node,document:{querySelectorAll:()=>[tab]},recordPaging:false,recordPages:null,
    reloadRecordModule:async()=>calls.push('reload'),inspectionResult:explicit=>reports.push(explicit),
    chrome:{runtime:{sendMessage:async message=>{calls.push(message);return {ok:true,batch:{id:'active',stage:'cancelled',reason:'已更改搜索条件'}}}}}});
  vm.runInContext(block('async function changeFollowerContext(', '\nfunction renderFanBatch(')+'\n'+block('function searchFollowers(', "\n$('followerSearch')")+'\n'+
    block("document.querySelectorAll('[data-follower-tab]').forEach(button => button.addEventListener", "\n$('listSelectAll')"),ctx);
  return {ctx,calls,reports,tab};
}
test('real panel handlers ignore clicking the active category and resubmitting the same search',async()=>{
  const {ctx,calls,tab}=panel();tab.click();await vm.runInContext("searchFollowers('   ')",ctx);await new Promise(r=>setImmediate(r));
  assert.equal(calls.length,0);assert.equal(ctx.fanViewEpoch,0);assert.equal(ctx.fanBatchState.stage,'running');
});
test('search and category changes clear only selection, preserving the running batch and its polling',async()=>{
  const {ctx,calls,reports}=panel();vm.runInContext("searchFollowers(' changed ')",ctx);await new Promise(r=>setImmediate(r));
  assert.equal(calls.some(c=>c?.cmd),false);assert.deepEqual(reports,[]);
  assert.equal(ctx.followerSearch,'changed');assert.equal(ctx.fanContextChanging,false);assert.equal(ctx.fanBatchState.stage,'running');
  ctx.document.querySelectorAll=()=>[];
  const token=ctx.fanStartToken={pending:true};ctx.fanBatchTimer=123;
  await vm.runInContext("changeFollowerContext(()=>{activeFollowerTab='fanPending'},async()=>{},fanInspectionContextChange('tab','fanUnknown','fanPending'))",ctx);
  assert.equal(ctx.activeFollowerTab,'fanPending');assert.equal(ctx.fanStartToken,token);assert.equal(ctx.fanBatchTimer,123);
});

test('page, page-size, filter and default pagination changes do not issue cancellation commands',async()=>{
  for(const kind of ['page','pageSize','reviewResult','pagination']){
    const {ctx,calls}=panel();
    await vm.runInContext(`changeFollowerContext(()=>{followerPage=2},async()=>{},fanInspectionContextChange('${kind}','before','after'))`,ctx);
    assert.equal(ctx.followerPage,2);assert.equal(ctx.fanBatchState.id,'active');assert.equal(ctx.fanBatchState.stage,'running');assert.equal(calls.some(c=>c?.cmd),false);
  }
});

test('a start response arriving after navigation still updates the task and continues progress polling',async()=>{
  const {ctx,calls}=panel();let reply,polls=0;
  Object.assign(ctx,{fanBatchCommandEpoch:0,fanBatchStatusEpoch:0,selectedRowCopies:{reconcilePage(){}},selectedFollowerHandles:new Set(['one']),currentFollowerUsers:()=>[],currentRecordFilter:()=>({tab:'original'}),t:s=>s,refreshFanBatchStatus:()=>polls++});
  ctx.chrome.runtime.sendMessage=message=>{calls.push(message);return new Promise(resolve=>reply=resolve);};
  vm.runInContext(block('async function fanBatchAction(', '\nasync function inspectFanRelationship('),ctx);
  const action=vm.runInContext("fanBatchAction('followQueueFanBatchStart')",ctx);
  await vm.runInContext("changeFollowerContext(()=>{activeFollowerTab='fanPending'},async()=>{},fanInspectionContextChange('tab','original','fanPending'))",ctx);
  reply({ok:true,batch:{id:'started',stage:'running',handles:['one']}});await action;
  assert.equal(ctx.fanBatchState.id,'started');assert.equal(polls,1);assert.deepEqual(Array.from(calls.find(c=>c?.cmd).handles),['one']);
  assert.equal(calls.find(c=>c?.cmd).filter.tab,'original');assert.equal(ctx.activeFollowerTab,'fanPending');
});

test('an in-flight progress response is not discarded when the visible list changes',async()=>{
  const {ctx}=panel();let reply,schedules=0;
  Object.assign(ctx,{fanBatchStatusEpoch:0,recordPages:null,setTimeout:()=>++schedules});
  ctx.chrome.runtime.sendMessage=()=>new Promise(resolve=>reply=resolve);
  vm.runInContext(block('async function refreshFanBatchStatus(', '\nasync function fanBatchAction('),ctx);
  const poll=vm.runInContext('refreshFanBatchStatus()',ctx);
  await vm.runInContext("changeFollowerContext(()=>{followerPage=2},async()=>{},fanInspectionContextChange('page',1,2))",ctx);
  reply({ok:true,batch:{id:'active',stage:'running',nextIndex:2}});await poll;
  assert.equal(ctx.fanBatchState.nextIndex,2);assert.equal(schedules,1);
});
