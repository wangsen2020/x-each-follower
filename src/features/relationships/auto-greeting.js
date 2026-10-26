import {createFollowbackAudit,reminderSkipReason} from './followback-audit.js';
import {greetingDue} from './greeting-chat.js';
import {greetingWasClaimed} from './greeting-ledger.js';
export const AUTO_GREETING_ALARM='x-auto-greeting';
export function createAutoGreeting({storage,alarms,candidates,refresh,owner,profile,send,ledger,log,now=Date.now,random=Math.random}){
 let running=false;
 const config=async()=>(await storage.get('unreciprocatedSettings')).unreciprocatedSettings||{};
 async function schedule(afterRun=false){
  const cfg=await config();
  if(!cfg.autoGreeting){await alarms.clear(AUTO_GREETING_ALARM);return;}
  const prior=await alarms.get(AUTO_GREETING_ALARM);
  if(afterRun || !prior || prior.periodInMinutes || prior.scheduledTime<=now())await alarms.create(AUTO_GREETING_ALARM,{delayInMinutes:4+random()*2});
 }
 async function run(){
  if(running){await log({source:'greeting-auto-summary',result:'skipped',summary:'自动私信未启动：上一轮仍在执行'});return {skipped:'running'};}
  const audit=createFollowbackAudit('自动私信',log,now);let stopReason='本轮候选检查完成';
  running=true;const counts={sent:0,skipped:0,failed:0,uncertain:0};let attempted=0,examined=0,total=0;
  try{
   const cfg=await config();
   audit.stage('检查启用状态',{'等待天数':cfg.greetingAfterDays,'每轮上限':5,'绑定账号':cfg.autoGreetingAccount?.handle||'未绑定'});
   if(!cfg.autoGreeting){await audit.event({source:'greeting-auto-summary',result:'skipped',summary:'自动私信未执行：开关已关闭'});return {skipped:'disabled'};}
   if(!cfg.autoGreetingAccount?.id)throw new Error('请重新保存自动私信设置以绑定当前账号');
   await audit.event({source:'greeting-auto-start',result:'started',summary:'开始自动私信检查'});
   audit.stage('核验当前登录账号');
   const account=await owner(cfg.autoGreetingAccount);
   audit.stage('读取候选记录');
   const allCandidates=await candidates();total=allCandidates.length;
   audit.stage('筛选候选记录',{'候选记录总数':total});
   for(const original of allCandidates){
    if(attempted>=5){stopReason='达到本轮处理上限，剩余账号留待下轮';break;}
    examined++;
    if(!greetingDue(original,cfg.greetingAfterDays,now())){audit.skip(reminderSkipReason(original,cfg.greetingAfterDays,now()),original);counts.skipped++;continue;}
    let token,target,result;
    try{
     audit.stage('核验本地条件',{'目标账号':original.handle,'关注时间':original.followedAt,'已等待天数':Math.floor((now()-Date.parse(original.followedAt))/86400000)});
     const latest=await config();if(!latest.autoGreeting||latest.autoGreetingAccount?.id!==account.id){stopReason='执行中关闭开关或绑定账号变化';break;}
     const user=await refresh(original);
     if(!user || !greetingDue(user,latest.greetingAfterDays,now())){audit.skip(reminderSkipReason(user,latest.greetingAfterDays,now()),original);counts.skipped++;continue;}
     // Stable user IDs survive handle changes; check history before opening a chat.
     if(user.id && greetingWasClaimed(await ledger.read(account.id,user.id))){audit.skip('已提醒或历史发送结果待确认',user);counts.skipped++;continue;}
     audit.stage('实时查询关注关系');
     target=await profile(user,account);
     if(target.relationship?.following!==true || target.relationship?.followedBy!==false){audit.skip(target.relationship?.followedBy===true?'实时核验已回关':target.relationship?.following===false?'实时核验已取关':'实时关系不明确',user);counts.skipped++;continue;}
     const prior=await ledger.read(account.id,target.id);
     if(greetingWasClaimed(prior)){audit.skip('已提醒或发送结果待确认',user);counts.skipped++;continue;}
     attempted++;
     audit.stage('打开聊天并准备发送');
     result=await send(user,target,account,latest,async()=>{
      audit.stage('提交前再次核验');
      const active=await config();
      if(!active.autoGreeting||active.autoGreetingAccount?.id!==account.id)throw new Error('自动私信已关闭或账号已变化');
      const fresh=await refresh(user);
      if(!fresh||!greetingDue(fresh,active.greetingAfterDays,now()))throw new Error('账号已不符合提醒条件');
      const live=await profile(fresh,account);
      if(live.id!==target.id || live.relationship?.following!==true || live.relationship?.followedBy!==false)throw new Error('关注关系已变化，跳过私信');
      const claim=await ledger.claim({ownerId:account.id,targetId:target.id,handle:target.handle,once:true});
      if(!claim.ok)throw new Error(claim.error);token=claim.token;
      await audit.event({source:'greeting-auto',handle:target.handle,result:'started',summary:`自动私信 @${target.handle}：准备发送，已锁定防重复记录`},{'提交状态':'尚未提交','重试策略':'已持久化锁定，重启不会重复提交'});
     });
     if(token){const finished=await ledger.finish({ownerId:account.id,targetId:target.id,token,status:result.ok?'sent':result.submitted?'uncertain':'not_sent',messageId:result.messageId,reason:result.reason});if(!finished.ok)throw new Error(finished.error);}
     const status=result.ok?'sent':result.submitted?'uncertain':'failed';counts[status]++;
     await audit.event({handle:target.handle,source:'greeting-auto',result:status,summary:`自动私信 @${target.handle}：${result.ok?'发送成功':result.submitted?'结果待确认，不再自动重发':result.reason||'未发送'}`,messageId:result.messageId},{'提交状态':result.ok?'已确认发送':result.submitted?'可能已提交':'未提交','消息编号':result.messageId||'无','聊天诊断':result.diagnostics||{},'重试策略':result.ok?'不再提醒':result.submitted?'禁止自动重发，请核对会话':'下轮调度重新核验，按实际返回处理'});
     if(result.submitted && !result.ok){stopReason='发送结果不确定，停止本轮并禁止重发该账号';break;}
    }catch(error){
     counts.failed++;
     attempted++;
     await audit.event({source:'greeting-auto',handle:target?.handle||original.handle,result:'failed',summary:`自动私信跳过/失败 @${original.handle}：${error.message}`},{'错误类型':error.name,'错误代码':error.code||'未提供','HTTP状态':error.status??'不适用','提交状态':token?'已锁定，需核对会话':'尚未提交','重试策略':token?'禁止自动重发':'下轮调度重新核验，按实际返回处理'});
     if(token || error.code!=='X_PROFILE_UNAVAILABLE'){stopReason='核验或发送异常，提前结束本轮';break;}
    }
   }
   audit.stage('本轮结束');
   await audit.event({source:'greeting-auto-summary',result:'completed',summary:`自动私信检查：成功 ${counts.sent}，跳过 ${counts.skipped}，失败 ${counts.failed}，待确认 ${counts.uncertain}`},{'结束原因':stopReason,'本轮检查数':examined,'本轮尚未检查':total-examined,'处理次数':attempted,'重试说明':'成功/待确认不重发；明确未发送留待下轮调度重新核验；其余候选下一轮继续'});
   return counts;
  }catch(error){await audit.event({source:'greeting-auto',result:'failed',summary:`自动私信停止：${error.message}`},{'错误类型':error.name,'错误代码':error.code||'未提供','HTTP状态':error.status??'不适用','提交状态':'尚未提交','处理建议':'核对绑定账号登录态和网络；不是账号注销判断'});return {...counts,error:error.message};}
  finally{try{await schedule(true);}finally{running=false;}}
 }
 return {run,schedule};
}
