import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {refreshCompletedUnfollow} from '../src/entries/panel/followback-live-refresh.js';

const completed = {autoUnfollowState:{oldValue:{pending:{user:{handle:'Arena'}}},newValue:{pending:null}}};
const record = {module:'unreciprocated',userKey:'tracker/arena',handle:'arena',sourceKey:'unreciprocatedTracker',bucket:'users',payload:{handle:'arena',name:'Arena.ai',status:'unfollowed',relationship:{following:false},unfollowedAt:'2026-10-26T07:40:49.440Z'}};

test('completed background action refreshes the local list, count and name search from committed data', async () => {
  let users=[{handle:'arena',name:'Arena.ai',status:'pending'},{handle:'other',status:'unfollowed'}];
  let reads=0;
  const refreshed=await refreshCompletedUnfollow(completed,{lookup:async handle=>{reads++;assert.equal(handle,'arena');return {ok:true,records:[record]};},getUsers:()=>users,setUsers:value=>{users=value;}});
  assert.equal(refreshed,true);assert.equal(reads,1);
  assert.equal(users.filter(u=>u.status==='unfollowed').length,2);
  assert.equal(users.filter(u=>u.status==='unfollowed'&&u.name?.toLowerCase().includes('arena.ai')).length,1);
  assert.equal(users[0].relationship.following,false);
  assert.equal(users[0].__userKey,'tracker/arena');
});

test('clearing an operation does not invent success, and concurrent unrelated updates survive the read', async () => {
  let users=[];
  const pendingRecord={...record,payload:{...record.payload,status:'pending',relationship:{following:true}}};
  await refreshCompletedUnfollow(completed,{lookup:async()=>{users.push({handle:'newer',status:'mutual'});return {ok:true,records:[pendingRecord]};},getUsers:()=>users,setUsers:value=>{users=value;}});
  assert.deepEqual(users.map(u=>u.status),['mutual','pending']);
});

test('in-progress and unrelated state changes do not query or replace the snapshot', async () => {
  const dependencies={lookup:()=>{throw Error('unexpected query');},getUsers:()=>[],setUsers:()=>{throw Error('unexpected replacement');}};
  assert.equal(await refreshCompletedUnfollow({},dependencies),false);
  assert.equal(await refreshCompletedUnfollow({autoUnfollowState:{...completed.autoUnfollowState,newValue:{pending:{user:{handle:'arena'}}}}},dependencies),false);
});

test('a failed read keeps existing data and reports the refresh error', async () => {
  let writes=0;
  await assert.rejects(refreshCompletedUnfollow(completed,{lookup:async()=>({ok:false,error:'offline'}),getUsers:()=>[],setUsers:()=>{writes++;}}),/offline/);
  assert.equal(writes,0);
});

test('the actual panel storage listener replaces its local snapshot before rendering the refreshed page', async () => {
  const source=readFileSync(new URL('../src/entries/panel/panel.js',import.meta.url),'utf8');
  const start=source.indexOf('chrome.storage.onChanged.addListener(async (changes, area) => {');
  const end=source.indexOf('\nfunction monitorUserStatus',start);
  assert.ok(start>=0&&end>start);
  let listener;
  const renders=[];
  const context={refreshCompletedUnfollow,unreciprocatedLocalReady:true,
    unreciprocatedTracker:{users:[{handle:'arena',name:'Arena.ai',status:'pending'}]},
    chrome:{storage:{onChanged:{addListener:fn=>{listener=fn;}}},runtime:{sendMessage:async request=>{
      assert.equal(request.op,'lookupAll');assert.equal(request.handle,'arena');return {ok:true,records:[record]};
    }}},
    localStorageChangePlan:()=>({}),recordPaging:true,
    recordPages:{invalidate:()=>{},open:async()=>{}},activeDashboardTab:'unreciprocated',
    panelModuleForTab:()=> 'unreciprocated',currentRecordFilter:()=>({}),$:()=>null};
  const render=()=>renders.push(context.unreciprocatedTracker.users.filter(u=>u.status==='unfollowed'&&u.name==='Arena.ai').length);
  context.renderUnreciprocatedUI=render;context.renderSettledModule=render;
  vm.runInNewContext(source.slice(start,end),context);
  await listener(completed,'local');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(renders,[1,1]);
});
