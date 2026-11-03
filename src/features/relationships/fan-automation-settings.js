export const FAN_AUTOMATION_DEFAULTS = Object.freeze({
  review: {enabled:true,intervalMinutes:1,limit:20},
  verify: {enabled:true,intervalMinutes:2,limit:5,retryMinutes:60}
});
const number=(value,fallback,min,max)=>value==null||value===''||!Number.isFinite(Number(value))?fallback:Math.max(min,Math.min(max,Math.round(Number(value))));
export function normalizeFanAutomation(input={}) {
  return Object.fromEntries(Object.entries(FAN_AUTOMATION_DEFAULTS).map(([kind,defaults])=>{
    const value=input?.[kind]||{};
    return [kind,{enabled:value.enabled!==false,intervalMinutes:number(value.intervalMinutes,defaults.intervalMinutes,1,60),limit:number(value.limit,defaults.limit,1,50),
      ...(kind==='verify'?{retryMinutes:number(value.retryMinutes,60,5,1440)}:{})}];
  }));
}
export function validateFanAutomation(input={}) {
  for(const kind of ['review','verify'])for(const [key,max]of [['intervalMinutes',60],['limit',50],...(kind==='verify'?[['retryMinutes',1440]]:[])]) {
    const value=input?.[kind]?.[key];if(value===undefined)continue;
    if(value===''||value===null||!Number.isInteger(Number(value))||Number(value)<(key==='retryMinutes'?5:1)||Number(value)>max)throw Error('自动调度参数无效：间隔 1–60 分钟，每轮 1–50 人，核实重试间隔 5–1440 分钟');
  }
  for(const kind of ['review','verify'])if(input?.[kind]?.enabled!==undefined&&typeof input[kind].enabled!=='boolean')throw Error('自动调度开关无效');
  return normalizeFanAutomation(input);
}
export function mergeFanAutomation(current,patch) {
  const base=normalizeFanAutomation(current);
  return Object.fromEntries(['review','verify'].map(kind=>[kind,{...base[kind],...(patch?.[kind]||{})}]));
}
