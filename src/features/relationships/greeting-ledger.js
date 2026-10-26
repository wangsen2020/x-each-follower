export function greetingKey(ownerId,targetId){
  if(!/^\d+$/.test(String(ownerId))||!/^\d+$/.test(String(targetId)))throw new Error('私信账号 ID 无效');
  return `firstGreeting:${ownerId}:${targetId}`;
}
export const greetingWasClaimed=record=>Boolean(record?.remindedAt || ['sent','uncertain'].includes(record?.status));
// Shared by manual and automatic sends. An uncertain claim never expires automatically.
export function createGreetingLedger({storage,write=value=>storage.set(value),now=Date.now}){
 const locks=new Set();
 return {
  async read(ownerId,targetId){const key=greetingKey(ownerId,targetId);return (await storage.get(key))[key];},
  async claim(message){
   const key=greetingKey(message.ownerId,message.targetId);
   if(locks.has(key))return {ok:false,error:'该账号的私信发送正在处理中'};
   locks.add(key);
   try{
    const prior=(await storage.get(key))[key];
    if(message.once && greetingWasClaimed(prior))return {ok:false,duplicate:true,error:'已提醒或发送结果待确认，跳过重复私信'};
    const token=crypto.randomUUID();
    await write({[key]:{...prior,ownerId:String(message.ownerId),targetId:String(message.targetId),handle:message.handle,status:'uncertain',token,claimedAt:new Date(now()).toISOString(),remindedAt:prior?.remindedAt || (greetingWasClaimed(prior)?prior.claimedAt || new Date(now()).toISOString():null)}});
    return {ok:true,token};
   }finally{locks.delete(key);}
  },
  async finish(message){
   const key=greetingKey(message.ownerId,message.targetId),prior=(await storage.get(key))[key];
   if(!prior||prior.token!==message.token)return {ok:false,error:'私信记录校验失败'};
   const status=['sent','not_sent'].includes(message.status)?message.status:'uncertain';
   await write({[key]:{...prior,status,remindedAt:prior.remindedAt || (status!=='not_sent'?new Date(now()).toISOString():null),messageId:String(message.messageId||''),reason:String(message.reason||'').slice(0,240),completedAt:new Date(now()).toISOString()}});
   return {ok:true,status};
  }
 };
}
