export const DAY_MS=86400000;
const ZONE_OFFSET_MS=8*3600000;

export function shanghaiDay(at){
  if(!Number.isFinite(at))throw new Error('采集时间无效');
  return new Date(at+ZONE_OFFSET_MS).toISOString().slice(0,10);
}

export function dayWindow(day){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('统计日期无效');
  const start=Date.parse(day+'T00:00:00+08:00');
  if(!Number.isFinite(start)||shanghaiDay(start)!==day)throw new Error('统计日期无效');
  return {from:start,to:start+DAY_MS};
}

export function previousDay(day){return shanghaiDay(dayWindow(day).from-1);}

export function followerDelta(snapshots,day){
  const previous=previousDay(day),valid=(snapshots||[]).filter(s=>Number.isSafeInteger(s.followers)&&s.followers>=0&&Number.isFinite(s.at));
  const select=d=>valid.filter(s=>shanghaiDay(s.at)===d).sort((a,b)=>a.at-b.at)[0];
  const before=select(previous),after=select(day);
  if(!before||!after)return {status:'baseline_missing',delta:null,before:before||null,after:after||null};
  const elapsed=after.at-before.at;
  if(elapsed<18*3600000||elapsed>30*3600000)return {status:'interval_invalid',delta:null,before,after};
  return {status:'valid',delta:after.followers-before.followers,before,after};
}

export function rankMembers(members,snapshotsByCreator,day){
  return (members||[]).filter(member=>member.active!==false).map(member=>{
    const delta=followerDelta(snapshotsByCreator.get(member.creatorId)||[],day);
    return {...member,delta:delta.delta,deltaStatus:delta.status,deltaEvidence:{before:delta.before,after:delta.after}};
  }).sort((a,b)=>{
    const av=a.deltaStatus==='valid',bv=b.deltaStatus==='valid';
    if(av!==bv)return av?-1:1;
    if(av&&a.delta!==b.delta)return b.delta-a.delta;
    return a.creatorId.localeCompare(b.creatorId);
  });
}

export function yesterdayPosts(posts,day){
  const {from,to}=dayWindow(day);
  return (posts||[]).filter(p=>Number.isFinite(p.createdAt)&&p.createdAt>=from&&p.createdAt<to&&p.kind!=='reply'&&p.kind!=='repost');
}

export function selectDigestPosts(posts,day,limit=30){
  return yesterdayPosts(posts,day).sort((a,b)=>{
    const av=a.metrics?.views,bv=b.metrics?.views;
    if(Number.isFinite(av)!==Number.isFinite(bv))return Number.isFinite(av)?-1:1;
    if(Number.isFinite(av)&&av!==bv)return bv-av;
    const ae=(a.metrics?.likes||0)+(a.metrics?.replies||0)+(a.metrics?.reposts||0);
    const be=(b.metrics?.likes||0)+(b.metrics?.replies||0)+(b.metrics?.reposts||0);
    return be-ae||b.createdAt-a.createdAt;
  }).slice(0,limit);
}
