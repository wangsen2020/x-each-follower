import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectContentRisks,
  isPostSafeForComment,
  RISK_DEFINITIONS,
  buildGrokProfileAssessmentPrompt,
  parseGrokProfileAssessment,
  evaluateProfileGrokRisk
} from '../content-risk.js';
import { computeMultiDimensionTags, TAG_DEFINITIONS, filterMutualTrackingUsers, riskAssess } from '../scoring.js';
import { buildGrokCommentPrompt, requestGrokComment, postQuoteOnTab } from '../grok-comment.js';

test('detectContentRisks accurately identifies politics, military, religion, violence, porn, suggestive, sensational', () => {
  // 1. 涉政 (Politics)
  const politics1 = detectContentRisks('中南海内部高层政争激烈，传党魁下台维稳翻墙抗议');
  assert.equal(politics1.hasRisk, true);
  assert.equal(politics1.isSevere, true);
  assert.ok(politics1.categories.includes('politics'));
  assert.ok(politics1.tagIds.includes('risk:politics'));
  assert.ok(politics1.labels.includes('涉政'));

  const politicsEn = detectContentRisks('Breaking news about the CCP regime and political dissident uprising');
  assert.equal(politicsEn.hasRisk, true);
  assert.ok(politicsEn.categories.includes('politics'));

  // 2. 涉军 (Military)
  const military1 = detectContentRisks('俄乌战争最新前线战报，空袭轰炸与导弹袭击造成军火库爆炸');
  assert.equal(military1.hasRisk, true);
  assert.equal(military1.isSevere, true);
  assert.ok(military1.categories.includes('military'));
  assert.ok(military1.tagIds.includes('risk:military'));
  assert.ok(military1.labels.includes('涉军'));

  const militaryEn = detectContentRisks('Armed forces clash with missile attack and artillery shelling');
  assert.equal(militaryEn.hasRisk, true);
  assert.ok(militaryEn.categories.includes('military'));

  // 3. 涉宗教 (Religion)
  const religion1 = detectContentRisks('邪教组织发布极端宗教圣战呼吁，引发宗教迫害与冲突');
  assert.equal(religion1.hasRisk, true);
  assert.equal(religion1.isSevere, true);
  assert.ok(religion1.categories.includes('religion'));
  assert.ok(religion1.tagIds.includes('risk:religion'));
  assert.ok(religion1.labels.includes('涉宗教'));

  // 4. 暴力 (Violence)
  const violence1 = detectContentRisks('持刀行凶与恐怖恶性杀戮，现场血腥肢解尸体');
  assert.equal(violence1.hasRisk, true);
  assert.equal(violence1.isSevere, true);
  assert.ok(violence1.categories.includes('violence'));
  assert.ok(violence1.tagIds.includes('risk:violence'));
  assert.ok(violence1.labels.includes('暴力'));

  // 5. 色情 (Pornography)
  const porn1 = detectContentRisks('高清无码成人片做爱视频，露点自慰视频仅在OnlyFans');
  assert.equal(porn1.hasRisk, true);
  assert.equal(porn1.isSevere, true);
  assert.ok(porn1.categories.includes('pornography'));
  assert.ok(porn1.tagIds.includes('risk:pornography'));
  assert.ok(porn1.labels.includes('色情'));

  // 6. 擦边 (Suggestive)
  const suggestive1 = detectContentRisks('福利姬同城约炮空降服务，私房照大尺度性感写真');
  assert.equal(suggestive1.hasRisk, true);
  assert.ok(suggestive1.categories.includes('suggestive'));
  assert.ok(suggestive1.tagIds.includes('risk:suggestive'));
  assert.ok(suggestive1.labels.includes('擦边'));

  // 7. 猎奇 (Sensational)
  const sensational1 = detectContentRisks('变态重口味排泄恶心残害，暗网重口畸形');
  assert.equal(sensational1.hasRisk, true);
  assert.ok(sensational1.categories.includes('sensational'));
  assert.ok(sensational1.tagIds.includes('risk:sensational'));
  assert.ok(sensational1.labels.includes('猎奇'));
});

test('detectContentRisks does not falsely flag neutral tech and development content', () => {
  const safeText1 = '今天用 Vue3 和 Vite 构建了一个 Chrome 扩展，响应式系统性能提升 50%，代码非常干净。';
  const res1 = detectContentRisks(safeText1);
  assert.equal(res1.hasRisk, false);
  assert.equal(res1.categories.length, 0);

  const safeText2 = 'Sharing my open-source AI project on GitHub: clean architecture and local LLM agents for daily automation.';
  const res2 = detectContentRisks(safeText2);
  assert.equal(res2.hasRisk, false);
  assert.equal(res2.categories.length, 0);

  const safeText3 = '有关必回，常互动多串门，诚信互粉一起涨粉！';
  const res3 = detectContentRisks(safeText3);
  assert.equal(res3.hasRisk, false);
});

test('social hardship with collective resistance is blocked while ordinary unemployment remains allowed', () => {
  const observedPost = '中国年轻人和中年人同时面临无业和失业，14亿人口卷到无法呼吸，在这种环境下面该如何反抗？';
  assert.ok(detectContentRisks(observedPost).categories.includes('politics'));
  assert.equal(isPostSafeForComment({text:observedPost}).safe, false);
  assert.equal(detectContentRisks('今年失业了，吃挂面、找工作，顺便学 Vue3。').hasRisk, false);
});

test('quote publication also blocks a risky generated reply before opening a window', async () => {
  const post = {url:'https://x.com/example/status/123',text:'今天分享一个普通技术教程'};
  const reply = '失业者在当前社会该如何反抗？';
  const result = await postQuoteOnTab(1,post,reply,()=>{},async()=>{});
  assert.equal(result.ok,false);
  assert.equal(result.riskBlocked,true);
  assert.match(result.reason,/生成的引用评价/);
});

test('isPostSafeForComment prevents Grok commenting on sensitive posts', () => {
  const unsafePost1 = { text: '前线俄乌战争持续激化，空袭导弹袭击造成重大战损', url: 'https://x.com/user/status/123' };
  const check1 = isPostSafeForComment(unsafePost1, { handle: 'reporter', name: '战地观察' });
  assert.equal(check1.safe, false);
  assert.ok(check1.reason.includes('涉军'));

  const unsafePost2 = { text: '今日更新福利姬露点做爱私房视频，快来OnlyFans订阅', url: 'https://x.com/user/status/456' };
  const check2 = isPostSafeForComment(unsafePost2, { handle: 'model', name: '福利小妹' });
  assert.equal(check2.safe, false);
  assert.ok(check2.reason.includes('色情') || check2.reason.includes('擦边'));

  const unsafeUser = { text: '今天天气真不错，出去散步', url: 'https://x.com/user/status/789' };
  const check3 = isPostSafeForComment(unsafeUser, { handle: 'cult_leader', name: '全能神教主', bio: '极端宗教圣战组织信徒' });
  assert.equal(check3.safe, false);
  assert.ok(check3.reason.includes('高危信号') || check3.reason.includes('涉宗教'));

  const safePost = { text: '今天学习了 TypeScript 泛型的高级用法，收获满满！', url: 'https://x.com/dev/status/111' };
  const checkSafe = isPostSafeForComment(safePost, { handle: 'coder', name: '全栈开发' });
  assert.equal(checkSafe.safe, true);
});

test('scoring.js integrates risk tags into TAG_DEFINITIONS and computeMultiDimensionTags', () => {
  // TAG_DEFINITIONS contains all 7 risk tags
  assert.ok(TAG_DEFINITIONS['risk:politics']);
  assert.ok(TAG_DEFINITIONS['risk:military']);
  assert.ok(TAG_DEFINITIONS['risk:religion']);
  assert.ok(TAG_DEFINITIONS['risk:violence']);
  assert.ok(TAG_DEFINITIONS['risk:pornography']);
  assert.ok(TAG_DEFINITIONS['risk:suggestive']);
  assert.ok(TAG_DEFINITIONS['risk:sensational']);

  assert.equal(TAG_DEFINITIONS['risk:politics'].label, '🏛️ 涉政');
  assert.equal(TAG_DEFINITIONS['risk:military'].label, '⚔️ 涉军');
  assert.equal(TAG_DEFINITIONS['risk:religion'].label, '🕊️ 涉宗教');
  assert.equal(TAG_DEFINITIONS['risk:violence'].label, '🚫 暴力');
  assert.equal(TAG_DEFINITIONS['risk:pornography'].label, '🔞 色情');

  // computeMultiDimensionTags tags a profile with risk
  const riskyProfile = {
    handle: 'news_leak',
    name: '内幕速递',
    bio: '专注中南海高层政争与维稳内幕，揭露党魁暴政',
    followers: 1200,
    following: 1100
  };
  const tagsRes = computeMultiDimensionTags(riskyProfile);
  assert.ok(tagsRes.tagIds.includes('risk:politics'));

  // riskAssess also flags danger
  const assessment = riskAssess(riskyProfile);
  assert.equal(assessment.level, 'danger');
  assert.ok(assessment.riskCategories?.includes('politics'));
});

test('filterMutualTrackingUsers supports exclude:risk to filter out sensitive accounts', () => {
  const users = [
    { handle: 'tech_dev', name: '前端老张', bio: 'AI 独立开发，Python 与 React' },
    { handle: 'war_channel', name: '战报速递', bio: '俄乌冲突前线导弹战事直播' },
    { handle: 'porn_bot', name: '成人影院', bio: 'OnlyFans 露点做爱福利视频' }
  ];

  const profileCache = {
    tech_dev: { bio: 'AI 独立开发，Python 与 React', followers: 1000, following: 950 },
    war_channel: { bio: '俄乌冲突前线导弹战事直播', followers: 2000, following: 1800 },
    porn_bot: { bio: 'OnlyFans 露点做爱福利视频', followers: 500, following: 450 }
  };

  // 没有过滤时，3人都在
  const allUsers = filterMutualTrackingUsers(users, '', profileCache, []);
  assert.equal(allUsers.length, 3);

  // 勾选 exclude:risk 后，只剩下 tech_dev，涉军和色情被排除
  const filtered = filterMutualTrackingUsers(users, '', profileCache, ['exclude:risk']);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].handle, 'tech_dev');
});

test('requestGrokComment rejects risk post pre-flight without network consumption', async () => {
  const riskPost = {
    text: '突发：中东地区发生自杀式爆炸恐怖袭击，斩首与流血冲突加剧',
    url: 'https://x.com/news/status/999999'
  };

  // requestGrokComment should return riskBlocked: true immediately
  const res = await requestGrokComment('terror_news', riskPost, '新闻号', {
    sleep: async () => {}
  });

  assert.equal(res.ok, false);
  assert.equal(res.riskBlocked, true);
  assert.ok(res.reason.includes('暴力'));
});

test('postQuoteOnTab rejects risk post pre-flight before opening windows', async () => {
  const riskPost = {
    text: '最新 OnlyFans 裸露自慰做爱高清视频',
    url: 'https://x.com/porn/status/888888'
  };

  const res = await postQuoteOnTab(null, riskPost, '一些评价', () => {}, async () => {});
  assert.equal(res.ok, false);
  assert.equal(res.riskBlocked, true);
  assert.ok(res.reason.includes('高风险内容') || res.reason.includes('色情'));
});

test('buildGrokCommentPrompt includes calibrated safety instructions distinguishing advocacy vs description', () => {
  const prompt = buildGrokCommentPrompt({
    handle: 'nice_user',
    name: '好青年',
    postText: '今天分享开源代码',
    nonce: 'nonce123'
  });

  assert.ok(prompt.includes('安全与审核边界'));
  assert.ok(prompt.includes('坚决拦截'));
  assert.ok(prompt.includes('正常放行'));
  assert.ok(prompt.includes('躺平'));
  assert.ok(prompt.includes('失业'));
  assert.ok(prompt.includes('恐怖主义'));
});

test('detectContentRisks catches English plural and geopolitical conflict variants (e.g. Terrorists, failed state)', () => {
  const tweetText = 'Ben @BenUnegbe · 10月14日 Very unfortunate. 引用 J. C. Okechukwu @jcokechukwu · 10月14日 I consider this one of the greatest and most humiliating signs of a failed state to come out of Nigeria. Terrorists reportedly playing around with medical equipment, obviously in one of the many enclaves they’ve captured in northern Nigeria. This truly calls for sober 6';
  const risk = detectContentRisks(tweetText);
  assert.equal(risk.hasRisk, true);
  assert.equal(risk.isSevere, true);
  assert.ok(risk.categories.includes('violence') || risk.categories.includes('politics'));

  const safety = isPostSafeForComment({ text: tweetText }, { handle: 'BenUnegbe', name: 'Ben' });
  assert.equal(safety.safe, false);
  assert.ok(safety.categories.includes('violence'));
  assert.ok(safety.categories.includes('politics'));
});

test('buildGrokProfileAssessmentPrompt constructs prompt with up to 10 posts and safety redlines', () => {
  const posts = Array.from({ length: 15 }, (_, i) => ({ text: `推文 #${i + 1} 讨论技术与观点` }));
  const prompt = buildGrokProfileAssessmentPrompt({
    handle: 'blogger',
    name: '博主小王',
    bio: '科技博主与独立开发者',
    posts
  });

  assert.ok(prompt.includes('@blogger'));
  assert.ok(prompt.includes('推文 #1'));
  assert.ok(prompt.includes('推文 #10'));
  // Should not exceed 10 posts
  assert.ok(!prompt.includes('推文 #11'));
  assert.ok(prompt.includes('politics'));
  assert.ok(prompt.includes('violence'));
  assert.ok(prompt.includes('pornography'));
  assert.ok(prompt.includes('```json'));
});

test('parseGrokProfileAssessment parses structured JSON and markdown fences accurately', () => {
  // 1. Safe JSON output
  const safeOutput = `\`\`\`json
{
  "safe": true,
  "riskCategories": [],
  "riskTags": [],
  "nicheTags": ["niche:ai_tech"],
  "reasons": [],
  "summary": "AI开发者"
}
\`\`\``;
  const parsed1 = parseGrokProfileAssessment(safeOutput);
  assert.equal(parsed1.evaluated, true);
  assert.equal(parsed1.safe, true);
  assert.equal(parsed1.categories.length, 0);
  assert.ok(parsed1.tags.includes('niche:ai_tech'));

  // 2. Unsafe JSON output with risk categories
  const unsafeOutput = `\`\`\`json
{
  "safe": false,
  "riskCategories": ["politics", "violence"],
  "riskTags": ["risk:politics", "risk:violence"],
  "nicheTags": [],
  "reasons": ["探讨政变与武装冲突"],
  "summary": "政经时评号"
}
\`\`\``;
  const parsed2 = parseGrokProfileAssessment(unsafeOutput);
  assert.equal(parsed2.evaluated, true);
  assert.equal(parsed2.safe, false);
  assert.ok(parsed2.categories.includes('politics'));
  assert.ok(parsed2.categories.includes('violence'));
  assert.ok(parsed2.riskTags.includes('risk:politics'));
  assert.ok(parsed2.labels.includes('🏛️ 涉政'));
  assert.ok(parsed2.labels.includes('🚫 暴力'));
});

test('evaluateProfileGrokRisk implements persistent identifier check and avoids re-querying Grok', async () => {
  let runnerCalled = 0;
  const mockRunner = async () => {
    runnerCalled++;
    return {
      ok: true,
      text: JSON.stringify({
        safe: false,
        riskCategories: ['military'],
        riskTags: ['risk:military'],
        nicheTags: [],
        reasons: ['战况直播'],
        summary: '军事战报'
      })
    };
  };

  const freshProfile = {
    handle: 'war_channel',
    name: '战报',
    bio: '战况前线'
  };

  // First evaluation: runner called
  const res1 = await evaluateProfileGrokRisk(freshProfile, { runner: mockRunner });
  assert.equal(runnerCalled, 1);
  assert.equal(res1.evaluated, true);
  assert.equal(res1.cached, false);
  assert.equal(res1.safe, false);
  assert.ok(res1.categories.includes('military'));

  // Simulate storing assessment onto profile
  freshProfile.grokRiskAssessment = res1;
  freshProfile.grokAssessedAt = res1.at;

  // Second evaluation: cache hit! Runner MUST NOT be called again
  const res2 = await evaluateProfileGrokRisk(freshProfile, { runner: mockRunner });
  assert.equal(runnerCalled, 1); // Still 1!
  assert.equal(res2.cached, true);
  assert.equal(res2.safe, false);
  assert.ok(res2.categories.includes('military'));
});

test('buildGrokProfileAssessmentPrompt includes explicit exemptions for social observation (躺平/失业/不婚)', () => {
  const prompt = buildGrokProfileAssessmentPrompt({
    handle: 'observer',
    name: '小张',
    bio: '普通人记录生活',
    posts: [{ text: '今年躺平不买房了，吃挂面也挺香' }]
  });

  assert.ok(prompt.includes('严格豁免正常社会生活观察'));
  assert.ok(prompt.includes('明确豁免清单'));
  assert.ok(prompt.includes('躺平'));
  assert.ok(prompt.includes('失业'));
  assert.ok(prompt.includes('描述 vs 倡导'));
});
