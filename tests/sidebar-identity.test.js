import test from 'node:test';
import assert from 'node:assert/strict';
import {createSidebarIdentity} from '../src/platform/x/sidebar-identity.js';
test('explicit refresh bypasses profile cache and coalesces concurrent refreshes',async()=>{
 const {state,service}=setup();
 await service.read();
 state.users=[{handle:'owner',name:'Updated name',is_blue_verified:false}];
 assert.equal((await service.read()).account.name,'Owner name');
 const first=service.read({force:true});
 const second=service.read({force:true});
 assert.equal(first,second);
 assert.equal((await first).account.name,'Updated name');
 assert.equal((await second).account.blueVerified,false);
 assert.equal(state.fetches,2);
});
function setup(){const state={viewer:{handle:'owner',name:'Current owner',avatarUrl:'https://img/owner'},users:[{handle:'owner',name:'Owner name',avatarUrl:'https://img/profile',is_blue_verified:true}],fetches:0};const api={tabs:{query:async()=>[{id:1,active:true,url:'https://x.com/otherUser'}]},scripting:{executeScript:async()=>[{result:state.viewer}]}};return {state,api,service:createSidebarIdentity({api,fetchProfile:async()=>{state.fetches++;return {status:200,json:state.users}},parseUsers:x=>x})};}
test('sidebar resolves navigation owner instead of the visited profile and caches only matching identity',async()=>{const {state,service}=setup();assert.deepEqual((await service.read()).account.handle,'owner');assert.equal((await service.read()).account.blueVerified,true);assert.equal(state.fetches,1);state.viewer={handle:'second',name:'Second'};state.users=[{handle:'second',name:'Second',is_blue_verified:false}];assert.equal((await service.read()).account.handle,'second');assert.equal((await service.read()).account.blueVerified,false);state.viewer=null;assert.equal((await service.read()).account,null);});
test('unmatched profile cannot supply somebody else avatar or blue badge',async()=>{const {state,service}=setup();state.users=[{handle:'other',name:'Wrong',avatarUrl:'wrong',is_blue_verified:true}];const result=await service.read();assert.equal(result.account.name,'Current owner');assert.equal(result.account.avatarUrl,'https://img/owner');assert.equal(result.account.blueVerified,undefined);});
test('account switches during lookup discard the stale identity',async()=>{const {state,api}=setup();const service=createSidebarIdentity({api,fetchProfile:async()=>{state.viewer={handle:'newOwner'};return{status:200,json:[{handle:'owner',is_blue_verified:true}]}},parseUsers:x=>x});assert.equal((await service.read()).account,null);});
