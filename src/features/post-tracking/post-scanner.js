import {normalizeLowRules} from './post-rules.js';
import {ANALYTICS_METRICS,comparePosts,evaluatePost} from './post-model.js';

export const BATCH_LIMIT=100;
export const MIN_BATCH_DELAY=120000;
const DAY=86400000, WINDOW=6*3600000;
export const monitorInterval=value=>[15,30,60].includes(Number(value))?Number(value):15;
export const batchLimit=value=>Number.isInteger(Number(value))&&Number(value)>=10&&Number(value)<=1000?Number(value):BATCH_LIMIT;
export const reviewInterval=value=>[12,24,48].includes(Number(value))?Number(value):24;
const eligible=p=>!p.deletion||p.deletion.status==='failed';

// X analytics supplies no cursor and may exceed max_results. Persist time windows
// instead; each invocation performs just one request, even when splitting a window.
export function planBatch(previous,posts,days,now,settings={}) {
  const state=structuredClone(previous?.version===1?previous:{version:1,phase:0,lanes:{},batches:0});
  const sorted=posts.filter(eligible).sort(comparePosts);
  const recent=sorted.filter(p=>p.availability!=='unavailable').slice(0,30);
  const recentFrom=Math.max(now-90*DAY,Math.min(now-DAY,...recent.map(p=>p.createdAt)));
  const due=sorted.filter(p=>!p.protected&&now-p.createdAt>=normalizeLowRules(settings.lowRules).matureHours*3600000&&now-p.createdAt<=90*DAY&&now-p.capturedAt>=reviewInterval(settings.reviewIntervalHours)*3600000&&(['auto-quote','auto-original'].includes(p.source?.kind)||evaluatePost(p,sorted,now,undefined,settings.lowRules).low)).sort((a,b)=>a.capturedAt-b.capturedAt);
  let lane=['recent','review','history','head'][state.phase%4];
  if(lane==='review'&&!due.length&&!state.lanes.review?.pending?.length)lane='history';
  let scan=state.lanes[lane];
  if(lane==='head'&&!scan?.pending?.length){
    scan={pending:[{from:now-WINDOW+1,to:now}],cycles:(scan?.cycles||0)};
  }else if(lane==='review'&&!scan?.pending?.length){
    const end=Math.min(now,Math.floor(due[0].createdAt/WINDOW)*WINDOW+WINDOW-1);
    scan={pending:[{from:end-WINDOW+1,to:end}],cycles:(scan?.cycles||0)};
  }else if(!scan?.pending?.length&&(scan?.cursor==null||scan.cursor<scan.floor||lane==='history'&&scan.days!==days)){
    const floor=lane==='recent'?recentFrom:Math.max(now-90*DAY,Math.min(now-days*DAY,...sorted.map(p=>p.createdAt)));
    scan={floor,cursor:now,days,cycles:(scan?.cycles||0),pending:[]};
  }
  if(!scan.pending.length){scan.pending.push({from:Math.max(scan.floor,scan.cursor-WINDOW+1),to:scan.cursor});}
  state.lanes[lane]=scan;
  return {state,lane,window:scan.pending[0],limit:batchLimit(settings.batchLimit)};
}

export function batchVariables(window,limit=BATCH_LIMIT){return {from_time:new Date(window.from).toISOString(),to_time:new Date(window.to).toISOString(),max_results:batchLimit(limit),query_page_size:batchLimit(limit),requested_metrics:ANALYTICS_METRICS};}

export function finishBatch(plan,count,now){
  const {state,lane,window}=plan,scan=state.lanes[lane];
  const limit=batchLimit(plan.limit);
  state.last={lane,from:window.from,to:window.to,received:count,limit,at:now,split:count>=limit};
  state.batches++;
  if(count>=limit){
    if(window.to-window.from<1000)throw new Error(`最小时间窗口仍达到${limit}条，停止推进以避免漏帖；请稍后检查接口。`);
    const middle=Math.floor((window.from+window.to)/2);
    scan.pending.splice(0,1,{from:middle+1,to:window.to},{from:window.from,to:middle});
  }else{
    scan.pending.shift();
    if(!scan.pending.length){scan.cursor=window.from-1;if(lane==='review'||lane==='head'||scan.cursor<scan.floor)scan.cycles++;}
    state.phase=(state.phase+1)%4;
  }
  return state;
}
