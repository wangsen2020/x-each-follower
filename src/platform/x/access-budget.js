import Dexie from 'dexie';

const MINUTE=60000,HOUR=60*MINUTE;
export const X_ACCESS_POLICY=Object.freeze({
  navigation:{minGap:30000,jitter:30000,quarterLimit:20,hourLimit:60,repeatGap:10*MINUTE},
  query:{minGap:3000,jitter:3000,quarterLimit:120,hourLimit:400,repeatGap:0}
});
export const isAccessDeferred=error=>error?.code==='X_ACCESS_DEFERRED';
export function accessDeferred(retryAt,reason='自动采集已暂缓，等待访问冷却') {
  return Object.assign(new Error(reason),{code:'X_ACCESS_DEFERRED',deferred:true,retryAt,attempted:false});
}

// Dexie transactions arbitrate all extension contexts. No requests/timers inside a transaction.
// Browser-profile scope deliberately remains conservative across X account switches.
export function createAccessBudget({name='xfollower-x-access-budget',dependencies,now=Date.now,random=Math.random,policy=X_ACCESS_POLICY}={}) {
  const db=new Dexie(name,dependencies);db.version(1).stores({budget:'id'});
  async function reserve({kind='navigation',key='',source='unknown'}) {
    return db.transaction('rw',db.budget,async()=>{
      const at=now(),row=await db.budget.get('shared')||{id:'shared'},rule=policy[kind];
      if(!rule)throw Error('未知访问预算类型');
      const events=(row.events||[]).filter(e=>e.at>at-HOUR),recent=events.filter(e=>e.kind===kind);
      const quarter=recent.filter(e=>e.at>at-15*MINUTE);
      const last=recent.findLast(e=>e.key===key);
      const retryAt=Math.max(row.cooldownUntil||0,row.next?.[kind]||0,
        last?last.at+rule.repeatGap:0,
        quarter.length>=rule.quarterLimit?quarter[quarter.length-rule.quarterLimit].at+15*MINUTE:0,
        recent.length>=rule.hourLimit?recent[recent.length-rule.hourLimit].at+HOUR:0);
      if(retryAt>at)return {allowed:false,retryAt,reason:row.cooldownUntil>at?row.cooldownReason:'自动采集已暂缓，等待访问冷却'};
      events.push({at,kind,key,source});
      await db.budget.put({...row,events,next:{...row.next,[kind]:at+rule.minGap+Math.floor(random()*rule.jitter)}});
      return {allowed:true,at};
    });
  }
  async function observe(response) {
    const status=Number(response?.status),challenge=response?.challenge===true;
    if(!challenge&&![401,403,429].includes(status)&&response?.rateLimit?.remaining!==0)return;
    return db.transaction('rw',db.budget,async()=>{
      const at=now(),row=await db.budget.get('shared')||{id:'shared'};
      const cooldownUntil=Math.max(row.cooldownUntil||0,at+([401,403].includes(status)&&!challenge?5:15)*MINUTE,
        at+Math.max(0,Number(response.retryAfterSeconds)||0)*1000,Number(response.rateLimit?.resetAt)||0);
      await db.budget.put({...row,cooldownUntil,cooldownReason:challenge?'X 页面需要验证，自动采集已暂缓':
        status===401||status===403?'X 会话或访问受限，自动采集已暂缓':'X 请求达到限制，自动采集已暂缓'});
      return cooldownUntil;
    });
  }
  return {reserve,observe,read:()=>db.budget.get('shared'),close:()=>db.close()};
}

let liveBudget;
function budgetFor(api) {
  if(api?.accessBudget)return api.accessBudget;
  // Dependency-injected transport fixtures are not extension execution contexts.
  if(!api?.runtime?.id)return null;
  return liveBudget ||= createAccessBudget();
}
export async function admitXAccess(api,request,{signal,deadline=Date.now()+65000,check,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const budget=budgetFor(api);if(!budget)return;
  for(;;){
    if(signal?.aborted)throw signal.reason||new Error('采集已取消');
    if(Date.now()>=deadline)throw accessDeferred(Date.now()+MINUTE);
    await check?.();
    let result;
    try{result=await budget.reserve(request);}catch(error){throw accessDeferred(Date.now()+MINUTE,'访问预算暂不可用，已保留任务');}
    if(result.allowed){
      if(signal?.aborted)throw signal.reason||new Error('采集已取消');
      await check?.();
      return;
    }
    if(result.retryAt>=deadline)throw accessDeferred(result.retryAt,result.reason);
    await wait(Math.min(1000,Math.max(1,result.retryAt-Date.now())));
  }
}
export async function observeXAccess(api,response) {
  const budget=budgetFor(api);if(!budget)return;
  try{return await budget.observe(response);}catch{throw accessDeferred(Date.now()+15*MINUTE,'访问冷却保存失败，已停止本轮采集');}
}

// Inspect only browser challenge surfaces; never classify arbitrary profile/post text.
export function readXChallengeOnPage() {
  return /^\/(?:account\/access|i\/flow\/challenge)(?:\/|$)/.test(location.pathname)||
    Boolean(document.querySelector('#challenge-form,iframe[src*="challenges.cloudflare.com"],iframe[src*="arkoselabs.com"],iframe[src*="hcaptcha.com"]'));
}
