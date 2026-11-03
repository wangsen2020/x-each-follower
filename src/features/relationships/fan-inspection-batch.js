// Persist only this read-only business workflow; individual observations are
// committed by the existing record service before advancing the checkpoint.
import {runVerificationItems} from './verification-workflow.js';
const CONTEXT_REASONS=Object.freeze({tab:'已切换分类',search:'已更改搜索条件',reviewResult:'已更改审核结果筛选',pageSize:'已调整每页数量',page:'已翻页',pagination:'已更改全局分页设置'});
export function fanInspectionContextChange(kind,from,to){
  if(!Object.hasOwn(CONTEXT_REASONS,kind)||JSON.stringify(from)===JSON.stringify(to))return null;
  return {kind,from:structuredClone(from),to:structuredClone(to)};
}
export function createFanInspectionBatch({storage, binding, targets, inspect, wait = ms => new Promise(resolve => setTimeout(resolve,ms)), random = Math.random, now = Date.now} = {}) {
  let active = null;
  let starting = false;
  let generation=0,preparation=null,finishPreparation=null;
  const headKey = account => `fanInspectionHead:${account}`;
  const batchKey = (account,id) => `fanInspection:${account}:${id}`;
  const save = state => storage.set({[batchKey(state.accountId,state.id)]:state});
  async function load(account) {
    const head=(await storage.get(headKey(account)))[headKey(account)];
    return head ? (await storage.get(batchKey(account,head)))[batchKey(account,head)] || null : null;
  }
  async function status(account) {
    const state=await load(account);
    if (state?.stage==='running' && active?.id!==state.id && !starting) {
      state.stage='paused';state.currentHandle='';state.reason='核验已中断，已保留结果，可继续剩余账号';await save(state);
    }
    return state ? {...state,stopping:active?.id===state.id && active.stop} : null;
  }
  function launch(state) {
    const token=active={id:state.id,stop:false,cancelled:false,controller:new AbortController()};
    const cancelled=new Promise((_,reject)=>token.controller.signal.addEventListener('abort',()=>reject(token.controller.signal.reason),{once:true}));
    cancelled.catch(()=>{});
    token.promise=(async()=>{
      try {
        const result=await runVerificationItems({items:state.handles,startIndex:state.nextIndex,accountId:state.accountId,
          readAccount:async()=>(await binding())?.accountId,shouldStop:()=>token.stop,discard:()=>token.cancelled,
          onCurrent:async handle=>{state.currentHandle=handle;await save(state);},
          inspect:handle=>Promise.race([inspect(handle,{signal:token.controller.signal}),cancelled]),
          onSuccess:(result,handle)=>state.results.push({handle,status:result.jobState==='identity-mismatch'?'identity-mismatch':'verified',relationship:result.relationship||null,jobState:result.jobState||'',...(result.profileCollection?{profileCollection:result.profileCollection}:{}),...(result.reviewTransition?{reviewTransition:result.reviewTransition}:{}),at:now()}),
          onFailure:(error,handle)=>state.results.push({handle,status:'failed',error:String(error?.message||error),at:now()}),
          onAdvance:async nextIndex=>{state.nextIndex=nextIndex;state.updatedAt=now();await save(state);},
          wait:ms=>Promise.race([wait(ms),cancelled]),random});
        Object.assign(state,result);
      } catch (error) {state.stage='paused';state.reason=String(error.message || error);}
      finally {if(token.cancelled){state.stage='cancelled';state.cancellation=token.cancellation;state.reason=token.cancellation.reason;}state.currentHandle='';state.updatedAt=now();try {await save(state);} finally {if(active===token)active=null;}}
    })().catch(()=>{});
  }
  async function start(account,request) {
    if (active || starting) throw new Error('已有批量核验正在执行');
    starting=true;
    const epoch=generation;
    preparation=new Promise(resolve=>finishPreparation=resolve);
    try {
    const handles=[...new Set((await targets(request)).map(h=>String(h).toLowerCase()))];
    if(epoch!==generation)throw new Error('范围已切换，本次核验已取消');
    if (!handles.length) throw new Error('没有可核验的账号');
    const state={id:crypto.randomUUID(),accountId:account,scope:request.scope || '当前分类',handles,nextIndex:0,results:[],stage:'running',currentHandle:'',createdAt:now(),updatedAt:now(),reason:''};
    await save(state);await storage.set({[headKey(account)]:state.id});
    if(epoch!==generation){state.stage='cancelled';state.reason='范围已切换';await save(state);}else launch(state);return state;
    } finally {starting=false;finishPreparation?.();preparation=null;}
  }
  async function resume(account) {
    if (active || starting) throw new Error('已有批量核验正在执行');
    starting=true;
    const epoch=generation;
    preparation=new Promise(resolve=>finishPreparation=resolve);
    try {
    const state=await status(account);
    if (!state || state.stage==='cancelled' || state.nextIndex>=state.handles.length) throw new Error('没有待继续的核验，请重新选择');
    if(epoch!==generation)throw new Error('范围已切换，本次核验已取消');
    state.stage='running';state.reason='';await save(state);
    if(epoch!==generation){state.stage='cancelled';state.reason='范围已切换';await save(state);}else launch(state);return state;
    }finally{starting=false;finishPreparation?.();preparation=null;}
  }
  async function stop(account) {
    const state=await load(account);
    if(active && active.id===state?.id)active.stop=true;
    return status(account);
  }
  async function cancel(account,change={}) {
    // Older open panels may still send view-change cancellation messages.
    // A view never owns a running task's frozen target list.
    if(change.kind)return status(account);
    const detail=change.kind?fanInspectionContextChange(change.kind,change.from,change.to):null;
    if(change.kind&&!detail)return status(account);
    const preparing=Boolean(preparation);
    generation++;
    if(preparation)await preparation;
    const state=await load(account),token=active;
    const cancellation={...(detail||{kind:'scope'}),reason:CONTEXT_REASONS[detail?.kind]||'范围已切换，批次已取消，请重新选择',requestedAt:now(),completed:state?.nextIndex||0,remaining:Math.max(0,(state?.handles.length||0)-(state?.nextIndex||0)),nextHandle:state?.handles[state.nextIndex]||''};
    if(token && token.id===state?.id){token.cancellation||=cancellation;token.cancelled=true;token.stop=true;token.controller.abort(new DOMException('核验范围已重置','AbortError'));await token.promise;}
    else if(state?.stage==='paused'||preparing&&state?.stage==='cancelled'&&!state.cancellation){state.stage='cancelled';state.reason=cancellation.reason;state.cancellation=cancellation;await save(state);}
    return status(account);
  }
  return {start,status,resume,stop,cancel,settled:()=>active?.promise || Promise.resolve()};
}
