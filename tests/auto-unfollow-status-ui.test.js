import test from 'node:test';
import assert from 'node:assert/strict';
import {autoUnfollowStatusController as controller,paintAutoUnfollowRow} from '../src/entries/panel/composables/useAutoUnfollowStatus.js';
test('refresh preserves eligibility of rows awaiting the next queue scan',async()=>{
 const previousChrome=globalThis.chrome,previousDocument=globalThis.document;
 const nodes=[];
 globalThis.document={querySelectorAll:()=>nodes};
 globalThis.chrome={storage:{local:{get:async()=>({unreciprocatedSettings:{settingsSchemaVersion:5,autoUnfollow:true,autoUnfollowAccount:{id:'1',handle:'owner'},overdueDays:7,activeTimeStart:'00:00',activeTimeEnd:'00:00'},autoUnfollowState:{accounts:{1:{queue:[]}}}})}},alarms:{get:async()=>({scheduledTime:Date.now()+60000})}};
 try{
   await controller.refresh();
   const node={dataset:{},setAttribute(){}};nodes.push(node);
   paintAutoUnfollowRow(node,{id:'2',handle:'later',status:'overdue',followedAt:'2026-01-01T00:00:00Z',relationship:{following:true,followedBy:false}});
   assert.equal(node.textContent,'待入队核验');
   await controller.refresh();assert.equal(node.textContent,'待入队核验');assert.equal(node.hidden,false);
 }finally{globalThis.chrome=previousChrome;globalThis.document=previousDocument;}
});
