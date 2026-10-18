import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichQueueProfiles} from '../follow-queue-profiles.js';
test('queue joins existing sources and cache without changing identity or state',()=>{
 const job={handle:'Example',targetUserId:'123',state:'pending'};
 const [result]=enrichQueueProfiles([job],{monitor:{users:[{handle:'example',name:'Name',bio:'Writer',isBlueVerified:true,followersText:0}]},profileCache:{example:{bio:'',followingText:'42'}}});
 assert.equal(result.profile.name,'Name');assert.equal(result.profile.bio,'Writer');assert.equal(result.profile.followersText,'0');assert.equal(result.profile.followingText,'42');assert.equal(result.profile.blueVerified,true);
 assert.equal(result.targetUserId,'123');assert.equal(result.state,'pending');assert.equal(job.profile,undefined);
});
test('blue badge requires explicit data and newer false overrides true',()=>{
 const [result]=enrichQueueProfiles([{handle:'u'}],{mutualNetwork:{users:[{handle:'u',bio:'蓝V',isBlueVerified:true}]},profileCache:{u:{is_blue_verified:false}}});
 assert.equal(result.profile.blueVerified,false);
 assert.equal(enrichQueueProfiles([{handle:'x'}],{})[0].profile.blueVerified,undefined);
});

test('network user parser retains explicit blue verification for queue display',async()=>{
 const {parseNetworkUsers}=await import('../network-api.js');
 const [user]=parseNetworkUsers({rest_id:'123',is_blue_verified:true,legacy:{screen_name:'person',name:'Person',verified:false}});
 assert.equal(user.is_blue_verified,true);assert.equal(user.verified,false);
});
