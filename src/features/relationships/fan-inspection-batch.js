// Persist only this read-only business workflow; individual observations are
// committed by the existing record service before advancing the checkpoint.
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
        for (;state.nextIndex<state.handles.length;) {
          if (token.stop) {state.reason='已停止后续核验';break;}
          if ((await binding())?.accountId!==state.accountId) {state.reason='当前绑定账号已变化';break;}
          const handle=state.handles[state.nextIndex];state.currentHandle=handle;await save(state);
          try {
            const result=await Promise.race([inspect(handle,{signal:token.controller.signal}),cancelled]);
            if(token.cancelled)break;
            if (!result?.ok) throw new Error(result?.error || '关系核验失败');
            state.results.push({handle,status:result.jobState==='identity-mismatch'?'identity-mismatch':'verified',relationship:result.relationship || null,jobState:result.jobState || '',at:now()});
          } catch (error) {
            if(token.cancelled)break;
            const reason=String(error?.message || error);
            if (error?.status===429 || ['X_PROFILE_READ_LIMIT','FAN_INSPECTION_ACCOUNT','FAN_INSPECTION_NETWORK'].includes(error?.code)
              || /登录|绑定账号|当前账号|HTTP\s*(?:401|403|429)|网络|Failed to fetch|fetch failed/i.test(reason)) {
              state.reason=reason;break;
            }
            state.results.push({handle,status:'failed',error:reason,at:now()});
          }
          state.nextIndex++;state.updatedAt=now();await save(state);
          if (state.nextIndex<state.handles.length && !token.stop) await Promise.race([wait(2000 + Math.floor(random() * 3001)),cancelled]);
        }
        state.stage=state.nextIndex===state.handles.length?'completed':'paused';
      } catch (error) {state.stage='paused';state.reason=String(error.message || error);}
      finally {if(token.cancelled){state.stage='cancelled';state.reason='范围已切换，批次已取消，请重新选择';}state.currentHandle='';state.updatedAt=now();try {await save(state);} finally {if(active===token)active=null;}}
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
  async function cancel(account) {
    generation++;
    if(preparation)await preparation;
    const state=await load(account),token=active;
    if(token && token.id===state?.id){token.cancelled=true;token.stop=true;token.controller.abort(new DOMException('核验范围已重置','AbortError'));await token.promise;}
    else if(state?.stage==='paused'){state.stage='cancelled';state.reason='范围已切换，批次已取消';await save(state);}
    return status(account);
  }
  return {start,status,resume,stop,cancel,settled:()=>active?.promise || Promise.resolve()};
}
