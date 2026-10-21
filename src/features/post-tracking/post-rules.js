// Shared by the settings form, list evaluation, and scheduled review selection.
export const LOW_RULE_FIELDS = [
  {key:'matureHours',label:'观察时长',unit:'小时',default:72,min:24,max:2160,hint:'发布达到此时长后，才进入低价值候选。'},
  {key:'sampleMin',label:'同龄样本下限',unit:'条',default:20,min:20,max:200,hint:'同类型、采集帖龄相差不超过24小时的有效曝光样本；不足时不判断曝光高低。'},
  {key:'lowPercentile',label:'曝光后位比例',unit:'%',default:20,min:1,max:50,hint:'曝光不超过同龄样本此百分位，且低于中位数比例，才判为低曝光。'},
  {key:'medianPercent',label:'曝光中位数比例',unit:'%',default:25,min:1,max:100,hint:'曝光必须低于同龄样本中位数乘此比例，并满足后位比例条件。'},
  {key:'stagnantHours',label:'停滞观察时长',unit:'小时',default:48,min:24,max:168,hint:'需要间隔至少此时长的有效快照；用于展示曝光是否长期停滞，不产生删除建议。'},
  {key:'stagnantAbsolute',label:'停滞曝光增量',unit:'次',default:5,min:0,max:1000,hint:'停滞阈值取该值与历史曝光增长比例计算值中的较大值。'},
  {key:'stagnantPercent',label:'停滞增长比例',unit:'%',default:5,min:0,max:100,hint:'与停滞曝光增量共同判断；曝光下降或数据缺失不会判为停滞。'},
];
export function normalizeLowRules(value={}) {
  return Object.fromEntries(LOW_RULE_FIELDS.map(f=>[f.key,Number.isInteger(value?.[f.key])&&value[f.key]>=f.min&&value[f.key]<=f.max?value[f.key]:f.default]));
}
export function validateLowRules(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('低质帖配置无效');
  for(const f of LOW_RULE_FIELDS)if(!Number.isInteger(value[f.key])||value[f.key]<f.min||value[f.key]>f.max)throw new Error(`${f.label}需为${f.min}–${f.max}的整数`);
  return normalizeLowRules(value);
}
