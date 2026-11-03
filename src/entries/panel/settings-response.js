// Settings reads and acknowledgements must not keep controls busy forever.
// A timeout ends only the UI wait; it never replays or claims a write succeeded.
export function awaitSettingsResponse(operation,{timeoutMs=8000,message='读取设置超时，请稍后重试'}={}) {
  let timer;
  const response=Promise.resolve().then(()=>typeof operation==='function'?operation():operation);
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
    const error=new Error(message);error.name='SettingsResponseTimeoutError';reject(error);
  },timeoutMs);});
  return Promise.race([response,deadline]).finally(()=>clearTimeout(timer));
}
