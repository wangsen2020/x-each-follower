import test from 'node:test';
import assert from 'node:assert/strict';
import {followbackLogContext,followbackLogPresentation} from '../src/features/relationships/followback-log.js';
import {createFollowbackAudit} from '../src/features/relationships/followback-audit.js';
import {collapseUnfollowSummaries} from '../src/shared/execution-log-select.js';

test('idle round cards are omitted while pending review and actual cleanup remain visible',()=>{
 const idle={source:'unfollow-auto',runId:'idle',result:'waiting',unfollowedHandles:[],details:{'阶段':'本轮结束','符合超时条件人数':0,'成功人数':0,'处理次数':0,'清理不存在账号数':0}};
 const started={source:'unfollow-auto',runId:'idle',result:'started'};
 const pending={source:'unfollow-auto',runId:'idle',result:'skipped',summary:'目标仍待确认'};
 const cleaned={...idle,runId:'cleaned',result:'cleaned',details:{...idle.details,'清理不存在账号数':2}};
 assert.deepEqual(collapseUnfollowSummaries([idle,started,pending,cleaned]),[pending,cleaned]);
 assert.deepEqual(collapseUnfollowSummaries([{...idle,details:{...idle.details,'符合超时条件人数':undefined}}]).length,1);
});

test('legacy failed target and diagnostics are visible without looking up user records',()=>{
 const view=followbackLogContext({id:'log-not-a-user-id',result:'failed',summary:'自动取关已停止：身份无法确认',details:{'目标账号':'hid65628262','本地账号ID':'1571543633765011456','阶段':'实时核验取关条件','提交状态':'尚未操作','错误代码':'TARGET_MISSING','核验说明':'资料未返回目标'}});
 assert.equal(view.handle,'hid65628262');
 const rows=Object.fromEntries(view.rows.map(r=>[r.label,r.value]));
 assert.equal(rows['账号 ID'],'1571543633765011456');
 assert.equal(rows['阶段'],'实时核验取关条件');
 assert.equal(rows['原因'],'资料未返回目标');
 assert.equal(rows['错误代码'],'TARGET_MISSING');
 assert.equal(JSON.stringify(view).includes('log-not-a-user-id'),false);
});

test('current target, zero HTTP status, reason and full run ID remain visible',()=>{
 const view=followbackLogContext({target:{handle:'target',id:'123',name:'Target'},runId:'full-run-id',details:{'操作状态':0,'HTTP状态':0,'错误原因':'连接断开','核验关系':'我关注对方：是；对方关注我：否'}});
 assert.equal(view.handle,'target');assert.equal(view.name,'Target');
 const rows=Object.fromEntries(view.rows.map(r=>[r.label,r.value]));
 assert.equal(rows['操作状态'],'0');assert.equal(rows['HTTP 状态'],'0');assert.equal(rows['原因'],'连接断开');assert.equal(rows['轮次'],'full-run-id');
});

test('missing targets and relationships are never invented from unrelated IDs or summaries',()=>{
 const view=followbackLogContext({id:'123',result:'success',summary:'完成检查',unfollowedHandles:[]});
 assert.equal(view.handle,'');assert.deepEqual(view.rows,[]);
 assert.equal(followbackLogContext({handle:'https://evil.example',details:{'目标账号':'@safe'}}).handle,'safe');
});

test('audit snapshots each active target and keeps failures directly attributable',async()=>{
 const logs=[],audit=createFollowbackAudit('自动取关',e=>logs.push(e),()=>0);
 audit.stage('核验登录账号');await audit.event({result:'started'});
 assert.equal(logs[0].handle,undefined);
 audit.stage('实时核验取关条件',{'目标账号':'first','目标账号ID':'123','目标昵称':'First'});
 await audit.event({result:'failed'},{'错误原因':'空资料'});
 audit.stage('实时核验取关条件',{'目标账号':'second','目标账号ID':'456','目标昵称':''});
 await audit.event({result:'skipped'});
 assert.equal(logs[1].handle,'first');assert.deepEqual(logs[1].target,{handle:'first',id:'123',name:'First'});
 assert.equal(logs[2].handle,'second');assert.equal(logs[1].details['目标账号'],'first');
});

test('historical zero-operation success displays as waiting without modifying historical evidence',()=>{
 const log={source:'unfollow-auto',result:'success',summary:'自动取关完成：成功 0 人',unfollowedHandles:[],details:{'阶段':'本轮结束','成功人数':0,'处理次数':0,'排队人数':0,'跳过原因统计':{'上次操作待确认，已隔离':1}}};
 const saved=structuredClone(log),view=followbackLogPresentation(log);
 assert.equal(view.label,'等待处理');assert.equal(view.tone,'review');assert.equal(view.showTarget,false);
 assert.match(view.summary,/暂无可取关账号；1 个账号待确认/);assert.doesNotMatch(view.summary,/成功 0/);
 assert.deepEqual(log,saved);
 const cleaned=followbackLogPresentation({...log,details:{...log.details,'清理不存在账号数':7}});
 assert.equal(cleaned.label,'清理完成');assert.match(cleaned.summary,/已清理不存在账号 7 个/);
 for(const patch of [{details:{...log.details,'处理次数':1}},{unfollowedHandles:['real']},{source:'unfollow-manual'},{details:{...log.details,'成功人数':undefined}}]){
  assert.equal(followbackLogPresentation({...log,...patch}).label,'执行完成 ✓');
 }
});
