import test from 'node:test';
import assert from 'node:assert/strict';
import {networkFollow, parseNetworkUsers, parseTweetReplies, findBottomCursor, nextUserListPage, mergeCommentTracking, mergeRecentPosts, findCursor, isUsableNetworkTemplate, personalRelationshipLabel, mutualUserCategory, reconcileFollowBackQueue, capturedPageRequestCursor, isCapturedPageForCursor, GRAPHQL_OP_RE, prepareNetworkHeaders, prepareNetworkVariables, addUniqueUsersUpTo} from '../src/features/relationships/network-api.js';
import {isAccountFollowLimit} from '../src/shared/follow-limit.js';

test('X follow error 161 is classified without showing the raw HTML response', async () => {
  const result=await networkFollow(1,{id:'42',handle:'target'}, {follow:async()=>({status:403,json:{errors:[{code:161,message:"You are unable to follow more people at this time. Learn more <a href='http://support.twitter.com/articles/66885-i-can-t-follow-people-follow-limits'>here</a>."}]},error:"You are unable to follow more people at this time. Learn more <a href='http://support.twitter.com/articles/66885-i-can-t-follow-people-follow-limits'>here</a>."})});
  assert.equal(result.status,403);
  assert.equal(result.followLimit,true);
  assert.equal(result.errorCode,161);
  assert.match(result.error,/X 拒绝继续关注/);
  assert.doesNotMatch(result.error,/<a|Learn more/i);
  const inconsistent=await networkFollow(1,{id:'42',handle:'target'}, {follow:async()=>({status:200,json:{errors:[{code:161}]},error:''})});
  assert.equal(inconsistent.status,0,'an error-bearing HTTP success must not become a followed state');
  assert.equal(inconsistent.httpStatus,200);
  assert.equal(isAccountFollowLimit({reason:'You are unable to follow more people at this time.'}),true);
});

test('follower page accumulation deduplicates accounts and never exceeds the per-scan cap', () => {
  const found = new Map();
  addUniqueUsersUpTo(found, [{handle:'alice'}, {handle:'bob'}], 3);
  addUniqueUsersUpTo(found, [{handle:'ALICE'}, {handle:'carol'}, {handle:'dave'}], 3);
  assert.deepEqual([...found.keys()], ['alice', 'bob', 'carol']);
});

test('Followers template only needs a matching query id because requests get fresh signatures', () => {
  assert.equal(isUsableNetworkTemplate('Followers', {queryId:'q', headers:{authorization:'present'}}), true);
  assert.equal(isUsableNetworkTemplate('Followers', {queryId:'q', headers:{'x-client-transaction-id':'present'}}), true);
  assert.equal(isUsableNetworkTemplate('Followers', {headers:{'x-client-transaction-id':'present'}}), false);
  assert.equal(isUsableNetworkTemplate('UserByScreenName', {queryId:'q', headers:{authorization:'present'}}), true);
});

test('GRAPHQL_OP_RE matches exact operation path and rejects unsuitable prefix operations like FollowersYouKnow', () => {
  assert.equal(GRAPHQL_OP_RE.exec('/i/api/graphql/abc123/Followers?variables=%7B%7D')?.[2], 'Followers');
  assert.equal(GRAPHQL_OP_RE.exec('/i/api/graphql/abc123/Followers')?.[2], 'Followers');
  assert.equal(GRAPHQL_OP_RE.exec('/i/api/graphql/abc123/Followers/something')?.[2], 'Followers');
  assert.equal(GRAPHQL_OP_RE.exec('/i/api/graphql/abc123/FollowersYouKnow?variables=%7B%7D'), null);
  assert.equal(GRAPHQL_OP_RE.exec('/i/api/graphql/abc123/FollowingYouKnow?variables=%7B%7D'), null);
  assert.equal(GRAPHQL_OP_RE.exec('/i/api/graphql/abc123/BlueVerifiedFollowers?variables=%7B%7D')?.[2], 'BlueVerifiedFollowers');
});

test('isUsableNetworkTemplate rejects unsuitable templates with pagination cursor or mismatched operation', () => {
  assert.equal(isUsableNetworkTemplate('Followers', {queryId:'q', op:'Followers', headers:{}, variables:JSON.stringify({cursor:'stale-cursor'})}), true);
  assert.equal(isUsableNetworkTemplate('Followers', {queryId:'q', op:'FollowersYouKnow', headers:{'x-client-transaction-id':'present'}}), false);
  assert.equal(isUsableNetworkTemplate('Followers', {queryId:'q', op:'Followers', headers:{'x-client-transaction-id':'present'}, variables:JSON.stringify({userId:'123'})}), true);
});

test('follow queue removes accounts confirmed as following and adds confirmed follow-backs', () => {
  const queue = [
    {handle:'niuniu34390484', status:'pending'},
    {handle:'already-done', status:'followed'},
    {handle:'failed-before', status:'follow_failed'}
  ];
  const users = [
    {handle:'niuniu34390484', state:'following', relationship:{following:true}},
    {handle:'already-done', state:'follow_back'},
    {handle:'new-back', state:'follow_back'}
  ];
  const reconciled = reconcileFollowBackQueue(queue, users, () => ({level:'normal', hits:[]}));
  assert.deepEqual(reconciled.map(user => [user.handle, user.status]).sort(), [
    ['already-done','pending'],
    ['failed-before','follow_failed'],
    ['new-back','pending']
  ]);
});

test('captured Followers pages are matched to the X-generated cursor request', () => {
  const first = {operation:'Followers', at:10, variables:'{"userId":"1","count":20}', json:{data:{users:[]}}};
  const second = {operation:'Followers', at:11, variables:'{"userId":"1","count":20,"cursor":"next"}', json:{data:{users:[]}}};
  assert.equal(capturedPageRequestCursor(first), '');
  assert.equal(capturedPageRequestCursor(second), 'next');
  assert.equal(isCapturedPageForCursor(first), true);
  assert.equal(isCapturedPageForCursor(second, 'next'), true);
  assert.equal(isCapturedPageForCursor(second, 'different'), false);
  assert.equal(isCapturedPageForCursor({...second, operation:'BlueVerifiedFollowers'}, 'next'), false);
});

test('parses nested X GraphQL user nodes and relationship state', () => {
  const json = {items:[{rest_id:'1',legacy:{screen_name:'alice',name:'Alice',description:'AI',following:false}},{value:'next-cursor',cursorType:'BottomCursor'}]};
  const users = parseNetworkUsers(json);
  assert.equal(users[0].handle, 'alice');
  assert.equal(users[0].state, 'unknown');
  assert.equal(findCursor(json), 'next-cursor');
});

test('user list pagination takes Bottom instead of Top and stops on empty pages', () => {
  const page={entries:[{cursorType:'Top',value:'top'},{cursorType:'Bottom',value:'bottom'}]};
  assert.deepEqual(nextUserListPage(page,'',[{handle:'one'}]),{next:'bottom',complete:false,reason:''});
  assert.deepEqual(nextUserListPage(page,'bottom',[{handle:'one'}]),{next:'',complete:false,reason:'stalled'});
  assert.deepEqual(nextUserListPage(page,'',[]),{next:'',complete:false,reason:'empty'});
  assert.deepEqual(nextUserListPage({entries:[{cursorType:'Top',value:'top'}]},'',[{handle:'one'}]),{next:'',complete:true,reason:''});
});

test('parses unique authors and reply text from TweetDetail timeline entries, excluding the original post', () => {
  const tweet = (id, handle, text) => ({
    tweet_results:{result:{rest_id:id, legacy:{full_text:text, created_at:'2026-10-16'}, core:{user_results:{result:{rest_id:`user-${handle}`, legacy:{screen_name:handle, name:handle.toUpperCase(), description:'bio', followers_count:12, friends_count:20, profile_image_url_https:'https://img.example/avatar.jpg'}, relationship_perspectives:{following:false, followed_by:true}}}}}}
  });
  const json = {data:{threaded_conversation_with_injections_v2:{instructions:[{entries:[
    {entryId:'tweet-100', content:{itemContent:tweet('100','postowner','original')}},
    {entryId:'conversationthread-100-tweet-101', content:{items:[{item:{itemContent:tweet('101','alice','hello')}},{item:{itemContent:tweet('102','postowner','reply to alice')}}]}},
    {entryId:'cursor-bottom', content:{cursorType:'Bottom', value:'next-cursor'}}
  ]}]}}};
  const replies = parseTweetReplies(json, '100');
  assert.deepEqual(replies.map(reply => [reply.id, reply.handle, reply.replyText]), [
    ['101','alice','hello'],
    ['102','postowner','reply to alice']
  ]);
  assert.equal(replies[0].userId, 'user-alice');
  assert.equal(replies[0].relationship.followedBy, true);
  assert.equal(findBottomCursor(json), 'next-cursor');
  assert.equal(GRAPHQL_OP_RE.exec('/i/api/graphql/q/TweetDetail?variables=%7B%7D')?.[2], 'TweetDetail');
});

test('comment tracking merges user rest_id and discards reply tweet ID', () => {
  const legacy = {users:[{handle:'zhangttt12345', name:'Zhang', id:'bad-tweet-id'}], posts:[]};
  const reply = {id:'bad-tweet-id', replyId:'bad-tweet-id', userId:'14567890', handle:'zhangttt12345', name:'Zhang'};
  const merged = mergeCommentTracking(legacy, {tweetId:'post-1', url:'https://x.com/owner/status/post-1', authorHandle:'owner'}, [reply]);
  assert.equal(merged.users[0].id, '14567890');
});

test('comment tracking deduplicates users while retaining distinct source posts and merging repeat replies', () => {
  const legacy = {users:[{handle:'alice', name:'Alice'}], posts:[]};
  const reply = {handle:'Alice', name:'Alice', sources:[{replies:[{replyId:'r1', text:'hello'}]}]};
  const first = mergeCommentTracking(legacy, {tweetId:'t1', url:'https://x.com/bob/status/t1', authorHandle:'bob'}, [reply]);
  const second = mergeCommentTracking(first, {tweetId:'t2', url:'https://x.com/carol/status/t2', authorHandle:'carol'}, [reply]);
  const repeated = mergeCommentTracking(second, {tweetId:'t1', url:'https://x.com/bob/status/t1', authorHandle:'bob'}, [reply]);
  assert.equal(repeated.users.length, 1);
  assert.deepEqual(repeated.users[0].sources.map(source => source.tweetId), ['t1', 't2']);
  assert.deepEqual(repeated.users[0].sources[0].replies.map(item => item.replyId), ['r1']);
  assert.equal(repeated.posts.length, 2);
  assert.equal(repeated.posts[0].replyUsers, 1);
});

test('recent post archive updates duplicates by URL, sorts newest first, and caps at 100', () => {
  const history = [{url:'https://x.com/a/status/1', text:'old copy', time:'2026-01-01', firstSeenAt:'2026-01-02'}];
  const refreshed = mergeRecentPosts(history, [
    {url:'https://x.com/a/status/1', text:'refreshed copy', time:'2026-01-01'},
    {url:'https://x.com/a/status/2', text:'newer', time:'2026-02-01'}
  ]);
  assert.equal(refreshed.length, 2);
  assert.equal(refreshed[0].url, 'https://x.com/a/status/2');
  assert.equal(refreshed[1].text, 'refreshed copy');
  assert.equal(refreshed[1].firstSeenAt, '2026-01-02');
  const many = Array.from({length:120}, (_,i) => ({url:`https://x.com/a/status/${i}`, time:`2026-${String(Math.floor(i / 28) + 1).padStart(2,'0')}-${String(i % 28 + 1).padStart(2,'0')}`}));
  assert.equal(mergeRecentPosts([], many).length, 100);
});

test('parses current UserByScreenName fields and X relationship blocking state', () => {
  const json = {data:{user:{result:{rest_id:'1234567890123456789', core:{screen_name:'modern_user', name:'Modern User'}, profile_bio:{description:'bio'}, relationship_counts:{followers:8518, following:7417}, relationship_perspectives:{blocking:true, followed_by:false, following:false}}}}};
  const user = parseNetworkUsers(json).find(item => item.handle === 'modern_user');
  assert.equal(user.id, '1234567890123456789');
  assert.equal(user.followersText, '8518');
  assert.equal(user.followingText, '7417');
  assert.equal(user.relationshipKnown, true);
  assert.deepEqual(user.relationship, {blocking:true, followedBy:false, following:false});
});

test('does not treat missing relationship fields as proof that a follower needs follow-back', () => {
  const user = parseNetworkUsers({rest_id:'123', core:{screen_name:'unknownrel', name:'Unknown'}})[0];
  assert.equal(user.state, 'unknown');
  assert.equal(user.relationshipKnown, false);
  assert.deepEqual(user.relationship, {blocking:false, followedBy:null, following:null});
});

test('labels candidate relationships against the signed-in account, independent of anchor membership', () => {
  assert.equal(personalRelationshipLabel({relationshipKnown:true, relationship:{following:true, followedBy:true}}), '互相关注');
  assert.equal(personalRelationshipLabel({relationshipKnown:true, relationship:{following:true, followedBy:false}}), '你关注对方');
  assert.equal(personalRelationshipLabel({relationshipKnown:true, relationship:{following:false, followedBy:true}}), '对方关注你');
  assert.equal(personalRelationshipLabel({relationshipKnown:true, relationship:{following:false, followedBy:false}}), '未互关');
  assert.equal(personalRelationshipLabel({relationshipKnown:false, relationship:{following:false, followedBy:false}}), '未互关');
  assert.equal(personalRelationshipLabel({relationshipKnown:false, relationship:{following:false, followedBy:null}}), '你未关注对方');
  assert.equal(personalRelationshipLabel({relationshipKnown:false, relationship:{following:true, followedBy:null}}), '你关注对方');
});

test('mutualUserCategory splits mutual network accounts into four tabs', () => {
  assert.equal(mutualUserCategory({relationship:{following:true, followedBy:true}}), 'mutual');
  assert.equal(mutualUserCategory({relationship:{following:true, followedBy:false}}), 'following');
  assert.equal(mutualUserCategory({relationship:{following:true, followedBy:null}}), 'following');
  assert.equal(mutualUserCategory({relationship:{following:false, followedBy:true}}), 'followBack');
  assert.equal(mutualUserCategory({relationship:{following:false, followedBy:false}}), 'none');
  assert.equal(mutualUserCategory({relationship:{following:false, followedBy:null}}), 'none');
  assert.equal(mutualUserCategory({}), 'none');
});

test('parses BlueVerifiedFollowers timeline users and pagination cursor', () => {
  const result = {rest_id:'987654321012345678', core:{screen_name:'verified_user', name:'Verified User'}, profile_bio:{description:'verified bio'}, relationship_counts:{followers:1200, following:900}, relationship_perspectives:{blocking:false, followed_by:true, following:false}};
  const json = {data:{user:{result:{timeline:{timeline:{instructions:[{entries:[
    {content:{itemContent:{user_results:{result}}}},
    {content:{__typename:'TimelineTimelineCursor', cursorType:'Bottom', value:'blue-next-cursor'}}
  ]}]}}}}}};
  const user = parseNetworkUsers(json).find(item => item.handle === 'verified_user');
  assert.equal(user.id, '987654321012345678');
  assert.equal(user.followersText, '1200');
  assert.equal(user.followingText, '900');
  assert.deepEqual(user.relationship, {blocking:false, followedBy:true, following:false});
  assert.equal(findCursor(json), 'blue-next-cursor');
});

test('Followers requests never reuse the captured transaction id from a prior page', () => {
  const templateHeaders = {
    authorization: 'Bearer mock_auth',
    'x-csrf-token': 'mock_csrf',
    'x-client-transaction-id': 'mock_tx_id'
  };
  const headers = prepareNetworkHeaders(templateHeaders, 'Followers');
  assert.equal(headers.authorization, 'Bearer mock_auth');
  assert.equal(headers['x-csrf-token'], 'mock_csrf');
  assert.equal(headers['x-client-transaction-id'], undefined);
  assert.equal(headers['content-type'], 'application/json');
});

test('non-Followers operations preserve their captured headers', () => {
  const templateHeaders = {
    authorization: 'Bearer mock_auth',
    'x-csrf-token': 'mock_csrf',
    'x-client-transaction-id': 'mock_tx_id'
  };
  const headers = prepareNetworkHeaders(templateHeaders, 'Following');
  assert.equal(headers.authorization, 'Bearer mock_auth');
  assert.equal(headers['x-csrf-token'], 'mock_csrf');
  assert.equal(headers['x-client-transaction-id'], 'mock_tx_id');
  assert.equal(headers['content-type'], 'application/json');
});

test('prepareNetworkHeaders strips mixed-case transaction header for Followers requests', () => {
  const templateHeaders = {
    Authorization: 'Bearer mock_auth',
    'X-Client-Transaction-Id': 'mock_tx_id'
  };
  const headers = prepareNetworkHeaders(templateHeaders, 'Followers');
  assert.equal(headers['x-client-transaction-id'], undefined);
  assert.equal(headers.authorization, 'Bearer mock_auth');
});

test('prepareNetworkVariables cleans base cursor and merges variables correctly', () => {
  const templateVars = JSON.stringify({userId: '123', cursor: 'stale_cursor', count: 20});
  const page1Vars = prepareNetworkVariables(templateVars, {userId: '456', count: 20});
  assert.equal(page1Vars.userId, '456');
  assert.equal(page1Vars.count, 20);
  assert.equal(page1Vars.cursor, undefined);

  const page2Vars = prepareNetworkVariables(templateVars, {userId: '456', count: 20, cursor: 'fresh_cursor'});
  assert.equal(page2Vars.cursor, 'fresh_cursor');
});

test('multi-page Followers variables remain independent of the captured transaction header', () => {
  const capturedTemplate = {
    queryId: 'mock_query_id',
    origin: 'https://x.com',
    variables: JSON.stringify({userId: '123', count: 20}),
    headers: {
      authorization: 'Bearer mock_auth',
      'x-csrf-token': 'mock_csrf',
      'x-client-transaction-id': 'single_use_tx_token'
    }
  };

  // Each page will request a new signed ID at runtime.
  const page1Vars = prepareNetworkVariables(capturedTemplate.variables, {userId: '123', count: 20});
  const page1Headers = prepareNetworkHeaders(capturedTemplate.headers, 'Followers');
  assert.equal(page1Headers['x-client-transaction-id'], undefined);
  assert.equal(page1Vars.cursor, undefined);

  // Cursor pages are signed separately with their actual request path.
  const page2Vars = prepareNetworkVariables(capturedTemplate.variables, {userId: '123', count: 20, cursor: 'cursor_step_1'});
  const page2Headers = prepareNetworkHeaders(capturedTemplate.headers, 'Followers');
  assert.equal(page2Headers['x-client-transaction-id'], undefined);
  assert.equal(page2Vars.cursor, 'cursor_step_1');

  const page3Vars = prepareNetworkVariables(capturedTemplate.variables, {userId: '123', count: 20, cursor: 'cursor_step_2'});
  const page3Headers = prepareNetworkHeaders(capturedTemplate.headers, 'Followers');
  assert.equal(page3Headers['x-client-transaction-id'], undefined);
  assert.equal(page3Vars.cursor, 'cursor_step_2');
});

test('follow-back labels require both explicit relationship directions', () => {
  for (const followedBy of [true,false,null]) for (const following of [true,false,null]) {
    const user=parseNetworkUsers({rest_id:'123',core:{screen_name:'candidate'},relationship_perspectives:{followed_by:followedBy,following}})[0];
    assert.equal(user.state,following===true?'following':following===false&&followedBy===true?'follow_back':following===false&&followedBy===false?'none':'unknown');
  }
  const stale={handle:'candidate',state:'follow_back',status:'pending',relationship:{followedBy:true,following:false}};
  const [updated]=reconcileFollowBackQueue([stale],[{...stale,state:'none',relationship:{followedBy:false,following:false}}]);
  assert.equal(updated.status,'no_longer_following');
});
