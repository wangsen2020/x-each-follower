import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeVerifiedRelationship,profileRelationshipOnPage} from '../src/platform/x/guarded-relationship.js';
import {parseNetworkUsers} from '../src/features/relationships/network-api.js';

test('positive profile evidence overrides stale negatives; absent evidence is not proof',()=>{
 assert.deepEqual(mergeVerifiedRelationship({following:true,followedBy:false},{ready:true,following:true,followedBy:true}),{following:true,followedBy:true});
 assert.deepEqual(mergeVerifiedRelationship({following:true,followedBy:false},{ready:false}),{following:null,followedBy:null});
 assert.deepEqual(mergeVerifiedRelationship({following:true},{ready:true,following:true,followedBy:false}),{following:true,followedBy:null});
 assert.equal(mergeVerifiedRelationship({following:true,followedBy:false},{ready:true,following:false,followedBy:false}).following,null);
});

test('creator subscription ID collision never wins over a semantic unfollow control',()=>{
 const oldDocument=globalThis.document,oldLocation=globalThis.location;let paidClicks=0,unfollowClicks=0;
 const paid={innerText:'订阅',getAttribute:k=>k==='data-testid'?'12-unfollow':k==='aria-label'?'订阅 到 @target':null,closest:()=>null,click:()=>paidClicks++};
 const real={innerText:'',getAttribute:k=>k==='aria-label'?'取消关注 @target':null,closest:()=>null,click:()=>unfollowClicks++};
 let buttons=[paid,real];
 const root={querySelector:()=>({innerText:'Name\n@target'}),querySelectorAll:()=>buttons};
 globalThis.location={pathname:'/target'};globalThis.document={querySelector:s=>s.startsWith('a[')?{getAttribute:()=>'/owner'}:s.includes('primaryColumn')?root:null};
 try{
  assert.equal(profileRelationshipOnPage('target','12','owner','read').following,true);
  assert.equal(profileRelationshipOnPage('target','12','owner','unfollow').clicked,true);
  assert.equal(paidClicks,0);assert.equal(unfollowClicks,1);
  buttons=[paid];
  assert.equal(profileRelationshipOnPage('target','12','owner','unfollow').code,'X_PROFILE_ACTION_UNAVAILABLE');
  assert.equal(paidClicks,0);
 }finally{globalThis.document=oldDocument;globalThis.location=oldLocation;}
});

test('unrecognized action text and conflicting user ID are not following evidence',()=>{
 const oldDocument=globalThis.document,oldLocation=globalThis.location;
 let label='Unfollow @target',id='99-unfollow',text='Following';
 const button={get innerText(){return text;},getAttribute:k=>k==='data-testid'?id:label,closest:()=>null,click:()=>{throw Error('must not click')}};
 const root={querySelector:()=>({innerText:'@target'}),querySelectorAll:()=>[button]};
 globalThis.location={pathname:'/target'};globalThis.document={querySelector:s=>s.startsWith('a[')?{getAttribute:()=>'/owner'}:s.includes('primaryColumn')?root:null};
 try{
  assert.equal(profileRelationshipOnPage('target','12','owner','unfollow').ready,false);
  id='12-unfollow';label='Unknown action';text='Unknown action';
  assert.equal(profileRelationshipOnPage('target','12','owner','unfollow').ready,false);
  id=null;label='Unfollow @target2';text='';
  assert.equal(profileRelationshipOnPage('target','12','owner','unfollow').ready,false);
 }finally{globalThis.document=oldDocument;globalThis.location=oldLocation;}
});

test('compact unfollow menu is a submitting action and requires exact target semantics',()=>{
 const oldDocument=globalThis.document,oldLocation=globalThis.location;let clicks=0,text='取消关注 @target2',follower=false;
 const button={innerText:'',getAttribute:k=>k==='aria-label'?'取消关注 @target':null,closest:()=>null};
 const item={get innerText(){return text;},click:()=>clicks++};
 const root={querySelector:()=>({innerText:'@target'+(follower?' 关注了你':'')}),querySelectorAll:()=>[button]};
 globalThis.location={pathname:'/target'};globalThis.document={querySelector:s=>s.startsWith('a[')?{getAttribute:()=>'/owner'}:s.includes('primaryColumn')?root:null,querySelectorAll:()=>[item]};
 try{
  assert.equal(profileRelationshipOnPage('target','12','owner','confirm').clicked,false);
  text='订阅 @target';assert.equal(profileRelationshipOnPage('target','12','owner','confirm').clicked,false);
  text='取消关注 @target';follower=true;assert.equal(profileRelationshipOnPage('target','12','owner','confirm').clicked,false);
  follower=false;assert.equal(profileRelationshipOnPage('target','12','owner','confirm').clicked,true);
  assert.equal(clicks,1);
 }finally{globalThis.document=oldDocument;globalThis.location=oldLocation;}
});
test('network parser never lets a negative field override positive follower evidence',()=>{
 const [user]=parseNetworkUsers({rest_id:'12',legacy:{screen_name:'target',following:true,followed_by:true},relationship_perspectives:{followed_by:false}});
 assert.equal(user.relationship.followedBy,true);
});
test('page guard blocks wrong actor, follower, and recommendation buttons',()=>{
 const oldDocument=globalThis.document,oldLocation=globalThis.location;
 let clicks=0,viewer='/owner',follower=true,recommendation=false;
 const button={innerText:'正在关注',getAttribute:()=> '12-unfollow',closest:()=>recommendation?{}:null,click:()=>clicks++};
 const header={get innerText(){return '@target\n'+(follower?'关注了你':'');}};
 const root={querySelector:()=>header,querySelectorAll:()=>[button]};
 globalThis.location={pathname:'/target'};
 globalThis.document={querySelector:s=>s.startsWith('a[')?{getAttribute:()=>viewer}:s.includes('primaryColumn')?root:null};
 try{
  assert.equal(profileRelationshipOnPage('target','12','owner','unfollow').clicked,false);assert.equal(clicks,0);
  follower=false;viewer='/other';assert.equal(profileRelationshipOnPage('target','12','owner','unfollow').ready,false);
  viewer='/owner';recommendation=true;assert.equal(profileRelationshipOnPage('target','12','owner','unfollow').ready,false);
  recommendation=false;assert.equal(profileRelationshipOnPage('target','12','owner','unfollow').clicked,true);assert.equal(clicks,1);
 }finally{globalThis.document=oldDocument;globalThis.location=oldLocation;}
});

test('confirmation requires exact target and rechecks incoming follower evidence',()=>{
 const oldDocument=globalThis.document,oldLocation=globalThis.location;let clicked=0,text='取消关注 @target2？',follower=false;
 const button={innerText:'正在关注',getAttribute:()=> '12-unfollow',closest:()=>null};
 const confirm={closest:()=>({get innerText(){return text;}}),click:()=>clicked++};
 const root={querySelector:()=>({innerText:'@target'+(follower?' 关注了你':'')}),querySelectorAll:()=>[button]};
 globalThis.location={pathname:'/target'};globalThis.document={querySelector:s=>s.startsWith('a[')?{getAttribute:()=>'/owner'}:s.includes('primaryColumn')?root:s.includes('confirmationSheetConfirm')?confirm:null};
 try{
 assert.equal(profileRelationshipOnPage('target','12','owner','confirm').clicked,false);
 text='取消关注 @target？';follower=true;assert.equal(profileRelationshipOnPage('target','12','owner','confirm').clicked,false);
 follower=false;assert.equal(profileRelationshipOnPage('target','12','owner','confirm').clicked,true);assert.equal(clicked,1);
 }finally{globalThis.document=oldDocument;globalThis.location=oldLocation;}
});

for(const selector of ['[data-testid="confirmationSheetDialog"]','[role="alertdialog"]','[role="dialog"]'])test(`confirmation accepts exact target in ${selector} and rejects a different target`,()=>{
 const oldDocument=globalThis.document,oldLocation=globalThis.location;
 let clicks=0,text='取消关注 @target？';
 const button={innerText:'正在关注',getAttribute:()=> '12-unfollow',closest:()=>null};
 const dialog={get innerText(){return text;}};
 const confirm={closest:s=>s.includes(selector)?dialog:null,click:()=>clicks++};
 const root={querySelector:()=>({innerText:'@target'}),querySelectorAll:()=>[button]};
 globalThis.location={pathname:'/target'};
 globalThis.document={querySelector:s=>s.startsWith('a[')?{getAttribute:()=>'/owner'}:s.includes('primaryColumn')?root:s.includes('confirmationSheetConfirm')?confirm:s.includes(selector)?dialog:null};
 try{
  assert.equal(profileRelationshipOnPage('target','12','owner','confirm').clicked,true);
  assert.equal(clicks,1);
  text='取消关注 @target2？';
  assert.equal(profileRelationshipOnPage('target','12','owner','confirm').clicked,false);
  assert.equal(clicks,1);
  assert.equal(profileRelationshipOnPage('target','12','owner','unfollow').clicked,false);
 }finally{globalThis.document=oldDocument;globalThis.location=oldLocation;}
});
