import test from 'node:test';
import assert from 'node:assert/strict';
import {fanReviewRequest,fanReviewProgress,createFanReviewPanel} from '../src/entries/panel/fan-review-panel.js';

test('fan review selection keeps more than twenty users and deduplicates exact handles',()=>{
  const handles=Array.from({length:53},(_,i)=>`User_${i}`);
  const request=fanReviewRequest('analyze',{handles:[...handles,'@USER_2']});
  assert.equal(request.handles.length,53);
  assert.equal(request.handles[2],'user_2');
  assert.equal(request.allMatching,undefined);
});
test('all-filter selection freezes its filter independent of subsequent navigation',()=>{
  const filter={tab:'fanReview',search:'profile'};
  const request=fanReviewRequest('approve',{allMatching:true,filter});
  filter.tab='fanPending';
  assert.deepEqual(request,{cmd:'followQueueFanReviewStart',action:'approve',allMatching:true,filter:{tab:'fanReview',search:'profile'}});
});
test('review operations reject empty selection and unknown actions',()=>{
  assert.throws(()=>fanReviewRequest('analyze'),/选择/);
  assert.throws(()=>fanReviewRequest('follow',{handles:['one']}),/无效/);
});
test('progress reports partial failure without declaring all targets complete',()=>{
  assert.equal(fanReviewProgress({action:'analyze',stage:'paused',completed:2,total:31,error:'引擎未连接'}),'AI 审核已暂停：2/31 · 引擎未连接');
});

function deferred() {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(request,{selection=['one'],filter={tab:'fanReview'},confirm=()=>true,pageHandles=[],publishResult}={}) {
  const ids=['fanReviewSelection','reviewSelectedFans','approveSelectedFans','removeSelectedFans','selectAllFilteredFans',
    'fanReviewProgress','fanReviewStatus','stopFanReview','resumeFanReview','fanReviewResults','selectedCount','listSelectAll'];
  const element=()=>({disabled:false,hidden:false,textContent:'',children:[],listeners:new Map(),
    attributes:new Map(),setAttribute(name,value){this.attributes.set(name,value);},getAttribute(name){return this.attributes.get(name);},
    addEventListener(name,fn){this.listeners.set(name,fn);},removeEventListener(name){this.listeners.delete(name);},
    replaceChildren(){this.children=[];},append(child){this.children.push(child);},click(){return this.listeners.get('click')?.();}});
  const nodes=Object.fromEntries(ids.map(id=>[id,element()]));
  const boxes=pageHandles.map(handle=>({dataset:{fanHandle:handle},checked:false,disabled:false}));
  const root={...element(),getElementById:id=>nodes[id],createElement:element,querySelectorAll:()=>boxes};
  const changes=[];
  const panel=createFanReviewPanel({root,request,getSelection:()=>selection,getFilter:()=>filter,confirm,publishResult,afterChange:async()=>{changes.push('changed');}});
  panel.update({filter,count:selection.length});
  return {panel,nodes,changes,boxes,root};
}

test('reopening an unresolved review reveals the original task controls without a second submission',async()=>{
  const notices=[],calls=[];const batch={id:'original',action:'analyze',stage:'paused',pendingRecovery:true,automatic:true,total:2,completed:0};
  const {panel,root}=fixture(async message=>{calls.push(message);return {ok:true,batch};},{publishResult:n=>notices.push(n)});
  try{
    await panel.refresh();const count=notices.length;
    await panel.start('analyze',['different']);
    assert.equal(calls.filter(m=>m.cmd==='followQueueFanReviewStart').length,0);
    assert.equal(notices.length,count+1);assert.equal(notices.at(-1).batchId,'original');
    assert.match(notices.at(-1).title,/等待恢复/);assert.equal(notices.at(-1).actions[0].label,'查询原任务');
    root.listeners.get('xfollower:operation-result-action')({detail:{kind:'fan-review',batchId:'original',action:'resume'}});await tick();
    assert.equal(calls.filter(m=>m.cmd==='followQueueFanReviewResume').length,1);
  }finally{panel.dispose();}
});

test('a rejected start discovers the original batch and exposes a read-only navigation action',async()=>{
  const notices=[],calls=[];const batch={id:'original',action:'analyze',stage:'paused',pendingRecovery:true,total:2,completed:0};
  const {panel,root}=fixture(async message=>{calls.push(message);return message.cmd==='followQueueFanReviewStart'
    ?{ok:false,error:'原 AI 任务尚未确认，请继续原审核任务'}:{ok:true,batch};},{publishResult:n=>notices.push(n)});
  try{
    await panel.start('analyze');await tick();
    const error=notices.find(n=>n.title==='操作未完成');assert.equal(error.batchId,'original');
    assert.deepEqual(error.actions,[{action:'view-task',label:'查看原任务'}]);
    const before=calls.length;root.listeners.get('xfollower:operation-result-action')({detail:{kind:'fan-review',batchId:'original',action:'view-task'}});await tick();
    assert.ok(calls.slice(before).every(m=>m.cmd==='followQueueFanReviewStatus'));
    assert.equal(notices.at(-1).id,'task:review:original');assert.equal(notices.at(-1).actions[0].action,'resume');
  }finally{panel.dispose();}
});

test('terminal review results move to cards and leave no persistent list area',async()=>{
  const notices=[];let batch={id:'old',action:'approve',stage:'completed',completed:1,total:1,results:[]};
  const {panel,nodes}=fixture(async message=>{
    if(message.cmd==='followQueueFanReviewStart')batch={...batch,id:'new',results:[{handle:'one',status:'approved',reason:'已加入关注队列'}]};
    return {ok:true,batch};
  },{publishResult:n=>notices.push(n)});
  try{await panel.refresh();assert.equal(notices.length,0);assert.equal(nodes.fanReviewProgress.hidden,true);
    await panel.start('approve');await tick();assert.equal(notices.length,1);assert.match(notices[0].items[0],/@one.*已通过/);
    assert.equal(nodes.fanReviewProgress.hidden,true);await panel.refresh();assert.equal(notices.length,1);
  }finally{panel.dispose();}
});

test('running review selection is frozen during start and restored from the persisted batch across view changes',async()=>{
  const starting=deferred();let batch={id:'active',action:'analyze',stage:'running',handles:['one','two'],completed:0,total:2};
  const filter={tab:'fanReview'},selection=['one','two'];
  const {panel}=fixture(async message=>message.cmd==='followQueueFanReviewStart'?starting.promise:{ok:true,batch},{selection,filter});
  try{
    const pending=panel.start('analyze');await tick();
    selection.splice(0,selection.length,'different');filter.tab='fanPending';panel.update({filter});
    assert.deepEqual(panel.activeSelection(),{running:true,keys:['one','two']});
    starting.resolve({ok:true,batch});await pending;await tick();
    assert.deepEqual(panel.activeSelection(),{running:true,keys:['one','two']});
    batch={...batch,id:'another-task',handles:['restored']};await panel.refresh();
    assert.deepEqual(panel.activeSelection(),{running:true,keys:['restored']});
  }finally{panel.dispose();}
});

test('filtered cross-page selection visibly selects the page and carries the exact filter to bulk approval',async()=>{
  const handles=Array.from({length:63},(_,i)=>'pass_'+i),filter={tab:'fanReview',reviewResult:'pass'};let submitted;
  const {panel,nodes,boxes}=fixture(async message=>{
    if(message.op==='fanInspectionTargets'){assert.deepEqual(message.filter,filter);return {ok:true,handles};}
    if(message.op==='fanDirectory')return {ok:true,records:message.handles.map(handle=>({handle,payload:{id:String(1000+handles.indexOf(handle))}}))};
    if(message.cmd==='followQueueFanReviewStatus')return {ok:true,batch:null};submitted=message;return {ok:true,batch:{stage:'completed',total:63,completed:63}};
  },{selection:[],filter,pageHandles:handles.slice(0,20)});
  try{
    panel.update({filter,count:63});await nodes.selectAllFilteredFans.click();
    assert.equal(nodes.selectAllFilteredFans.getAttribute('aria-pressed'),'true');
    assert.equal(nodes.selectAllFilteredFans.getAttribute('aria-label'),'取消选择全部');
    assert.ok(boxes.every(box=>box.checked&&box.disabled));assert.equal(nodes.selectedCount.textContent,'20');assert.match(nodes.fanReviewSelection.textContent,/63/);
    panel.update({filter,count:63});assert.equal(panel.isAllMatching(),true);assert.equal(panel.isSelected('pass_62'),true);assert.equal(panel.isSelected('not_selected'),false);
    await panel.start('approve');assert.equal(submitted.handles.length,63);assert.equal(submitted.targets.length,63);assert.deepEqual(submitted.filter,filter);
    assert.ok(boxes.every(box=>!box.checked&&!box.disabled));
    assert.equal(nodes.selectAllFilteredFans.getAttribute('aria-pressed'),'false');
  }finally{panel.dispose();}
});

test('changing the review-result filter drops a frozen cross-page selection',async()=>{
  const filter={tab:'fanReview',reviewResult:'pass'};let starts=0;
  const {panel,nodes}=fixture(async message=>{
    if(message.op==='fanInspectionTargets')return {ok:true,handles:['one']};
    if(message.op==='fanDirectory')return {ok:true,records:[{handle:'one',payload:{id:'100'}}]};
    starts++;return {ok:true};
  },{selection:[],filter});
  try{panel.update({filter,count:1});await nodes.selectAllFilteredFans.click();filter.reviewResult='review';panel.update({filter,count:2});
    assert.equal(nodes.fanReviewSelection.textContent,'');assert.equal(nodes.approveSelectedFans.disabled,true);await panel.start('approve');assert.equal(starts,0);
  }finally{panel.dispose();}
});
test('the first bound empty status refreshes directory counts after migration exactly once',async()=>{
  const {panel,changes}=fixture(async()=>({ok:true,batch:null}));
  try{await panel.refresh();await panel.refresh();assert.deepEqual(changes,['changed']);}finally{panel.dispose();}
});
test('an unbound startup does not consume the post-migration directory refresh',async()=>{
  let activated=false;const {panel,changes}=fixture(async()=>({ok:true,batch:null,requiresActivation:!activated}));
  try{await panel.refresh();assert.deepEqual(changes,[]);activated=true;await panel.refresh();assert.deepEqual(changes,['changed']);}finally{panel.dispose();}
});

test('an old status response cannot erase the batch returned by a newer start',async()=>{
  const oldStatus=deferred(),currentStatus=deferred();let reads=0;
  const {panel,nodes,changes}=fixture(async message=>{
    if(message.cmd==='followQueueFanReviewStatus')return (++reads===1?oldStatus:currentStatus).promise;
    if(message.cmd==='followQueueFanReviewStart')return {ok:true,batch:{id:'new',action:'analyze',stage:'running',completed:0,total:7}};
    assert.fail('unexpected message');
  });
  try{
    const oldRead=panel.refresh();
    panel.rememberSelection({handle:'one',id:'100'});
    await panel.start('analyze');
    assert.match(nodes.fanReviewStatus.textContent,/0\/7/);assert.equal(nodes.stopFanReview.hidden,false);
    oldStatus.resolve({ok:true,batch:null});await oldRead;
    assert.match(nodes.fanReviewStatus.textContent,/0\/7/);assert.equal(nodes.stopFanReview.hidden,false);
    assert.equal(nodes.reviewSelectedFans.disabled,true);assert.deepEqual(changes,['changed']);
  }finally{panel.dispose();currentStatus.resolve({ok:true,batch:null});}
});

test('a newer status response wins when concurrent status reads finish out of order',async()=>{
  const first=deferred(),second=deferred();let reads=0;
  const {panel,nodes}=fixture(()=> (++reads===1?first:second).promise);
  try{
    const older=panel.refresh(),newer=panel.refresh();
    second.resolve({ok:true,batch:{id:'active',action:'analyze',stage:'running',completed:3,total:9}});await newer;
    first.resolve({ok:true,batch:{id:'old',action:'analyze',stage:'completed',completed:1,total:1}});await older;
    assert.match(nodes.fanReviewStatus.textContent,/3\/9/);assert.equal(nodes.stopFanReview.hidden,false);
  }finally{panel.dispose();}
});

for(const phase of ['handles','identities'])test(`clearing selection during ${phase} loading rejects late all-filter selection`,async()=>{
  const response=deferred();let directoryReads=0;
  const {panel,nodes}=fixture(async message=>{
    if(message.op==='fanInspectionTargets')return phase==='handles'?response.promise:{ok:true,handles:['one']};
    if(message.op==='fanDirectory'){directoryReads++;return response.promise;}
    assert.fail('no task should start');
  },{selection:[]});
  try{
    const selecting=nodes.selectAllFilteredFans.click();await tick();
    // Pagination clears selection but keeps the same filter and page size.
    panel.clearSelection();
    response.resolve(phase==='handles'?{ok:true,handles:['one']}:{ok:true,records:[{handle:'one',payload:{id:'100'}}]});
    await selecting;
    assert.equal(nodes.fanReviewSelection.textContent,'');assert.equal(nodes.removeSelectedFans.disabled,true);
    if(phase==='handles')assert.equal(directoryReads,0);
  }finally{panel.dispose();}
});

test('removal requires frozen stable string IDs and rejects missing or conflicting identities',()=>{
  assert.throws(()=>fanReviewRequest('remove',{handles:['one']}),/用户 ID/);
  assert.throws(()=>fanReviewRequest('remove',{handles:['one'],targets:[{handle:'one',targetUserId:100}]}),/用户 ID/);
  assert.throws(()=>fanReviewRequest('remove',{handles:['one'],targets:[{handle:'one',targetUserId:'100'},{handle:'ONE',targetUserId:'200'}]}),/账号记录冲突/);
  assert.throws(()=>fanReviewRequest('remove',{allMatching:true,targets:[{handle:'one',targetUserId:'100'}]}),/用户 ID/);
  assert.deepEqual(fanReviewRequest('remove',{handles:['@One'],targets:[{handle:'one',targetUserId:'100'}]}),
    {cmd:'followQueueFanReviewStart',action:'remove',handles:['one'],targets:[{handle:'one',targetUserId:'100'}]});
});

test('manual selection freezes the first identity and is cleared only by deselection or context clearing',async()=>{
  const requests=[];
  const {panel}=fixture(async message=>{
    if(message.cmd==='followQueueFanReviewStatus')return {ok:true,batch:null};
    requests.push(message);return {ok:true,batch:{id:'done',stage:'completed',completed:1,total:1}};
  });
  try{
    const user={handle:'one',id:'100'};panel.rememberSelection(user);
    user.id='200';panel.rememberSelection(user); // Re-rendered or refreshed data must not rewrite the selection.
    await panel.start('remove');assert.deepEqual(requests[0].targets,[{handle:'one',targetUserId:'100'}]);
    await tick();panel.rememberSelection(user,false);panel.rememberSelection(user);
    await panel.start('remove');assert.deepEqual(requests[1].targets,[{handle:'one',targetUserId:'200'}]);
    await tick();panel.clearSelection();await panel.start('remove');assert.equal(requests.length,2);
  }finally{panel.dispose();}
});

test('all-filter selection freezes directory IDs in batches of at most one hundred before any action',async()=>{
  const handles=Array.from({length:205},(_,i)=>'user_'+i),chunks=[],starts=[];
  let replaced=false;
  const {panel,nodes}=fixture(async message=>{
    if(message.op==='fanInspectionTargets')return {ok:true,handles};
    if(message.op==='fanDirectory'){
      chunks.push(message.handles);
      return {ok:true,records:message.handles.map(handle=>({handle,payload:{id:String((replaced?9000:1000)+handles.indexOf(handle))}}))};
    }
    if(message.cmd==='followQueueFanReviewStatus')return {ok:true,batch:null};
    starts.push(message);return {ok:true,batch:{id:'batch',stage:'completed',completed:205,total:205}};
  },{selection:[]});
  try{
    await nodes.selectAllFilteredFans.click();assert.deepEqual(chunks.map(chunk=>chunk.length),[100,100,5]);
    replaced=true;await panel.start('remove');
    assert.equal(starts.length,1);assert.equal(starts[0].handles.length,205);assert.equal(starts[0].targets.length,205);
    assert.deepEqual(starts[0].targets[204],{handle:'user_204',targetUserId:'1204'});
    assert.equal(chunks.length,3,'starting removal must not resolve handles to replacement IDs');
  }finally{panel.dispose();}
});

test('missing and conflicting directory IDs stop removal while preserving the selected result set',async()=>{
  let started=0;
  const {panel,nodes}=fixture(async message=>{
    if(message.op==='fanInspectionTargets')return {ok:true,handles:['one','two']};
    if(message.op==='fanDirectory')return {ok:true,records:[{handle:'one',payload:{id:'100',rest_id:'200'}},{handle:'two',payload:{}}]};
    started++;return {ok:true};
  },{selection:[]});
  try{
    await nodes.selectAllFilteredFans.click();await panel.start('remove');
    assert.equal(started,0);assert.match(nodes.fanReviewStatus.textContent,/用户 ID/);assert.notEqual(nodes.fanReviewSelection.textContent,'');
  }finally{panel.dispose();}
});

test('an inline action can supply its own snapshot without altering ordinary selection',async()=>{
  let submitted;
  const {panel}=fixture(async message=>{if(message.cmd==='followQueueFanReviewStatus')return {ok:true,batch:null};submitted=message;return {ok:true,batch:null};},{selection:[]});
  try{await panel.start('approve',['inline'],{handle:'inline',rest_id:'300'});assert.deepEqual(submitted.targets,[{handle:'inline',targetUserId:'300'}]);}
  finally{panel.dispose();}
});

test('AI notice counts business decisions separately from exceptions and historical suggestions',async()=>{
 const {fanReviewResultGroups}=await import('../src/entries/panel/fan-review-panel.js');
 const groups=fanReviewResultGroups([{status:'pass'},{status:'rejected',executionStatus:'removed'},{status:'uncertain'},
  {status:'uncertain',local:true,reasonCode:'missing_biography'},{status:'error'},{status:'review'}]);
 assert.deepEqual(Object.fromEntries(groups.map(g=>[g.label,g.count])),{'通过':1,'不通过':1,'资料不足':2,'异常':1,'历史待确认':1});
 assert.ok(groups.every(g=>!['成功','失败'].includes(g.label)));
});
