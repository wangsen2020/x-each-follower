import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCount, normalizeHandle, assess, riskAssess, matchMutualKeywords, evaluateMutualProfile, computeMultiDimensionTags, TAG_DEFINITIONS, parseGrokMutualAnalysis, filterMutualTrackingUsers, selectValuableMutualTargets, csv, formatPageSummary, repairMojibake} from '../src/features/relationships/scoring.js';

test('formatPageSummary formats exact pagination summary', () => {
  assert.equal(formatPageSummary(1, 3, 42), '1 / 3 · 42');
  assert.equal(formatPageSummary(2, 5, 100), '2 / 5 · 100');
  assert.equal(formatPageSummary(0, 0, 0), '0 / 0 · 0');
});

test('parse public profile count formats without turning missing values into zero', () => {
  for (const [text, expected] of [['1,234 Followers',1234],['1.2K Followers',1200],['2.5M',2500000],['1.3万 位关注者',13000],['2萬',20000],['1\u202f234 Followers',1234],['0 Following',0],['Followers',null],['',null]]) assert.equal(parseCount(text),expected,text);
});
test('accept handles and supported profile URLs, reject path injection', () => {
  assert.equal(normalizeHandle('https://x.com/alice_1/'),'alice_1');
  assert.equal(normalizeHandle('@alice'),'alice');
  for (const value of ['foo/following','https://evil.com/foo','foo?x=1','']) assert.throws(() => normalizeHandle(value));
});
const options = {minRatio:0.7,maxRatio:1.4,minCount:50,requirePromise:true};
const base = {name:'Alice',bio:'互关，欢迎交流',followers:100,following:110,status:'ok'};
test('candidate requires readable counts, sufficient population and optional promise', () => {
  assert.equal(assess(base, options).verdict,'候选');
  assert.equal(assess({...base,followers:10000}, options).verdict,'不推荐');
  assert.equal(assess({...base,followers:100,following:300}, options).verdict,'候选');
  assert.equal(assess({...base,followers:null}, options).verdict,'需复核');
  assert.equal(assess({...base,following:0}, options).verdict,'需复核');
  assert.equal(assess({...base,status:'unreadable'}, options).verdict,'需复核');
  assert.equal(assess({...base,followers:10,following:10}, options).verdict,'未命中');
  assert.equal(assess({...base,bio:'hello'}, options).verdict,'未命中');
  assert.equal(assess({...base,bio:'hello'}, {...options,requirePromise:false}).verdict,'候选');
  assert.equal(assess({...base,bio:'I follow back'}, options).promise,true);
});
test('CSV quotes untrusted profile data and neutralizes spreadsheet formulas', () => {
  const output = csv([{handle:'alice',name:'=CMD()',bio:'text,"quoted"\nnext'}]);
  assert.ok(output.includes('"\'=CMD()"'));
  assert.ok(output.includes('"text,""quoted""\nnext"'));
});
test('risk rules mark adult, private-content and high-risk funnel signals without false positives on normal phrases', () => {
  assert.equal(riskAssess({name:'', bio:'18+ 私密视频 加微私聊看'}).level, 'danger');
  assert.match(riskAssess({name:'', bio:'OnlyFans creator'}).hits.join(','), /成人/);
  assert.equal(riskAssess({name:'Alice', bio:'AI research and photography', posts:[{text:'分享今天的项目进展'}]}).level, 'normal');
  assert.equal(riskAssess({
    name: '辰一（浇朋友版）',
    bio: '裸辞独立开发，把握AI尺度，微信公众号同步更新，去机场路上在AI赛道下注，尝试AI写真',
    posts: [{text:'今天在机场候机写代码'}]
  }).level, 'normal');
  assert.equal(assess({name:'',bio:'NSFW 18+',followers:100,following:100,status:'ok'}, {...options,requirePromise:false}).verdict, '危险');
  assert.equal(riskAssess({name:'Alice', bio:'AI', grokRiskAssessment:{safe:false, reasons:[], riskTags:['risk:politics']}}).level, 'danger');
});

test('repairMojibake restores CP1252/latin1-decoded UTF-8 text and keeps normal text untouched', () => {
  const showhand = Buffer.from('梭哈姐（互浇版）', 'utf-8').toString('latin1');
  assert.equal(repairMojibake(showhand), '梭哈姐（互浇版）');
  assert.equal(repairMojibake('é˜¿å…°'), '阿兰');
  assert.equal(repairMojibake('åˆ›'), '创');
  assert.equal(repairMojibake('小晚风（互关版）'), '小晚风（互关版）');
  assert.equal(repairMojibake('Alice 123'), 'Alice 123');
  assert.equal(repairMojibake(''), '');
  assert.equal(repairMojibake(null), null);
});

test('evaluateMutualProfile marks following >= 80% of followers (within 1/5 gap, e.g. 4000/5000) as 推荐 and assigns mutual tag with hover reasons', () => {
  const safeMutual = evaluateMutualProfile({
    name: 'Alice',
    bio: '互关必回，长期活跃',
    followersText: '5,000',
    followingText: '4,000'
  });
  assert.equal(safeMutual.hasBaitRisk, false);
  assert.equal(safeMutual.noBaitRisk, true);
  assert.equal(safeMutual.recommendLabel, '推荐');
  assert.equal(safeMutual.baitRiskLabel, '推荐');
  assert.equal(safeMutual.tag, '互粉');
  assert.match(safeMutual.recommendReason, /^推荐原因：/);
  assert.match(safeMutual.intentTooltip, /^推荐原因：/);

  const notRecommendedUser = evaluateMutualProfile({
    name: 'Bob',
    bio: '互关必回',
    followersText: '5,000',
    followingText: '3,500'
  });
  assert.equal(notRecommendedUser.hasBaitRisk, true);
  assert.equal(notRecommendedUser.recommendLabel, '不推荐');
  assert.equal(notRecommendedUser.baitRiskLabel, '不推荐');
  assert.equal(notRecommendedUser.tag, '无');
  assert.match(notRecommendedUser.recommendReason, /^不推荐原因：/);
  assert.match(notRecommendedUser.intentTooltip, /^不推荐原因：/);

  const grokTaggedUser = evaluateMutualProfile({
    name: 'Carol',
    bio: 'Web3 builder',
    followersText: '5000',
    followingText: '4200',
    grokMutualIntent: true
  });
  assert.equal(grokTaggedUser.intentSource, 'grok');
  assert.equal(grokTaggedUser.tag, '互粉');
  assert.equal(grokTaggedUser.recommendLabel, '推荐');
});

test('matchMutualKeywords and evaluateMutualProfile detect mutual intent from top 5-10 posts in Chinese and English', () => {
  const cnPostsUser = evaluateMutualProfile({
    name: '普通昵称',
    bio: '记录日常',
    followersText: '5000',
    followingText: '4300',
    posts: [
      { text: '今天天气不错' },
      { text: '早安出摊！欢迎大家来串门，看到必回，多评多互动冲蓝V！' }
    ]
  });
  assert.equal(cnPostsUser.tag, '互粉');
  assert.equal(cnPostsUser.intentSource, 'posts');
  assert.ok(cnPostsUser.postKeywordHits.includes('串门'));
  assert.ok(cnPostsUser.postKeywordHits.includes('出摊'));
  assert.ok(cnPostsUser.postKeywordHits.includes('必回'));
  assert.ok(cnPostsUser.postKeywordHits.includes('蓝V'));

  const enPostsUser = matchMutualKeywords({
    name: 'Dev',
    bio: 'Building apps',
    posts: [
      { text: "Looking for active mutuals! Let's connect and grow together, I follow back everyone." }
    ]
  });
  assert.equal(enPostsUser.matched, true);
  assert.equal(enPostsUser.matchedInPosts, true);
  assert.ok(enPostsUser.postHits.includes('mutuals'));
  assert.ok(enPostsUser.postHits.includes("let's connect"));
  assert.ok(enPostsUser.postHits.includes('follow back'));
});

test('parseGrokMutualAnalysis extracts mutual intent and tags from Grok output', () => {
  const sample = [
    '账号 1 分析完毕：',
    '[@alice_1 | 互粉意向: 有 | 互粉标签: 互粉 | 推荐评估: 推荐 | 理由: 关注4000粉丝5000比例健康且经常互动]',
    '账号 2 分析完毕：',
    '[@bob_2 | 互粉意向: 无 | 互粉标签: 无 | 推荐评估: 不推荐 | 理由: 关注远少于粉丝数的4/5]'
  ].join('\n');
  const parsed = parseGrokMutualAnalysis(sample, ['alice_1', 'bob_2']);
  assert.equal(parsed.alice_1.grokMutualIntent, true);
  assert.equal(parsed.alice_1.mutualTag, '互粉');
  assert.match(parsed.alice_1.grokReason, /4000/);
  assert.equal(parsed.bob_2.grokMutualIntent, false);
  assert.equal(parsed.bob_2.mutualTag, '无');
});

test('filterMutualTrackingUsers filters by handle, name, bio, or cached posts keywords', () => {
  const users = [
    { handle: 'alice_web3', name: 'Alice', bio: 'AI & Crypto builder' },
    { handle: 'bob_daily', name: '小王', bio: '日常记录生活' },
    { handle: 'charlie_x', name: 'Charlie', bio: 'Photographer' }
  ];
  const cache = {
    charlie_x: { posts: [{ text: '早安出摊，欢迎大家来串门互关！' }] }
  };
  assert.equal(filterMutualTrackingUsers(users, '', cache).length, 3);
  assert.deepEqual(filterMutualTrackingUsers(users, '@alice', cache).map(u => u.handle), ['alice_web3']);
  assert.deepEqual(filterMutualTrackingUsers(users, '日常', cache).map(u => u.handle), ['bob_daily']);
  assert.deepEqual(filterMutualTrackingUsers(users, '串门', cache).map(u => u.handle), ['charlie_x']);
});

test('filterMutualTrackingUsers filters by activeTags and excludes bait risk', () => {
  const users = [
    { handle: 'ai_dev', name: 'AIDev', bio: 'AI & LLM 独立开发者', followers: 1200, following: 1100, is_blue_verified: true },
    { handle: 'crypto_guy', name: 'Web3Bro', bio: 'Crypto Airdrop', followers: 1500, following: 1400 },
    { handle: 'scam_kol', name: 'BigFake', bio: '关注我 t.me/scam', followers: 8000, following: 200 }
  ];

  // 1. 过滤蓝V
  const blueOnly = filterMutualTrackingUsers(users, '', {}, new Set(['identity:blue_v']));
  assert.deepEqual(blueOnly.map(u => u.handle), ['ai_dev']);

  // 2. 过滤 Web3 赛道
  const cryptoOnly = filterMutualTrackingUsers(users, '', {}, new Set(['niche:crypto_web3']));
  assert.deepEqual(cryptoOnly.map(u => u.handle), ['crypto_guy']);

  // 3. 排除骗关风险
  const excludeBait = filterMutualTrackingUsers(users, '', {}, new Set(['exclude:bait_risk']));
  assert.deepEqual(excludeBait.map(u => u.handle), ['ai_dev', 'crypto_guy']);

  // 4. 复合筛选：Web3 且排除骗关
  const multiFilter = filterMutualTrackingUsers(users, '', {}, new Set(['niche:crypto_web3', 'exclude:bait_risk']));
  assert.deepEqual(multiFilter.map(u => u.handle), ['crypto_guy']);
});

test('selectValuableMutualTargets selects unfollowed valuable accounts sorted by followback and mutual intent', () => {
  const users = [
    { handle: 'already_followed', name: 'Done', bio: '互关必回', followersText: '1000', followingText: '950', relationship: { following: true, followedBy: true } },
    { handle: 'bait_account', name: 'BigV', bio: '互关', followersText: '10000', followingText: '200', relationship: { following: false, followedBy: false } },
    { handle: 'valuable_peer', name: 'Peer', bio: '互粉必回，每天串门', followersText: '2000', followingText: '1900', relationship: { following: false, followedBy: false } },
    { handle: 'valuable_fan', name: 'Fan', bio: '互关冲蓝V', followersText: '1500', followingText: '1400', relationship: { following: false, followedBy: true } },
    { handle: 'unscanned_peer', name: 'NewPeer', bio: '普通简介', relationship: { following: false, followedBy: false } }
  ];
  const selectedStrict = selectValuableMutualTargets(users, { batchSize: 5, minFollowers: 100, onlyIntent: true }, {}, new Set());
  assert.deepEqual(selectedStrict.map(u => u.handle), ['valuable_fan', 'valuable_peer']);

  const selectedRelaxed = selectValuableMutualTargets(users, { batchSize: 5, minFollowers: 100, onlyIntent: false }, {}, new Set());
  assert.deepEqual(selectedRelaxed.map(u => u.handle), ['valuable_fan', 'valuable_peer', 'unscanned_peer']);

  // 验证已被跳过（autoFollowState === 'skipped'）的用户绝对不会被重复选为候选人
  const skippedUser = { handle: 'unscanned_peer', name: 'NewPeer', bio: '普通简介', relationship: { following: false, followedBy: false }, autoFollowState: 'skipped' };
  const usersWithSkipped = [users[0], users[1], users[2], users[3], skippedUser];
  const selectedWithoutSkipped = selectValuableMutualTargets(usersWithSkipped, { batchSize: 5, minFollowers: 100, onlyIntent: false }, {}, new Set());
  assert.deepEqual(selectedWithoutSkipped.map(u => u.handle), ['valuable_fan', 'valuable_peer']);

  // 验证 profileCache 中已被跳过的用户也绝对不会被选为候选人
  const cacheSkipped = { unscanned_peer: { autoFollowState: 'skipped' } };
  const selectedWithCacheSkipped = selectValuableMutualTargets(users, { batchSize: 5, minFollowers: 100, onlyIntent: false }, cacheSkipped, new Set());
  assert.deepEqual(selectedWithCacheSkipped.map(u => u.handle), ['valuable_fan', 'valuable_peer']);

  // 针对类似 SquadBookHome 账号（关注12，粉丝4938，极低回关率）：必须被 evaluateMutualProfile 判定为不推荐且拒关
  const squadBookUser = { handle: 'SquadBookHome', name: 'SquadBook.com', bio: 'Collect. Swap. Complete. Repeat.', followingText: '12', followersText: '4,938', relationship: { following: false, followedBy: false } };
  const squadEval = evaluateMutualProfile(squadBookUser);
  assert.equal(squadEval.isNotRecommended, true);
  assert.equal(squadEval.recommendLabel, '不推荐');
  assert.match(squadEval.recommendReason, /回关比例偏低/);
});

test('computeMultiDimensionTags correctly identifies multi-dimensional tags across 5 categories', () => {
  // 1. 诚信蓝V + AI科技开发者
  const techUser = {
    handle: 'tech_dev',
    name: 'TechDev',
    bio: 'AI & LLM 独立开发者，Prompt 爱好者',
    followers: 1200,
    following: 1100,
    is_blue_verified: true
  };
  const techTags = computeMultiDimensionTags(techUser);
  assert.ok(techTags.tagIds.includes('identity:blue_v'));
  assert.ok(techTags.tagIds.includes('niche:ai_tech'));
  assert.ok(techTags.tagIds.includes('reputation:mutual_credit'));

  // 2. 骗关风险 + 营销引流账号
  const marketerUser = {
    handle: 'scam_lead',
    name: '营销达人',
    bio: '加V领绝密资料，进群看置顶 t.me/free_crypto',
    followers: 8000,
    following: 200
  };
  const marketerTags = computeMultiDimensionTags(marketerUser);
  assert.ok(marketerTags.tagIds.includes('reputation:bait_risk'));
  assert.ok(marketerTags.tagIds.includes('identity:marketer'));
  assert.ok(marketerTags.tagIds.includes('niche:crypto_web3'));

  // 3. 秒回承诺 + 日更活跃
  const activeUser = {
    handle: 'quick_man',
    name: '秒回小分队',
    bio: '有粉必回，常互动多串门',
    followers: 800,
    following: 850,
    posts: [
      { text: '今天新动态', created_at: new Date(Date.now() - 3600000).toISOString() }
    ]
  };
  const activeTags = computeMultiDimensionTags(activeUser);
  assert.ok(activeTags.tagIds.includes('reputation:quick_back'));
  assert.ok(activeTags.tagIds.includes('activity:engager'));
  assert.ok(activeTags.tagIds.includes('activity:daily'));

  // 4. 自定义白名单与标星
  const customUser = {
    handle: 'vip_friend',
    name: '老朋友',
    bio: '日常随笔',
    whitelist: true,
    starred: true
  };
  const customTags = computeMultiDimensionTags(customUser);
  assert.ok(customTags.tagIds.includes('custom:whitelist'));
  assert.ok(customTags.tagIds.includes('custom:starred'));
});



