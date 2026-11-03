import {t} from '../../shared/i18n.js';
import {createTaskProgressReporter,createResultReporter,publishPanelResult,PANEL_RESULT_ACTION_EVENT} from './result-notices.js';
import {setPanelIconButtonLabel} from './panel-icon-button.js';

export const FAN_REVIEW_ACTIONS = Object.freeze({analyze:'AI 审核',approve:'通过并入队',remove:'移除此关注者','return-review':'退回审核'});

export function fanReviewResultGroups(results=[]){
  const count=predicate=>results.filter(predicate).length;
  return [{label:'通过',count:count(i=>['pass','approved'].includes(i.status))},
    {label:'不通过',count:count(i=>['rejected','removed'].includes(i.status))},
    {label:'资料不足',count:count(i=>i.status==='uncertain'&&!i.local||i.reasonCode==='missing_biography')} ,
    {label:'异常',count:count(i=>['error','failed'].includes(i.status)||i.technicalError||i.status==='uncertain'&&i.local&&i.reasonCode!=='missing_biography')},
    {label:'已跳过',count:count(i=>i.status==='skipped')},
    {label:'历史待确认',count:count(i=>i.status==='review')}].filter((item,index)=>index<3||item.count);
}

function resultLabel(item,action){
  if(action==='analyze')return item.status==='rejected'?(item.executionStatus==='removed'?'不通过 · 已移除':'不通过 · 等待移除')
    :item.status==='pass'?'通过':item.status==='uncertain'?(item.local&&item.reasonCode!=='missing_biography'?'异常':'资料不足')
    :['failed','error'].includes(item.status)?'异常':item.status==='review'?'历史待确认':item.status==='skipped'?'已跳过':item.status;
  return item.reasonCode==='missing_biography'?'资料不足':{approved:'已通过',pass:'通过',review:'需审核',uncertain:'无法判断',removed:'已移除',failed:'失败',deferred:'等待冷却',skipped:'已跳过',completed:'已完成'}[item.status]||item.status||'';
}

const canonicalHandle = value => String(value || '').trim().replace(/^@/, '').toLowerCase();
const stableUserId = value => typeof value === 'string' && /^\d+$/.test(value) ? value : '';

function identitySnapshot(user) {
  const payload = user?.payload || user || {};
  const handle = canonicalHandle(user?.handle || payload.handle);
  const ids = new Set([payload.targetUserId, payload.id, payload.rest_id, payload.restId].map(stableUserId).filter(Boolean));
  return {handle, targetUserId:ids.size === 1 ? [...ids][0] : '',
    conflict:ids.size > 1 || payload.legacyHandleIdentityConflict === true || payload.status === 'identity_mismatch'};
}

export function fanReviewRequest(action, {handles = [], targets, allMatching = false, filter = {}} = {}) {
  if (!Object.hasOwn(FAN_REVIEW_ACTIONS, action)) throw new Error('无效的审核操作');
  const unique = [...new Set(handles.map(canonicalHandle).filter(Boolean))];
  if (!allMatching && !unique.length) throw new Error('请先选择账号');
  const snapshots = new Map();
  for (const target of targets || []) {
    const handle = canonicalHandle(target?.handle), id = stableUserId(target?.targetUserId);
    if (!handle) continue;
    const previous = snapshots.get(handle);
    snapshots.set(handle, {handle, targetUserId:id, conflict:target?.conflict === true || previous?.conflict === true
      || Boolean(previous && previous.targetUserId !== id)});
  }
  if (action === 'remove' && (allMatching || unique.some(handle => !snapshots.get(handle)?.targetUserId || snapshots.get(handle)?.conflict))) {
    throw new Error('所选账号缺少明确的用户 ID 或存在账号记录冲突，请重新核实后再移除');
  }
  const frozen = targets ? unique.map(handle => ({handle, targetUserId:snapshots.get(handle)?.conflict ? '' : snapshots.get(handle)?.targetUserId || ''})) : null;
  return {cmd:'followQueueFanReviewStart',action,...(allMatching ? {allMatching:true,filter:structuredClone(filter)} : {handles:unique}),
    ...(frozen ? {targets:frozen} : {}),...(filter.reviewResult?{filter:structuredClone(filter)}:{})};
}

export function fanReviewProgress(batch, translate=(text,values={})=>text.replace(/\{\{(\w+)\}\}/g,(_,key)=>values[key]??'')) {
  if (!batch) return '';
  const action = FAN_REVIEW_ACTIONS[batch.action] || '审核';
  const stage = {running:'进行中',paused:'已暂停',completed:'已完成',failed:'未完成'}[batch.stage] || '等待中';
  const detail=batch.action==='analyze'&&batch.stage==='running' ? batch.stopping ? translate(' · 正在停止')
    : batch.phase==='saving' ? translate(' · 保存结果 {{done}}/{{total}}',{done:batch.applied||0,total:batch.planned||0})
    : batch.phase==='checking' ? translate(' · 检查记录 {{checked}}/{{total}} · @{{handle}}',{checked:batch.checked||0,total:batch.planned||0,handle:batch.currentHandle||''})
    : batch.requestSize ? translate(' · 本批 {{count}} 人',{count:batch.requestSize})
    : batch.nextRequestAt>Date.now() ? translate(' · 下批等待 {{seconds}} 秒',{seconds:Math.ceil((batch.nextRequestAt-Date.now())/1000)}) : '' : '';
  return translate('{{v0}}{{v1}}：{{v2}}/{{v3}}{{v4}}',{v0:translate(action),v1:translate(stage),v2:batch.completed||0,v3:batch.total||0,v4:batch.error?translate(' · {{v0}}',{v0:translate(batch.error)}):detail});
}

export function createFanReviewPanel({root=document,request=message=>chrome.runtime.sendMessage(message),getSelection,getFilter,afterChange,selectionLocked=()=>false,onSelectionLockChanged=()=>{},confirm=message=>globalThis.confirm(message),publishResult=notice=>publishPanelResult(notice,root)} = {}) {
  const node = id => root.getElementById(id);
  let batch=null,error='',timer=null,allMatching=false,frozenHandles=[],frozenTargets=[],total=null,context='',starting=false,selecting=false,disposed=false;
  let statusRevision=0,selectionRevision=0,mutationRevision=0,initialDirectoryReady=false;
  let activeHandles=[];
  const rememberedTargets=new Map();
  let paintedAll=false;
  const reportBatch=createTaskProgressReporter({publish:publishResult}),reportError=createResultReporter({publish:publishResult});
  function reportResult(explicit=false){
    if(batch)reportBatch(batch,{id:`review:${batch.id}`,kind:'fan-review',batchId:batch.id,title:t(FAN_REVIEW_ACTIONS[batch.action]||'审核')+' · '+t(batch.stage==='paused'&&batch.pendingRecovery&&batch.automatic&&!batch.userPaused?'等待恢复':{running:'进行中',paused:'已暂停',completed:'已完成',failed:'未完成'}[batch.stage]||'等待中'),
      progress:{stage:batch.stage,done:batch.completed||0,total:batch.total||0,...(batch.action==='analyze'?{groups:fanReviewResultGroups(batch.results)}:{success:(batch.results||[]).filter(i=>!['failed','uncertain'].includes(i.status)).length,failed:(batch.results||[]).filter(i=>['failed','uncertain'].includes(i.status)).length})},
      actions:batch.stage==='running'?[{action:'stop',label:'停止后续',disabled:!!batch.stopping}]:['paused','failed'].includes(batch.stage)?[{action:'resume',label:batch.pendingRecovery?'查询原任务':'继续处理',disabled:starting}]:[],
      note:batch.error?t(batch.error):batch.currentHandle?'@'+batch.currentHandle:batch.requestSize?t('本批 {{count}} 人',{count:batch.requestSize}):'',items:(batch.results||[]).map(item=>{
      const state=resultLabel(item,batch.action);
      return `@${item.handle} · ${t(state)}${item.tags?.length?` · ${item.tags.join('、')}`:''}${item.reason?` · ${item.reason}`:''}`;
    })},{explicit});
    if(error)reportError({id:`review-error:${mutationRevision}`,title:t('操作未完成'),note:t(error),
      ...(batch?.pendingRecovery?{kind:'fan-review',batchId:batch.id,actions:[{action:'view-task',label:'查看原任务'}]}:{})});
  }
  const busy = () => starting || selecting || batch?.stage === 'running' || selectionLocked();
  function resetAllMatching() {selectionRevision++;selecting=false;allMatching=false;frozenHandles=[];frozenTargets=[];}
  function rememberSelection(user, selected=true) {
    if(selectionLocked())return;
    const snapshot=identitySnapshot(user);
    if (!snapshot.handle) return;
    resetAllMatching();
    if (!selected) rememberedTargets.delete(snapshot.handle);
    else if (!rememberedTargets.has(snapshot.handle)) rememberedTargets.set(snapshot.handle,snapshot);
    render();
  }
  function render() {
    if (disposed) return;
    const count = allMatching ? frozenHandles.length : getSelection().length;
    const message = node('fanReviewSelection');
    if (message) message.textContent = allMatching ? t('已选择全部筛选结果 {{v0}} 人',{v0:count == null ? '…' : count}) : '';
    for (const [id,action] of [['reviewSelectedFans','analyze'],['approveSelectedFans','approve'],['removeSelectedFans','remove']]) {
      const button=node(id);if (button) button.disabled=busy() || (!allMatching && !count) || allMatching && count===0;
    }
    const all=node('selectAllFilteredFans');if(all){all.disabled=busy() || total===0;setPanelIconButtonLabel(all,allMatching?'取消选择全部':'选择全部筛选结果');all.setAttribute('aria-pressed',String(allMatching));}
    if(allMatching||paintedAll){
      const boxes=[...(root.querySelectorAll?.('#monitorList input[data-fan-handle]')||[])];
      for(const box of boxes){if(!selectionLocked())box.checked=allMatching?frozenHandles.includes(box.dataset.fanHandle):getSelection().includes(box.dataset.fanHandle);box.disabled=allMatching||selectionLocked();}
      const pageCount=node('selectedCount');if(pageCount)pageCount.textContent=String(boxes.filter(box=>box.checked).length);
      const pageAll=node('listSelectAll');if(pageAll){pageAll.disabled=allMatching;pageAll.checked=boxes.length>0&&boxes.every(box=>box.checked);pageAll.indeterminate=!pageAll.checked&&boxes.some(box=>box.checked);}
      paintedAll=allMatching;
    }
    reportResult();
    const host=node('fanReviewProgress');if(host)host.hidden=true;
    const status=node('fanReviewStatus');if(status)status.textContent=error ? t(error) : fanReviewProgress(batch,t);
    const stop=node('stopFanReview');if(stop){stop.hidden=batch?.stage!=='running';stop.disabled=starting || Boolean(batch?.stopping);}
    const resume=node('resumeFanReview');if(resume){resume.hidden=!['paused','failed'].includes(batch?.stage);resume.disabled=starting;}
    const results=node('fanReviewResults');if(results){
      results.replaceChildren();
      for(const item of batch?.results || []) {
        const li=root.createElement('li');
        const state=resultLabel(item,batch.action);
        li.textContent=`@${item.handle} · ${t(state)}${item.tags?.length ? ` · ${item.tags.join('、')}` : ''}${item.reason ? ` · ${item.reason}` : ''}`;
        results.append(li);
      }
    }
  }
  async function refresh() {
    clearTimeout(timer);if(disposed || starting)return;
    const ticket=++statusRevision;
    try {
      const result=await request({cmd:'followQueueFanReviewStatus'});
      if(disposed || ticket!==statusRevision)return;
      if(!result?.ok)throw Error(result?.error||'审核进度读取失败');
      const previous=batch;batch=result.batch||null;if(previous?.id!==batch?.id)activeHandles=[];error='';render();onSelectionLockChanged();
      // The first bound status waits for the background's legacy review
      // migration, even when no manual batch exists. Refresh the directory so
      // pre-migration counts cannot remain visible until the next interaction.
      if(!initialDirectoryReady && !result.requiresActivation || batch && (previous?.id!==batch.id || previous?.completed!==batch.completed || previous?.stage!==batch.stage)) await afterChange?.();
      if(!result.requiresActivation)initialDirectoryReady=true;
    }catch(failure){if(disposed || ticket!==statusRevision)return;error=failure.message;render();}
    if(!disposed && ticket===statusRevision && (batch?.stage==='running'||error))timer=setTimeout(refresh,error?4000:1200);
  }
  async function start(action,handles,users) {
    if(busy())return;
    // An unresolved task already owns the frozen input. Reopen its controls
    // instead of submitting a second task and showing a dead-end error.
    if(action==='analyze'&&batch?.pendingRecovery){error='';reportResult(true);return;}
    let ticket;
    try {
      for (const user of users ? (Array.isArray(users)?users:[users]) : []) {
        const snapshot=identitySnapshot(user);
        if(snapshot.handle && !rememberedTargets.has(snapshot.handle))rememberedTargets.set(snapshot.handle,snapshot);
      }
      const selected=[...(handles || (allMatching?frozenHandles:getSelection()))];
      activeHandles=[...selected];
      const snapshots=allMatching && !handles ? frozenTargets : selected.map(handle=>rememberedTargets.get(canonicalHandle(handle)) || {handle:canonicalHandle(handle),targetUserId:''});
      const message=fanReviewRequest(action,{handles:selected,targets:snapshots,filter:structuredClone(getFilter())});
      if(action==='remove' && !await confirm(t('将通过 X 移除所选的 {{v0}} 位关注者，并保留移除记录。确认继续？',{v0:selected.length})))return;
      ticket=++mutationRevision;statusRevision++;clearTimeout(timer);starting=true;error='';render();onSelectionLockChanged();
      const result=await request(message);if(disposed || ticket!==mutationRevision)return;
      if(!result?.ok)throw Error(result?.error||'审核任务未能开始');
      statusRevision++;batch=result.batch||null;reportResult(true);resetAllMatching();await afterChange?.();
    }catch(failure){if(!disposed && (ticket===undefined || ticket===mutationRevision)){
      if(ticket!==undefined){
        try{const current=await request({cmd:'followQueueFanReviewStatus'});if(!disposed&&ticket===mutationRevision&&current?.ok)batch=current.batch||batch;}catch{}
      }
      if(!disposed&&(ticket===undefined||ticket===mutationRevision))error=failure.message;
    }}
    finally{if(!disposed && (ticket===undefined || ticket===mutationRevision)){starting=false;render();onSelectionLockChanged();if(ticket!==undefined && batch)void refresh();}}
  }
  async function command(cmd) {
    if(starting || disposed)return;
    const ticket=++mutationRevision;statusRevision++;clearTimeout(timer);starting=true;error='';render();
    try{const result=await request({cmd});if(disposed || ticket!==mutationRevision)return;if(!result?.ok)throw Error(result?.error||'审核任务操作失败');statusRevision++;batch=result.batch||batch;}
    catch(failure){if(!disposed && ticket===mutationRevision)error=failure.message;}
    finally{if(!disposed && ticket===mutationRevision){starting=false;render();onSelectionLockChanged();void refresh();}}
  }
  const listeners=[];
  function on(id,fn){const target=node(id);if(target){target.addEventListener('click',fn);listeners.push(()=>target.removeEventListener('click',fn));}}
  on('reviewSelectedFans',()=>start('analyze'));on('approveSelectedFans',()=>start('approve'));on('removeSelectedFans',()=>start('remove'));
  on('selectAllFilteredFans',async()=>{
    if(busy() || disposed)return;
    if(allMatching){resetAllMatching();render();return;}
    const ticket=++selectionRevision,filter=structuredClone(getFilter());selecting=true;error='';render();
    try{
      const result=await request({cmd:'recordData',op:'fanInspectionTargets',filter});
      if(disposed || ticket!==selectionRevision)return;
      if(!result?.ok||!Array.isArray(result.handles))throw Error(result?.error||'筛选结果读取失败');
      const handles=[...new Set(result.handles.map(canonicalHandle).filter(Boolean))],snapshots=new Map();
      for(let index=0;index<handles.length;index+=100){
        const chunk=handles.slice(index,index+100);
        const directory=await request({cmd:'recordData',op:'fanDirectory',handles:chunk});
        if(disposed || ticket!==selectionRevision)return;
        if(!directory?.ok||!Array.isArray(directory.records))throw Error(directory?.error||'账号信息读取失败');
        for(const row of directory.records){
          const snapshot=identitySnapshot(row);if(!chunk.includes(snapshot.handle))continue;
          const previous=snapshots.get(snapshot.handle);
          if(previous && previous.targetUserId!==snapshot.targetUserId)snapshot.conflict=true;
          if(previous?.conflict)snapshot.conflict=true;
          snapshots.set(snapshot.handle,snapshot);
        }
      }
      frozenHandles=handles;frozenTargets=handles.map(handle=>snapshots.get(handle)||{handle,targetUserId:''});allMatching=true;
    }catch(failure){if(!disposed && ticket===selectionRevision)error=failure.message;}
    finally{if(!disposed && ticket===selectionRevision){selecting=false;render();}}
  });
  on('stopFanReview',()=>command('followQueueFanReviewStop'));on('resumeFanReview',()=>command('followQueueFanReviewResume'));
  const actionTarget=root.ownerDocument||root;
  const noticeAction=event=>{const d=event.detail;if(d?.kind!=='fan-review'||d.batchId!==batch?.id)return;
    if(d.action==='view-task')void refresh().then(()=>{if(!disposed)reportResult(true);});
    if(d.action==='stop')void command('followQueueFanReviewStop');if(d.action==='resume')void command('followQueueFanReviewResume');};
  actionTarget.addEventListener?.(PANEL_RESULT_ACTION_EVENT,noticeAction);listeners.push(()=>actionTarget.removeEventListener?.(PANEL_RESULT_ACTION_EVENT,noticeAction));
  return {
    start,refresh,rememberSelection,
    activeSelection:()=>({running:starting||batch?.stage==='running',keys:starting&&activeHandles.length?activeHandles:batch?.handles||activeHandles}),
    isAllMatching:()=>allMatching,
    isSelected:handle=>allMatching?frozenHandles.includes(canonicalHandle(handle)):getSelection().includes(canonicalHandle(handle)),
    update({filter=getFilter(),count=null}={}){const key=JSON.stringify(filter);if(key!==context){context=key;resetAllMatching();rememberedTargets.clear();}total=count;render();},
    clearSelection(){resetAllMatching();rememberedTargets.clear();render();},
    dispose(){disposed=true;statusRevision++;selectionRevision++;mutationRevision++;clearTimeout(timer);listeners.forEach(off=>off());}
  };
}
