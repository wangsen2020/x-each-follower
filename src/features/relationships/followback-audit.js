// Explicit diagnostics only: never persist page HTML, message text, tokens or request headers.
export function createFollowbackAudit(action,write,now=Date.now){
 const runId=crypto.randomUUID(),startedAt=now(),reasons={},samples=[];
 let stage='读取配置',context={};
 return {
  stage(value,fields={}){stage=value;Object.assign(context,fields);},
  skip(reason,user){reasons[reason]=(reasons[reason]||0)+1;if(samples.length<20&&user?.handle)samples.push(`@${user.handle}：${reason}`);},
  event(entry,fields={}){return write({...entry,runId,action,details:{'轮次编号':runId,'阶段':stage,'耗时毫秒':now()-startedAt,...context,...fields,'跳过原因统计':{...reasons},'跳过账号示例-最多20个':[...samples]}});}
 };
}
export function reminderSkipReason(user,days,now=Date.now()){
 if(!user)return '本地记录已不存在';
 if(['suspended','not_found'].includes(user.accountAvailability?.status))return user.accountAvailability.status==='suspended'?'账号已封禁':'账号不存在';
 if(user.status==='mutual')return '已经回关';
 if(user.status==='unfollowed')return '已经取关';
 if(!['pending','overdue'].includes(user.status))return '关系状态待确认';
 if(!Number.isFinite(Date.parse(user.followedAt)))return '关注时间无效';
 if(now-Date.parse(user.followedAt)<Math.max(1,Number(days)||1)*86400000)return '未到提醒时间';
 return '条件已变化';
}
export function unfollowSkipReason(user,cfg,now=Date.now()){
 if(!user)return '本地记录已不存在';
 if(user.exempt)return '已豁免';
 if(String(cfg.whitelist||'').split(/[,，\s]+/).some(h=>h.replace(/^@/,'').toLowerCase()===String(user.handle||'').toLowerCase()))return '白名单保护';
 const basic=reminderSkipReason(user,cfg.overdueDays,now);
 if(basic==='未到提醒时间')return '尚未超过取关期限';
 if(basic!=='条件已变化')return basic;
 if(user.relationship?.followedBy===true)return '已经回关';
 if(user.relationship?.following===false)return '已经取关';
 return '关注关系不明确或账号格式无效';
}
