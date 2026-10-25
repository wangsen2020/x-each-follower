export function followbackLogPresentation(log){
 const source=log.source?.startsWith('greeting-auto')?'自动私信':log.source?.startsWith('greeting-')?'手动私信':(log.origin==='autoUnfollow'||log.action==='自动取关'||log.source==='unfollow-auto')?'自动取关':({'unfollow-manual':'手动取关','unfollow-batch':'批量取关',manual:'手动检测',open:'打开页面',availability:'账号状态更新',alarm:'定时检测',scheduled:'定时检测'}[log.source]||'本地检测');
 const labels={sent:'发送成功 ✓',success:'执行完成 ✓',completed:'检查完成',started:'准备发送',uncertain:'待确认 · 不重发',skipped:'已跳过',failed:'执行失败'};
 return {source,label:log.result==='started'&&(source==='自动取关'||log.source==='greeting-auto-start')?'检查开始':labels[log.result]||'状态更新',tone:['sent','success','completed'].includes(log.result)?'candidate':log.result==='failed'?'failed':'review'};
}
