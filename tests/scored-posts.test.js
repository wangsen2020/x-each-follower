import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScoredPosts,readScoredPosts} from '../src/features/follow-queue/scored-posts.js';
const tweet=(id,extra={})=>({rest_id:String(id),core:{user_results:{result:{rest_id:'123',core:{screen_name:'alice'}}}},legacy:{full_text:'Concrete source '+id,created_at:'Tue Oct 27 01:00:00 +0000 2026',truncated:false,reply_count:1,retweet_count:2,favorite_count:3,bookmark_count:4,...extra}});
const entry=t=>({entryId:'tweet-'+t.rest_id,content:{itemContent:{tweet_results:{result:t}}}});
const json=(tweets,pin)=>({data:{user:{result:{timeline:{timeline:{instructions:[...(pin?[{type:'TimelinePinEntry',entry:entry(pin)}]:[]),{type:'TimelineAddEntries',entries:tweets.map(entry)}]}}}}}});
test('queue timeline excludes a pinned duplicate, keeps exact bookmarks and expanded note text',()=>{
 const pinned=tweet(9,{favorite_count:9999}),ordinary=tweet(10);
 ordinary.note_tweet={note_tweet_results:{result:{text:'Expanded full note instead of the shortened legacy text.'}}};
 const parsed=parseScoredPosts(json([pinned,ordinary],pinned),{userId:'123',handle:'Alice'});
 assert.deepEqual(parsed.pinnedIds,['9']);assert.equal(parsed.posts.length,1);assert.equal(parsed.posts[0].postId,'10');
 assert.equal(parsed.posts[0].bookmarkCount,4);assert.equal(parsed.posts[0].textComplete,true);assert.match(parsed.posts[0].text,/Expanded full note/);
 delete ordinary.legacy.bookmark_count;
 assert.equal(parseScoredPosts(json([ordinary]),{userId:'123',handle:'alice'}).posts[0].bookmarkCount,null);
});
test('missing native timeline template does not make an extra X request',async()=>{
 let calls=0;
 const result=await readScoredPosts({api:{storage:{local:{get:async()=>({})}},scripting:{executeScript:async()=>{calls++;}}},tabId:1,userId:'123',handle:'alice'});
 assert.equal(result,null);assert.equal(calls,0);
});
