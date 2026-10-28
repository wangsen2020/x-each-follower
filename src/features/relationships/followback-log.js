export function followbackLogPresentation(log){
 const source=log.source?.startsWith('greeting-auto')?'自动私信':log.source?.startsWith('greeting-')?'手动私信':(log.origin==='autoUnfollow'||log.action==='自动取关'||log.source==='unfollow-auto')?'自动取关':({'unfollow-manual':'手动取关','unfollow-batch':'批量取关',manual:'手动检测',open:'打开页面',availability:'账号状态更新',alarm:'定时检测',scheduled:'定时检测'}[log.source]||'本地检测');
 const details=log.details||{};
 // Compatibility is presentation-only: never rewrite the stored historical outcome.
 const legacyEmpty=source==='自动取关' && log.result==='success' && details['阶段']==='本轮结束' && details['成功人数']===0 && details['处理次数']===0 && Array.isArray(log.unfollowedHandles) && log.unfollowedHandles.length===0;
 const result=legacyEmpty ? details['清理不存在账号数']>0?'cleaned':'waiting' : log.result;
 const labels={sent:'发送成功 ✓',success:'执行完成 ✓',completed:'检查完成',cleaned:'清理完成',waiting:'等待处理',started:'准备发送',uncertain:'待确认 · 不重发',skipped:'已跳过',failed:'执行失败'};
 const reason=details['排队人数']>0 ? '剩余账号待核实，稍后继续检查' : details['跳过原因统计']?.['上次操作待确认，已隔离']>0 ? `暂无可取关账号；${details['跳过原因统计']['上次操作待确认，已隔离']} 个账号待确认，已隔离` : '暂无符合条件的取关账号';
 const summary=legacyEmpty ? result==='cleaned'?`已清理不存在账号 ${details['清理不存在账号数']} 个；${reason}`:`自动取关等待：${reason}` : log.summary;
 return {source,...(source==='自动取关'?{summary,showTarget:!(details['阶段']==='本轮结束' && ['waiting','cleaned'].includes(result))}:{}),label:result==='started'&&(source==='自动取关'||log.source==='greeting-auto-start')?'检查开始':labels[result]||'状态更新',tone:['sent','success','completed','cleaned'].includes(result)?'candidate':result==='failed'?'failed':'review'};
}

// Read both current structured targets and older diagnostic-only records.
export function followbackLogContext(log){
 const details=log.details||{};
 const cleanHandle=value=>{
  const handle=String(value||'').replace(/^@/,'');
  return /^[a-z0-9_]{1,15}$/i.test(handle)?handle:'';
 };
 const handle=cleanHandle(log.target?.handle)||cleanHandle(log.handle)||cleanHandle(details['目标账号']);
 const id=String(log.target?.id||details['目标账号ID']||details['本地账号ID']||'');
 const rows=[];
 const add=(label,value)=>{if(value!==undefined&&value!==null&&value!=='')rows.push({label,value:String(value)});};
 if(handle)add('账号 ID',id||'未记录');
 add('绑定账号',details['绑定账号']);
 add('阶段',details['阶段']);
 add('操作前关系',details['核验关系']);
 add('操作后关系',details['操作后关系']);
 add('执行状态',details['提交状态']);
 add('页面操作',details['请求是否发出']);
 add('操作状态',details['操作状态']);
 add('HTTP 状态',details['HTTP状态']);
 if(details['实时账号ID']!==undefined)add('实时 ID',details['实时账号ID']);
 if(details['错误代码']&&details['错误代码']!=='未提供')add('错误代码',details['错误代码']);
 add('原因',details['错误原因']||details['核验说明']||log.error);
 if(log.result==='failed'&&!rows.some(row=>row.label==='原因'))add('原因',log.summary||log.detail||'旧日志未记录失败原因');
 add('轮次',log.runId||details['轮次编号']);
 return {handle,name:log.target?.name||details['目标昵称']||'',rows};
}
