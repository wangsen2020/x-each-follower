import test from 'node:test';
import assert from 'node:assert/strict';
import {planReplyUserIdRepair, repairAutoUnfollowLedger, replyIdEvidence} from '../src/features/records/reply-user-id-repair.js';

const row = (sourceKey, payload, accountId='owner') => ({sourceKey,accountId,handle:'person',module:sourceKey==='commentTracking'?'comments':'profiles',
  userKey:sourceKey,sourcePath:sourceKey==='profileCache'?['profileCache','person']:[sourceKey,'users',0],payload:{handle:'person',...payload}});
const comment = (extra={}) => row('commentTracking',{id:'2110886901939065031',sources:[{replies:[{replyId:'2110886901939065031',text:'hello'}]}],...extra});

test('repair requires exact stored reply evidence, never a Snowflake heuristic',()=>{
  assert.deepEqual(replyIdEvidence(comment()),['2110886901939065031']);
  const noEvidence=comment({sources:[{replies:[{replyId:'2110886901939065032'}]}]});
  assert.equal(planReplyUserIdRepair(noEvidence,[noEvidence]),null);
  assert.deepEqual(replyIdEvidence(row('commentTracking',{id:'123',replyId:'123'})),[]);
});
test('repair uses an unambiguous trusted same-owner ID and retains reply evidence',()=>{
  const seed=comment(), profile=row('profileCache',{id:'1762674580253265920'});
  const before=structuredClone(seed);
  const plan=planReplyUserIdRepair(seed,[seed,profile]);
  assert.equal(plan.replacementId,'1762674580253265920');
  assert.deepEqual(plan.changes.map(x=>x.patch),[{id:'1762674580253265920'}]);
  assert.deepEqual(seed,before);
});
test('missing, conflicting or other-owner IDs clear only the proven bad fields',()=>{
  const seed=comment();
  for(const others of [[],[row('profileCache',{id:'42'},'other')],[row('profileCache',{id:'42'}),row('mutualNetwork',{id:'43'})],
    [row('profileCache',{id:'42',ownerAccountId:'other'})]]){
    const plan=planReplyUserIdRepair(seed,[seed,...others]);
    assert.equal(plan.replacementId,'');assert.equal(plan.changes[0].patch.id,'');
  }
});
test('migration resumes from audit evidence and never changes posts or logs',()=>{
  const seed=comment({id:'42',userIdRepair:{previousIds:['2110886901939065031']}});
  const tracker={...row('unreciprocatedTracker',{id:'2110886901939065031'}),module:'unreciprocated'};
  const log={...tracker,module:'logs'},post={...tracker,module:'posts'};
  const plan=planReplyUserIdRepair(seed,[seed,tracker,log,post,row('profileCache',{id:'42'})]);
  assert.deepEqual(plan.changes.map(x=>x.row.module),['unreciprocated']);
});
test('review reference repair preserves choices, quotas, queues and unknown action receipts',()=>{
  const user={handle:'Person',id:'2110886901939065031'};
  const entry={user,status:'review',code:'AUTO_UNFOLLOW_TARGET_MISMATCH',attempts:3,updatedAt:1};
  const state={account:'owner',used:9,queue:['unrelated'],reviewItems:[entry],pendingItems:[]};
  const plan={owner:'owner',handle:'person',previousIds:[user.id],replacementId:'42'};
  const before={accounts:{owner:state,other:{reviewItems:[entry]}}};
  const result=repairAutoUnfollowLedger(before,[plan],20);
  assert.equal(result.changed,1);assert.equal(result.ledger.accounts.owner.reviewItems[0].user.id,'42');
  assert.equal(result.ledger.accounts.owner.reviewItems[0].status,'review');
  assert.equal(result.ledger.accounts.owner.reviewItems[0].attempts,3);
  assert.equal(result.ledger.accounts.owner.used,9);assert.deepEqual(result.ledger.accounts.owner.queue,['unrelated']);
  assert.equal(result.ledger.accounts.other.reviewItems[0].user.id,user.id);assert.equal(before.accounts.owner.reviewItems[0].user.id,user.id);
  const pending={...state,pendingItems:[{user,phase:'submitting',checks:3}]};
  assert.deepEqual(repairAutoUnfollowLedger({accounts:{owner:pending}},[plan],20).ledger,{accounts:{owner:pending}});
  const skipped={...entry,status:'skipped',pending:true};
  assert.equal(repairAutoUnfollowLedger({account:'owner',reviewItems:[skipped]},[plan],20).changed,0);
  assert.equal(repairAutoUnfollowLedger(result.ledger,[plan],21).changed,0);
});
