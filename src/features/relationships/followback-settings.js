// Settings are a small independent write, never a tracker-record rewrite.
export function withFollowbackProgress(settings, progress = {}) {
  if (!progress.lastRunAt || (settings.lastRunAt && progress.lastRunAt < settings.lastRunAt)) return settings;
  return {...settings,lastRunAt:progress.lastRunAt,lastSummary:progress.lastSummary || settings.lastSummary};
}
export async function saveFollowbackSettings(config, api = chrome) {
  if(config.autoUnfollow || config.autoGreeting){
    let timer;
    const identity=await Promise.race([
      api.runtime.sendMessage({cmd:'sidebarIdentity'}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('账号核验超时，配置未保存，请确认 X 页面已加载后重试')),8000);})
    ]).finally(()=>clearTimeout(timer));
    if(!identity?.account?.id || !identity?.account?.handle)throw new Error('请先打开并登录 X，确认当前账号后再启用自动任务');
    const account={id:String(identity.account.id),handle:identity.account.handle};
    config={...config,...(config.autoUnfollow?{autoUnfollowAccount:account}:{}),...(config.autoGreeting?{autoGreetingAccount:account}:{})};
  }
  await api.storage.local.set({unreciprocatedSettings:config});
  // Auxiliary scheduling/sync must not hold the local save button hostage.
  Promise.resolve().then(()=>api.runtime.sendMessage({cmd:'configureUnreciprocatedTracker',config})).catch(error=>console.warn('回关监控计划更新失败',error));
  if(api.storage.sync)Promise.resolve().then(()=>api.storage.sync.set({unreciprocatedSettings:config})).catch(error=>console.warn('回关监控云同步失败，本地配置已保存',error));
  return config;
}
