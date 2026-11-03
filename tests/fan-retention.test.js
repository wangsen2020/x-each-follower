import test from 'node:test';
import assert from 'node:assert/strict';
import {fanRetentionDecision,fanRetentionBlocks,fanRowOwned} from '../src/features/relationships/fan-retention.js';
const row=(payload,bucket='users')=>({accountId:'1',module:'fans',sourceKey:'monitor',sourcePath:['monitor',bucket],userKey:bucket,handle:'target',payload:{id:'42',handle:'target',...payload}});
const none={relationship:{following:false,followedBy:false},relationshipVerifiedAt:100};
test('retain either relation, unknowns, undated defaults and conflicting identities',()=>{
 for(const relationship of [{following:true,followedBy:false},{following:false,followedBy:true},{following:true,followedBy:true},{following:null,followedBy:false}])assert.equal(fanRetentionDecision([row({relationship,relationshipVerifiedAt:100})]),null);
 assert.equal(fanRetentionDecision([row({relationship:none.relationship})]),null);
 assert.equal(fanRetentionDecision([row(none),row({...none,id:'43'},'queue')]),null);
 assert.equal(fanRetentionDecision([row(none),row({...none,relationship:{following:true,followedBy:false}},'queue')]),null);
 assert.equal(fanRetentionDecision([row(none)]).scope,'fans');
});
test('latest availability wins and ownership does not cross accounts',()=>{
 assert.equal(fanRetentionDecision([row({...none,accountAvailability:{status:'ok',checkedAt:200}})],{status:'suspended',checkedAt:100}).scope,'fans');
 assert.equal(fanRetentionDecision([row({relationship:{following:true,followedBy:true}})],{status:'suspended',checkedAt:100}).scope,'account');
 assert.equal(fanRowOwned({...row(none),accountId:'unassigned'},'1','1'),true);
 assert.equal(fanRowOwned(row({...none,ownerAccountId:'2'}),'1','1'),false);
});
test('tombstone rejects stale writes and permits renewed relations or different IDs',()=>{
 const marker={scope:'fans',ownerId:'1',targetIds:['42'],observedAt:100};
 const blocked=payload=>fanRetentionBlocks(marker,{sourceKey:'monitor',moduleName:'fans',payload});
 assert.equal(blocked(row(none).payload),true);
 assert.equal(blocked(row({relationship:{following:true,followedBy:false},relationshipVerifiedAt:99}).payload),true);
 assert.equal(blocked(row({relationship:{following:false,followedBy:true},relationshipVerifiedAt:101}).payload),false);
 assert.equal(blocked(row({...none,id:'43'}).payload),false);
 assert.equal(fanRetentionBlocks(marker,{sourceKey:'commentTracking',moduleName:'comments',payload:row(none).payload}),false);
});


test('activity guards distinguish real work from a stale legacy publishing label',async()=>{
 const {fanJobBusy,FAN_JOB_ACTIVITY_WINDOW_MS}=await import('../src/features/relationships/fan-retention.js');const at=2000000;
 const old={state:'followed',updatedAt:at-FAN_JOB_ACTIVITY_WINDOW_MS-1,lease:{owner:'',expiresAt:0},evaluations:[{status:'publishing'}]};
 assert.equal(fanJobBusy(old,at),false);assert.equal(fanJobBusy(old,at,true),true);
 assert.equal(fanJobBusy({...old,updatedAt:at},at),true);
 assert.equal(fanJobBusy({...old,lease:{expiresAt:at+1000}},at),true);
 assert.equal(fanJobBusy({...old,updatedAt:undefined},at),true);
});


test('newer positive relationship evidence in an independent module prevents stale removal',()=>{
 const current=row({...none,relationshipVerifiedAt:300}),other={...row({relationship:{following:true,followedBy:false},relationshipVerifiedAt:301}),sourceKey:'mutualNetwork',module:'mutual'};
 assert.equal(fanRetentionDecision([current,other]),null);
 assert.equal(fanRetentionDecision([current,{...other,payload:{...other.payload,relationshipVerifiedAt:200}}]).scope,'fans');
});
