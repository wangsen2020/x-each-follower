import {createFollowbackAudit,unfollowSkipReason} from './followback-audit.js';
export const AUTO_UNFOLLOW_ALARM='x-auto-unfollow';
export const AUTO_UNFOLLOW_STATE='autoUnfollowState';
export const AUTO_UNFOLLOW_MIN_INTERVAL_MS=60000;
const MAX_PROFILE_CHECKS_PER_ROUND=5;
const handleOf=u=>String(u?.handle||'').replace(/^@/,'').toLowerCase();
export function autoUnfollowScheduleChanged(previous, next) {
  return ['autoUnfollow','autoUnfollowEvery','autoUnfollowJitter','activeTimeStart','activeTimeEnd']
    .some(key => previous?.[key] !== next?.[key]);
}
export function nextUnfollowWindow(config, time) {
  if (inUnfollowWindow(config, time)) return time;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config.activeTimeStart || '')) return time;
  const [hour, minute] = config.activeTimeStart.split(':').map(Number);
  const next = new Date(time);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() < time) next.setDate(next.getDate() + 1);
  return next.getTime();
}
export function inUnfollowWindow(config, time=Date.now()) {
  const parse=value=>/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value||'')?Number(value.slice(0,2))*60+Number(value.slice(3)):NaN;
  const start=parse(config.activeTimeStart),end=parse(config.activeTimeEnd),d=new Date(time),minute=d.getHours()*60+d.getMinutes();
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=1440||end>=1440)return false;
  return start===end || (start<end?minute>=start&&minute<end:minute>=start||minute<end);
}
export function eligibleAutoUnfollow(user, config, now=Date.now()) {
  const handle=handleOf(user),date=Date.parse(user?.followedAt||'');
  const whitelist=new Set(String(config.whitelist||'').split(/[,，\s]+/).map(x=>x.replace(/^@/,'').toLowerCase()));
  return /^[a-z0-9_]{1,15}$/.test(handle) && !user.exempt && !whitelist.has(handle)
    && !['unfollowed','mutual','unknown'].includes(user.status)
    && !['suspended','not_found'].includes(user.accountAvailability?.status)
    && user.relationship?.following===true && user.relationship?.followedBy===false
    && Number.isFinite(date) && now-date>=Math.max(1,Number(config.overdueDays)||14)*86400000;
}
export function createAutoUnfollow({storage,alarms,normalize,candidates,refreshCandidate=async user=>user,verifyAccount=async()=>{},profile,unfollow,followback,reconcile,log,now=Date.now,random=Math.random}) {
  let running=false;
  const config=async()=>normalize((await storage.get('unreciprocatedSettings')).unreciprocatedSettings||{});
  const delay=(base,jitter,min)=>Math.max(min,Number(base)+(random()*2-1)*Number(jitter||0));
  const day=()=>{const d=new Date(now());return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;};
  async function schedule(preserve=false) {
    const cfg=await config();
    if(!cfg.autoUnfollow){await alarms.clear(AUTO_UNFOLLOW_ALARM);return;}
    if(preserve && await alarms.get(AUTO_UNFOLLOW_ALARM))return;
    const earliest=now()+delay(cfg.autoUnfollowEvery,cfg.autoUnfollowJitter,AUTO_UNFOLLOW_MIN_INTERVAL_MS/60000)*60000;
    const when=nextUnfollowWindow(cfg,earliest);
    await alarms.create(AUTO_UNFOLLOW_ALARM,{when});
    return when;
  }
  async function run() {
    if(running){await log({source:'unfollow-auto',scope:'unreciprocated',result:'skipped',summary:'自动取关未执行：上一轮仍在运行'});return {skipped:'running'};}
    const audit=createFollowbackAudit('自动取关',entry=>log({source:'unfollow-auto',...entry}),now);
    running=true;let completed=0,attempted=0,checked=0,repaired=0,currentTarget=null;const unfollowedHandles=[];
    try {
      const cfg=await config();
      audit.stage('检查配置',{'绑定账号':cfg.autoUnfollowAccount?.handle||'未绑定','超时天数':cfg.overdueDays,'执行时段':`${cfg.activeTimeStart}—${cfg.activeTimeEnd}`,'单轮上限':1,'每日上限':cfg.dailyLimit});
      const nextAt=await schedule(); // A worker interruption still leaves the next round scheduled.
      audit.stage('检查配置',{'下次计划时间':nextAt?new Date(nextAt).toISOString():'未启用','当前本地时间':new Date(now()).toLocaleString(),'最短请求间隔分钟':AUTO_UNFOLLOW_MIN_INTERVAL_MS/60000});
      if(!cfg.autoUnfollow||!inUnfollowWindow(cfg,now())){await audit.event({scope:'unreciprocated',result:'skipped',summary:!cfg.autoUnfollow?'自动取关未执行：开关关闭':'自动取关未执行：当前不在执行时段'});return {skipped:'disabled_or_outside_window'};}
      if(!cfg.autoUnfollowAccount?.id || !cfg.autoUnfollowAccount?.handle)throw new Error('缺少绑定账号，请重新保存自动取关设置');
      await audit.event({scope:'unreciprocated',result:'started',summary:'开始自动取关检查'});
      const ledger=(await storage.get(AUTO_UNFOLLOW_STATE))[AUTO_UNFOLLOW_STATE]||{};
      const account=String(cfg.autoUnfollowAccount.id);
      const accounts={...(ledger.accounts||{})};
      if(ledger.account && !accounts[ledger.account])accounts[ledger.account]=ledger;
      let state=accounts[account]||{account,day:day(),used:0};
      const persist=()=>{accounts[account]=state;return storage.set({[AUTO_UNFOLLOW_STATE]:{accounts}});};
      audit.stage('核验登录账号');
      await verifyAccount(cfg);
      if(state.pending){
        currentTarget=state.pending.user;
        audit.stage('核验上次未确认的取关',{'目标账号':currentTarget.handle,'目标账号ID':currentTarget.id,'目标昵称':currentTarget.name||'','上次请求时间':new Date(state.pending.at||now()).toISOString(),'提交状态':'上次操作结果待确认，禁止重复操作'});
        const live=await profile(state.pending.user,cfg);
        if(state.pending.kind==='followback' ? !(live.relationship?.following===true && live.relationship?.followedBy===true) : live.relationship?.following!==false)throw new Error('上次操作结果尚未确认，已暂停自动取关，请核对执行日志');
        await reconcile(state.pending.user,live);
        state.queue=(state.queue||[]).filter(handle=>handle!==handleOf(state.pending.user));
        state.pending=null;await persist();
      }
      if(state.day!==day())state={...state,day:day(),used:0};
      const cap=Math.min(1,Math.max(0,cfg.dailyLimit-(state.used||0)));
      if(!cap){await audit.event({scope:'unreciprocated',result:'skipped',summary:'自动取关未执行：今日额度已用完'},{'今日已用':state.used,'下次条件':'本地日期变更后恢复额度'});return {skipped:'daily_limit'};}
      if(now()-(state.lastAttemptAt||0)<AUTO_UNFOLLOW_MIN_INTERVAL_MS){await audit.event({scope:'unreciprocated',result:'skipped',summary:'自动取关未执行：距上次请求不足 1 分钟'},{'上次请求时间':new Date(state.lastAttemptAt).toISOString()});return {skipped:'interval'};}
      audit.stage('筛选超时账号',{'今日已用':state.used,'本轮可用额度':cap});
      const allUsers=await candidates();
      audit.stage('筛选超时账号',{'候选记录总数':allUsers.length});
      const users=allUsers.filter(u=>{const eligible=eligibleAutoUnfollow(u,cfg,now());if(!eligible)audit.skip(unfollowSkipReason(u,cfg,now()),u);return eligible;}).sort((a,b)=>Date.parse(a.followedAt)-Date.parse(b.followedAt));
      const byHandle=new Map(users.map(user=>[handleOf(user),user]));
      const queued=new Set();
      state.queue=[...(Array.isArray(state.queue)?state.queue:[]),...users.map(handleOf)]
        .filter(handle=>{if(queued.has(handle)||!byHandle.has(handle))return false;queued.add(handle);return true;});
      await persist();
      for(const handle of [...state.queue]){
        if(attempted>=cap||checked>=MAX_PROFILE_CHECKS_PER_ROUND)break;
        let user=byHandle.get(handle);
        const dequeue=async()=>{state.queue=state.queue.filter(item=>item!==handle);await persist();};
        currentTarget=user;
        audit.stage('实时核验取关条件',{'目标账号':user.handle,'目标账号ID':String(user.id||''),'目标昵称':user.name||'','关注时间':user.followedAt,'提交状态':'尚未操作','请求是否发出':'未操作','操作状态':'未操作','核验关系':'待核验'});
        const current=await config();
        if(!current.autoUnfollow || current.autoUnfollowAccount?.id!==cfg.autoUnfollowAccount.id || !inUnfollowWindow(current,now()))break;
        if(!eligibleAutoUnfollow(user,current,now())){await dequeue();continue;}
        if(state.day!==day())state={...state,day:day(),used:0};
        if(state.used>=current.dailyLimit)break;
        user=await refreshCandidate(user);
        if(!user || !eligibleAutoUnfollow(user,current,now())){audit.skip(unfollowSkipReason(user,current,now()),user);await dequeue();continue;}
        checked++;
        let live;
        try { live=await profile(user,current); }
        catch(error){
          // Only target-specific preflight failures may yield to the next candidate.
          // Pending actions and owner/session/network failures still stop the round.
          if(!['AUTO_UNFOLLOW_TARGET_MISSING','AUTO_UNFOLLOW_TARGET_MISMATCH','X_PROFILE_UNAVAILABLE','X_PROFILE_IDENTITY_UNRESOLVED','X_PROFILE_ACTION_UNAVAILABLE'].includes(error.code))throw error;
          const reason=error.code==='X_PROFILE_ACTION_UNAVAILABLE'?'主页关注入口待核实，未操作':error.code==='X_PROFILE_UNAVAILABLE'?'目标账号不可用，未操作':'目标身份待核实，未操作';
          audit.skip(reason,user);
          state.queue=state.queue.filter(item=>item!==handle);state.queue.push(handle);await persist();
          await audit.event({scope:'unreciprocated',result:'skipped',handle,summary:`跳过 @${handle}：${reason}，继续检查后续账号`},{'错误代码':error.code,'核验说明':error.message,'本地账号ID':error.expectedId||String(user.id||''),'实时账号ID':error.actualId||'未取得','提交状态':'未操作，保留记录并移至队尾待核实'});
          continue;
        }
        audit.stage('实时核验取关条件',{'目标账号ID':String(live.id||user.id||''),'核验关系':`我关注对方：${live.relationship?.following===true?'是':live.relationship?.following===false?'否':'未知'}；对方关注我：${live.relationship?.followedBy===true?'是':live.relationship?.followedBy===false?'否':'未知'}`});
        if(live.relationship?.followedBy===true && live.relationship?.following===false){
          await reconcile(user,live);
          const cfgNow=await config();
          if(!cfgNow.autoUnfollow || cfgNow.autoUnfollowAccount?.id!==cfg.autoUnfollowAccount.id || !inUnfollowWindow(cfgNow,now()))break;
          if(!followback){audit.skip('待回关，未配置回关动作',user);await dequeue();continue;}
          attempted++;state.used=(state.used||0)+1;state.lastAttemptAt=now();
          state.pending={kind:'followback',user:{...user,id:live.id},at:now()};await persist();
          const response=await followback(live,cfgNow);
          if(response?.attempted===false){state.pending=null;await persist();throw new Error(response.error||'回关未执行');}
          const verified=await profile(user,cfgNow);
          if(verified.relationship?.following!==true || verified.relationship?.followedBy!==true)throw new Error('回关结果待确认，禁止重复操作');
          await reconcile(user,verified);state.pending=null;await dequeue();repaired++;
          await audit.event({scope:'unreciprocated',result:'success',handle,summary:`已阻止误取关并回关 @${handle}，现已互关`},{'提交状态':'已确认互关并回写本地'});
          break;
        }
        if(live.relationship?.following===false || live.relationship?.followedBy===true){audit.skip(live.relationship?.followedBy===true?'实时核验已回关':'实时核验已取关',user);await reconcile(user,live);await dequeue();continue;}
        if(live.relationship?.following!==true || live.relationship?.followedBy!==false){audit.skip('实时关系未知，禁止取关',user);await dequeue();continue;}
        // Re-read after network lookup so disabling or adding to the whitelist takes effect.
        const latest=await config();
        if(!latest.autoUnfollow || latest.autoUnfollowAccount?.id!==cfg.autoUnfollowAccount.id || !inUnfollowWindow(latest,now()))break;
        user=await refreshCandidate(user);
        if(!user || !eligibleAutoUnfollow(user,latest,now())){await dequeue();continue;}
        if(state.used>=latest.dailyLimit)break;
        state.used=(state.used||0)+1;attempted++;
        state.lastAttemptAt=now();
        state.pending={user:{...user,id:live.id},at:now()};
        await persist(); // Reserve before the request; ambiguous attempts count too.
        audit.stage('打开主页并取消关注',{'提交状态':'已预留额度，正在核验页面操作'});
        const result=await unfollow(live,latest);
        audit.stage('核对页面操作结果',{'操作状态':result?.status||0,'请求是否发出':result?.attempted===false?'未操作':'已点击页面操作，需核验结果'});
        if(result?.attempted===false){
          // Release only this round's reservation after a definite no-action result.
          // Historical usage and ambiguous/submitted actions must remain intact.
          state.pending=null;state.used=Math.max(0,state.used-1);attempted--;
          await persist();
          audit.stage('核对页面操作结果',{'提交状态':'明确未提交，已释放本轮预留额度','今日已用':state.used});
        }
        if(result?.attempted===false && result.live?.relationship?.followedBy===true){state.pending=null;await persist();await reconcile(user,result.live);audit.skip('最终核验对方已关注，禁止取关',user);await dequeue();continue;}
        if(result?.status<200 || result?.status>=300 || !result?.status){
          // A definite rejection or a request never dispatched is safe to retry next round.
          // Transport failures and server errors remain pending until independently confirmed.
          if(result?.attempted===false || (result?.status>=400 && result?.status<500)){state.pending=null;await persist();}
          if(result?.attempted===false){state.queue=state.queue.filter(item=>item!==handle);state.queue.push(handle);await persist();}
          throw new Error(`取关页面操作未确认成功（${result?.status||'无响应'}）${result?.error?'：'+result.error:''}，本轮已停止`);
        }
        audit.stage('复查实际关注关系');
        const verified=await profile(user,latest);
        if(verified.relationship?.following!==false)throw new Error('取关结果待确认，本轮已停止');
        audit.stage('回写取关结果',{'操作后关系':'我关注对方：否','请求是否发出':'已完成页面操作并核验'});
        await reconcile(user,verified);
        state.pending=null;state.lastSuccessAt=now();await dequeue();
        completed++;unfollowedHandles.push(handle);
      }
      audit.stage('本轮结束',{'提交状态':completed?'已确认取关并回写本地':'本轮未新增取关'});
      if(!repaired)await audit.event({scope:'unreciprocated',summary:completed ? `自动取关 @${unfollowedHandles[0]} 成功` : `自动取关完成：成功 ${completed} 人，本轮尝试 ${attempted} 人，今日已用 ${state.used||0}/${cfg.dailyLimit}`,handle:completed?unfollowedHandles[0]:undefined,result:'success',unfollowedHandles:[...unfollowedHandles]},{'符合超时条件人数':users.length,'成功人数':completed,'处理次数':attempted,'关系核验人数':checked,'排队人数':state.queue.length,'今日已用':state.used,'结束原因':attempted>=cap?'本轮已处理 1 人':checked>=MAX_PROFILE_CHECKS_PER_ROUND?'达到本轮关系核验上限':'本轮候选检查结束'});
      return {completed,attempted,repaired};
    } catch(error) {
      await audit.event({scope:'unreciprocated',summary:`自动取关${currentTarget?.handle?' @'+currentTarget.handle:''}已停止：${error.message}`,result:'failed'},{'错误原因':error.message,'错误类型':error.name,'错误代码':error.code||'未提供',...(error.status!=null?{'HTTP状态':error.status}:{}),'处理次数':attempted,'成功人数':completed,'处理建议':'核对目标关系及接口状态；有待确认记录时不会重复取关'}).catch(()=>{});
      return {completed,attempted,error:error.message};
    } finally {running=false;}
  }
  return {run,schedule};
}
