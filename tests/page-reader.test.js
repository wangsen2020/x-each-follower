import test from 'node:test';
import assert from 'node:assert/strict';
import {collectVisible, readProfile, readProfileBundle, readPostMetricsOnPage, scanFollowers, clickFollowOnProfile, clickFollowBackOnProfile, isOwnFollowersRoute} from '../src/platform/x/page-reader.js';

const link = (path, text) => ({href:`https://x.com${path}`,innerText:text});
test('own follower scan reuses only the logged-in account followers route', () => {
  assert.equal(isOwnFollowersRoute('https://x.com/owner/followers', 'Owner'), true);
  assert.equal(isOwnFollowersRoute('https://x.com/owner/followers/', 'owner'), true);
  assert.equal(isOwnFollowersRoute('https://x.com/owner/verified_followers', 'owner'), false);
  assert.equal(isOwnFollowersRoute('https://x.com/someone_else/followers', 'owner'), false);
  assert.equal(isOwnFollowersRoute('https://x.com/followers', 'owner'), false);
});
test('DOM follower fallback records confirmed follow-back relationship for the archive', () => {
  globalThis.location={pathname:'/owner/followers',origin:'https://x.com'};
  globalThis.window={innerHeight:800,scrollBy:()=>{}};
  const cell=(handle,label)=>({innerText:`${handle}\n@${handle}`,querySelectorAll:selector=>selector==='a[href]'?[link(`/${handle}`,handle)]:[{innerText:label,getAttribute:()=>'',dataset:{}}]});
  globalThis.document={querySelector:()=>({querySelectorAll:()=>[cell('alice','Follow back'),cell('bob','Following')]})};
  const result=scanFollowers();
  assert.deepEqual(result.users.map(user=>user.relationship),[{followedBy:true,following:false},{followedBy:true,following:true}]);
});
test('collection uses only following user cells, deduplicates and checks target route', () => {
  globalThis.location = {pathname:'/owner/following',origin:'https://x.com'};
  let scrolled = false;
  globalThis.window = {innerHeight:800,scrollBy:()=>{scrolled=true;}};
  const cells = [{innerText:'Alice\n@alice',querySelectorAll:()=>[link('/alice','Alice'),link('/alice','@alice'),link('/other','Other')]}];
  globalThis.document = {querySelector: selector => {
    assert.equal(selector,'[data-testid="primaryColumn"]');
    return {querySelectorAll:selector=>{assert.equal(selector,'[data-testid="UserCell"]'); return cells;}};
  }};
  assert.deepEqual(collectVisible('owner').handles,['alice']);
  assert.ok(scrolled);
  assert.throws(()=>collectVisible('different'));
});
test('profile reads handle-specific counts, supports verified followers, waits for missing counts', () => {
  globalThis.location = {pathname:'/alice',origin:'https://x.com'};
  let links = [link('/other/followers','900K Followers'),link('/alice/following','110 Following'),link('/alice/verified_followers','100 Followers')];
  globalThis.document = {querySelector:()=>({
    querySelector:selector=>selector.includes('UserName') ? {innerText:'Alice\n@alice'} : {innerText:'互关'},
    querySelectorAll:()=>links
  })};
  const result = readProfile('alice');
  assert.equal(result.followersText,'100 Followers');
  assert.equal(result.followingText,'110 Following');
  assert.equal(result.name,'Alice');
  assert.equal(result.pending,false);
  assert.equal(readProfile('bob').pending,true);
  links = [];
  assert.equal(readProfile('alice').pending,true);
});
test('profile follow action only clicks an exact Follow button', () => {
  globalThis.location = {pathname:'/alice',origin:'https://x.com'};
  let clicked = 0;
  const button = {innerText:'Follow', getAttribute:()=>'', click:()=>{clicked++;}};
  globalThis.document = {querySelector:()=>({querySelectorAll:()=>[button]})};
  assert.deepEqual(clickFollowOnProfile('alice'), {ok:true});
  assert.equal(clicked,1);
  globalThis.document = {querySelector:()=>({querySelectorAll:()=>[{innerText:'Following',getAttribute:()=>''}]})};
  assert.deepEqual(clickFollowOnProfile('alice'), {ok:false, reason:'already_following'});
  const followBack = {innerText:'Follow back', getAttribute:()=>'', click:()=>{clicked++;}};
  globalThis.document = {querySelector:()=>({querySelectorAll:()=>[followBack]})};
  assert.deepEqual(clickFollowOnProfile('alice'), {ok:false, reason:'already_following'});
  assert.equal(clicked,1);
});
test('profile follow-back action only clicks an exact Follow back button', () => {
  globalThis.location = {pathname:'/alice',origin:'https://x.com'};
  let clicked = 0;
  const button = {innerText:'Follow back', getAttribute:()=>'', click:()=>{clicked++;}};
  globalThis.document = {querySelector:()=>({querySelectorAll:()=>[button]})};
  assert.deepEqual(clickFollowBackOnProfile('alice'), {ok:true});
  assert.equal(clicked,1);
  for (const innerText of ['Follow', 'Following', 'Pending', 'Following back', 'Followed back', 'Unfollow back']) {
    const decoy = {innerText, getAttribute:()=>'', click:()=>{clicked++;}};
    globalThis.document = {querySelector:()=>({querySelectorAll:()=>[decoy]})};
    const result = clickFollowBackOnProfile('alice');
    assert.equal(result.ok, false, innerText);
    assert.notEqual(result.reason, undefined);
    assert.equal(clicked, 1, innerText);
  }
  globalThis.document = {querySelector:()=>({querySelectorAll:()=>[{innerText:'Following',getAttribute:()=>''}]})};
  assert.deepEqual(clickFollowBackOnProfile('alice'), {ok:false, reason:'already_following'});
  globalThis.document = {querySelector:()=>({querySelectorAll:()=>[{innerText:'Pending',getAttribute:()=>''}]})};
  assert.deepEqual(clickFollowBackOnProfile('alice'), {ok:false, reason:'already_following'});
  globalThis.document = {querySelector:()=>({querySelectorAll:()=>[{innerText:'Follow',getAttribute:()=>''}]})};
  assert.deepEqual(clickFollowBackOnProfile('alice'), {ok:false, reason:'follow_button_unavailable'});
});

test('profile follow actions remain self-contained after executeScript serialization', () => {
  globalThis.location = {pathname:'/alice',origin:'https://x.com'};
  let clicked = 0;
  const follow = {innerText:'Follow', getAttribute:()=>'', click:()=>{clicked++;}};
  globalThis.document = {body:{innerText:''}, querySelector:()=>({querySelectorAll:()=>[follow]})};
  const injectedFollow = Function(`return (${clickFollowOnProfile.toString()});`)();
  assert.deepEqual(injectedFollow('alice'), {ok:true});
  assert.equal(clicked, 1);

  const followBack = {innerText:'Follow back', getAttribute:()=>'', click:()=>{clicked++;}};
  globalThis.document = {body:{innerText:''}, querySelector:()=>({querySelectorAll:()=>[followBack]})};
  const injectedFollowBack = Function(`return (${clickFollowBackOnProfile.toString()});`)();
  assert.deepEqual(injectedFollowBack('alice'), {ok:true});
  assert.equal(clicked, 2);
});

test('readProfileBundle extracts profile bundle and posts up to recentLimit', () => {
  globalThis.location = {pathname:'/alice',origin:'https://x.com'};
  const links = [link('/alice/following','110 Following'),link('/alice/verified_followers','100 Followers')];
  const articles = [
    {innerText:'Hello world 1',querySelector:s=>s==='time'?{getAttribute:()=>'2026-10-15T00:00:00Z'}:null,querySelectorAll:()=>[{getAttribute:()=>'/alice/status/123'}]},
    {innerText:'Hello world 2',querySelector:s=>s==='time'?{getAttribute:()=>'2026-10-14T00:00:00Z'}:null,querySelectorAll:()=>[{getAttribute:()=>'/alice/status/124'}]},
  ];
  globalThis.document = {querySelector:()=>({
    querySelector:selector=>selector.includes('UserName') ? {innerText:'Alice\n@alice'} : selector.includes('UserDescription') ? {innerText:'Bio text'} : null,
    querySelectorAll:selector=>selector==='article'?articles:selector==='a[href]'?links:[]
  })};
  const result = readProfileBundle('alice', 1);
  assert.equal(result.pending, false);
  assert.equal(result.name, 'Alice');
  assert.equal(result.bio, 'Bio text');
  assert.equal(result.followersText, '100 Followers');
  assert.equal(result.followingText, '110 Following');
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].text, 'Hello world 1');
  assert.equal(result.posts[0].textComplete,false,'whole article chrome is not proof of a complete post');
  assert.equal(result.posts[0].replyCount,null,'missing reply controls stay unknown');
  for (const [raw,expected] of [['',0],['1,234',1234],['1.2K',1200],['2万',20000],['unavailable',null]]) {
    articles[0].querySelector=selector=>selector==='[data-testid="reply"]' ? {innerText:raw} : null;
    assert.equal(readProfileBundle('alice',1).posts[0].replyCount,expected);
  }
  articles[0].querySelector=selector=>selector.includes('bookmark') ? {innerText:''} : selector.includes('retweet') ? {innerText:'3'} : selector.includes('like') ? {innerText:'12'} : null;
  const metrics=readProfileBundle('alice',1).posts[0];
  assert.equal(metrics.bookmarkCount,null,'empty bookmark control does not expose the count');
  assert.equal(metrics.repostCount,3);assert.equal(metrics.likeCount,12);
  for (const label of ['置顶','Pinned','已釘選']) {
    articles[0].querySelector=selector=>selector==='[data-testid="socialContext"]' ? {innerText:label} : null;
    assert.equal(readProfileBundle('alice',1).posts[0].text,'Hello world 2');
  }
  let truncated=false;
  articles[0].querySelector=selector=>selector==='[data-testid="tweetText"]' ? {innerText:'Actual original text'}
    : selector==='[data-testid="tweet-text-show-more-link"]' ? truncated ? {} : null : null;
  assert.equal(readProfileBundle('alice',1).posts[0].text,'Actual original text');
  assert.equal(readProfileBundle('alice',1).posts[0].textComplete,true);
  truncated=true;
  assert.equal(readProfileBundle('alice',1).posts[0].textComplete,false);
});

test('page metrics match exact source IDs and do not use a quoted tweet or invent missing bookmarks',()=>{
  const tweet={id_str:'123',reply_count:4,retweet_count:5,favorite_count:6,bookmark_count:7};
  const article={__reactFiber$test:{memoizedProps:{tweet:{...tweet,id_str:'999',bookmark_count:999}},return:{memoizedProps:{tweet}}}};
  const previous=globalThis.document;
  globalThis.document={querySelectorAll:()=>[article]};
  try {
    assert.deepEqual(readPostMetricsOnPage(['123']),{'123':{replyCount:4,repostCount:5,likeCount:6,bookmarkCount:7}});
    delete tweet.bookmark_count;
    assert.equal(readPostMetricsOnPage(['123'])['123'].bookmarkCount,null);
    assert.deepEqual(readPostMetricsOnPage(['456']),{});
  } finally {globalThis.document=previous;}
});

test('profile bundle reads the target account follow button and user ID, not another account', () => {
  globalThis.location = {pathname:'/pnsin1',origin:'https://x.com'};
  const links = [link('/pnsin1/following','5,418 Following'),link('/pnsin1/verified_followers','5,203 Followers')];
  const button = (label,id)=>({getAttribute:key=>key==='aria-label'?label:key==='data-testid'?id:null});
  let buttons=[button('Following @another_user','123-unfollow'),button('Following @pnsin1','1562136801183027200-unfollow')];
  globalThis.document = {querySelector:()=>({
    querySelector:s=>s.includes('UserName')?{innerText:'SeNa\n@pnsin1'}:null,
    querySelectorAll:s=>s==='button[data-testid]'?buttons:s==='article'?[]:links
  })};
  const followed=readProfileBundle('pnsin1',0);
  assert.equal(followed.relationship.following,true);
  assert.equal(followed.id,'1562136801183027200');
  buttons=[button('Following @another_user','123-unfollow'),button('Follow @pnsin1','1562136801183027200-follow')];
  assert.equal(readProfileBundle('pnsin1',0).relationship.following,false);
  buttons=[button('Following @pnsin12','999-unfollow')];
  assert.deepEqual(readProfileBundle('pnsin1',0).relationship,{});
});

test('profile empty state is terminal; ordinary text, loading and other routes are not',()=>{
  globalThis.location={pathname:'/missing',origin:'https://x.com'};
  let empty='此账号不存在\n尝试搜索另一个。';
  globalThis.document={querySelector:()=>({querySelector:s=>s==='[data-testid="emptyState"]'?{innerText:empty}:null,querySelectorAll:()=>[]})};
  for(const reader of [readProfile,readProfileBundle]){
    for(const text of ['此账号不存在\n尝试搜索另一个。','此帳號不存在',"This account doesn’t exist\nTry searching for another.","This account doesn't exist",'This account does not exist']){empty=text;assert.equal(reader('missing').status,'not_found');assert.equal(reader('missing').pending,false);}
    empty='Something went wrong. Try again.';assert.equal(reader('missing').pending,true);
    empty='';assert.equal(reader('missing').pending,true);
    empty='此账号不存在';assert.equal(reader('another').pending,true);
  }
});

test('profile identifies pending request by the actual target button ID without reading unrelated cells',()=>{
 globalThis.location={pathname:'/alice',origin:'https://x.com'};
 const button={innerText:'等待确认',getAttribute:key=>key==='data-testid'?'42-cancel':null,closest:()=>null};
 globalThis.document={querySelector:()=>({querySelector:s=>s.includes('UserName')?{innerText:'Alice'}:null,querySelectorAll:s=>s==='a[href]'?[link('/alice/following','1'),link('/alice/followers','1')]:s==='button[data-testid]'?[button]:[]})};
 assert.equal(readProfileBundle('alice').pendingRequestUserId,'42');button.closest=()=>({});assert.equal(readProfileBundle('alice').pendingRequestUserId,undefined);
});
