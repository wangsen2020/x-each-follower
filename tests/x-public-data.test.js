import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePublicProfile,parsePublicTimeline} from '../src/platform/x/public-data.js';

const user={__typename:'User',rest_id:'1143459178146652160',core:{screen_name:'NdifePromise',name:'Example'},relationship_counts:{followers:4047}};
const tweet={__typename:'Tweet',rest_id:'2113104564249391441',core:{user_results:{result:user}},legacy:{created_at:'Thu Oct 22 03:06:02 +0000 2026',full_text:'Example post',favorite_count:7,reply_count:2,retweet_count:1,user_id_str:user.rest_id},views:{count:'47',state:'EnabledWithCount'}};

test('public profile reads stable user ID and relationship_counts followers',()=>{
  const result=parsePublicProfile({data:{user:{result:user}}},123);
  assert.deepEqual({id:result.id,followers:result.followers,followersState:result.followersState,capturedAt:result.capturedAt},{id:user.rest_id,followers:4047,followersState:'explicit',capturedAt:123});
});

test('public timeline keeps public views, author and bottom cursor without private analytics',()=>{
  const json={data:{user:{result:{timeline:{timeline:{instructions:[{type:'TimelineAddEntries',entries:[
    {entryId:'tweet-'+tweet.rest_id,content:{itemContent:{tweet_results:{result:tweet}}}},
    {entryId:'cursor-bottom',content:{cursorType:'Bottom',value:'next-page'}}
  ]}]}}}}}};
  const result=parsePublicTimeline(json,{creatorId:user.rest_id,capturedAt:456});
  assert.equal(result.posts.length,1);
  assert.equal(result.posts[0].metrics.views,47);
  assert.equal(result.posts[0].metricBasis,'public-cumulative');
  assert.equal(result.cursor,'next-page');
  assert.equal(result.hasMore,true);
});

test('missing public view count stays unavailable and foreign author is excluded',()=>{
  const foreign={...tweet,rest_id:'2113104564249391442',core:{user_results:{result:{...user,rest_id:'999'}}}};
  const withoutViews={...tweet,views:{state:'Unavailable'}};
  const json={data:{user:{result:{timeline:{timeline:{instructions:[{entries:[
    {content:{itemContent:{tweet_results:{result:foreign}}}},
    {content:{itemContent:{tweet_results:{result:withoutViews}}}}
  ]}]}}}}}};
  const result=parsePublicTimeline(json,{creatorId:user.rest_id});
  assert.equal(result.posts.length,1);
  assert.equal(result.posts[0].metrics.views,null);
  assert.equal(result.posts[0].metricStates.views,'unavailable');
  assert.equal(result.unavailable,1);
});
