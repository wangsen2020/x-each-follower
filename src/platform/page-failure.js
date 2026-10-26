// Never retain query strings, credentials, page bodies or request headers.
export function diagnosticUrl(value) {
  try { const u=new URL(value);return ['http:','https:','chrome-error:'].includes(u.protocol)?`${u.origin==='null'?u.protocol+'//'+u.host:u.origin}${u.pathname}`.slice(0,500):''; } catch { return ''; }
}
export function diagnosticText(value) {
  return String(value||'').replace(/Bearer\s+\S+/gi,'Bearer [已隐藏]').replace(/((?:authorization|cookie|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隐藏]').replace(/https?:\/\/[^\s)]+/g,diagnosticUrl).slice(0,2000);
}
export function isPageFailure(error) {
  return /showing error page|chrome-error:\/\/|No (?:tab|frame) with|tab (?:was )?closed|frame (?:was )?removed|Cannot access contents of url|ERR_[A-Z_]+/i.test(String(error?.message||error));
}
export function pageFailureMessage(error) {
  if (error?.code === 'X_PROFILE_READ_LIMIT') return '用户资料接口限流，未发送关注请求；稍后重试。';
  if (error?.code === 'X_PROFILE_READ_TIMEOUT') return '主页资料读取超时，未发送关注请求；将按重试规则处理。';
  return isPageFailure(error)?'X 页面加载失败或标签页已失效，已结束当前步骤；后续任务继续处理。':'队列步骤执行失败，已记录排查信息，请查看关注队列执行日志。';
}
export async function capturePageFailure(api,error,context={}) {
  const tabId=error?.pageContext?.tabId??context.tabId;
  const tab=tabId!=null&&api.tabs?.get?await api.tabs.get(tabId).catch(()=>null):null;
  const inherited=error?.pageContext||{};
  const stage=inherited.stage||context.stage||'unknown';
  const labels={'check-account':'校验当前登录账号','open-profile':'打开并读取主页','resolve-user':'核验用户身份','read-posts':'滚动读取帖子','save-profile':'保存账号资料','following':'发送关注','remove-follower':'移除异常比例关注者','evaluating':'生成引用评价','publishing':'发布引用评价','verify-publication':'核验发布结果','bootstrap':'准备登录页面','sync-candidates':'同步候选账号','run-queue':'执行队列','reflect-results':'同步处理结果','schedule-next':'安排下轮任务','x-storage':'读写X本地备份'};
  return {id:crypto.randomUUID(),at:new Date().toISOString(),code:isPageFailure(error)?'X_PAGE_UNAVAILABLE':['X_PROFILE_READ_TIMEOUT','X_PROFILE_READ_LIMIT'].includes(error?.code)?error.code:'QUEUE_STEP_FAILED',
    stage,stageLabel:context.stageLabel||labels[stage]||stage,
    operation:inherited.operation||context.operation||'',handle:context.handle||'',accountId:context.accountId||'',targetUserId:context.targetUserId||'',jobId:context.jobId||'',runId:context.runId||'',tabId:tabId??null,
    requestedUrl:diagnosticUrl(inherited.requestedUrl||context.requestedUrl),actualUrl:diagnosticUrl(tab?.url),pendingUrl:diagnosticUrl(tab?.pendingUrl),tabStatus:tab?.status||(tabId!=null?'closed':'not-recorded'),discarded:tab?.discarded===true,
    ...(error?.code==='X_PROFILE_READ_LIMIT'?{networkEvidence:error.networkEvidence}:{}),
    rawError:diagnosticText(error?.message||error),stack:diagnosticText([error?.stack,inherited.callerStack].filter(Boolean).join('\n')),online:globalThis.navigator?.onLine??null,
    trigger:context.manual===true?'manual':context.manual===false?'scheduled':'unknown',followAttempted:context.followAttempted===true,followSucceeded:context.followSucceeded===true,
    retryCount:Number(context.retryCount)||0,settings:Object.fromEntries(['batchLimit','inspectLimit','timeBudgetMinutes','scrollRounds','dwellSeconds','grokEnabled','autoPublish'].filter(k=>context.settings?.[k]!=null).map(k=>[k,context.settings[k]])),
    recentStages:(context.recentStages||[]).slice(-12).map(s=>({stage:s.stage,at:s.at})),
    browser:diagnosticText(globalThis.navigator?.userAgent||'').slice(0,200)};
}
