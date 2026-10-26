// content-risk.js - 内容风险识别与安全门禁模块
// 负责识别色情、暴力、涉政、涉军、涉宗教、猎奇、擦边等高风险内容，
// 并在画像打标、Grok 引用评价生成、自动关注与发布前提供本地安全校验。

export const RISK_DEFINITIONS = {
  'risk:politics': {
    namespace: 'risk',
    key: 'politics',
    label: '🏛️ 涉政',
    colorClass: 'tag-risk-politics',
    desc: '涉及敏感政治体制、政治运动、高层政争、意识形态激烈攻防等内容',
    severity: 'high'
  },
  'risk:military': {
    namespace: 'risk',
    key: 'military',
    label: '⚔️ 涉军',
    colorClass: 'tag-risk-military',
    desc: '涉及军事战乱、武装冲突、导弹轰炸、军演对抗、武器军火等内容',
    severity: 'high'
  },
  'risk:armed_group': {
    namespace: 'risk',
    key: 'armed_group',
    label: '🪖 武装组织',
    colorClass: 'tag-risk-armed-group',
    desc: '涉及胡塞武装等武装组织及其冲突、宣传或动员内容；不等同于对个人信仰或身份的判断',
    severity: 'high'
  },
  'risk:terrorism': {
    namespace: 'risk',
    key: 'terrorism',
    label: '🚫 恐怖极端',
    colorClass: 'tag-risk-terrorism',
    desc: '涉及恐怖组织、恐怖主义宣传或极端主义动员内容',
    severity: 'critical'
  },
  'risk:religion': {
    namespace: 'risk',
    key: 'religion',
    label: '🕊️ 涉宗教',
    colorClass: 'tag-risk-religion',
    desc: '涉及宗教极端主义、邪教狂热、宗教圣战、教派激烈冲突等内容',
    severity: 'high'
  },
  'risk:violence': {
    namespace: 'risk',
    key: 'violence',
    label: '🚫 暴力',
    colorClass: 'tag-risk-violence',
    desc: '涉及恐怖袭击、血腥虐杀、人体伤害、自残自杀、恶性行凶等极端暴力',
    severity: 'critical'
  },
  'risk:pornography': {
    namespace: 'risk',
    key: 'pornography',
    label: '🔞 色情',
    colorClass: 'tag-risk-porn',
    desc: '涉及成人AV、性交、裸露生殖器、OnlyFans买卖等明确色情淫秽内容',
    severity: 'critical'
  },
  'risk:suggestive': {
    namespace: 'risk',
    key: 'suggestive',
    label: '👙 擦边',
    colorClass: 'tag-risk-suggestive',
    desc: '涉及成人低俗擦边、大尺度诱导、福利姬、约炮开房、情色私房引流',
    severity: 'medium'
  },
  'risk:sensational': {
    namespace: 'risk',
    key: 'sensational',
    label: '👁️ 猎奇',
    colorClass: 'tag-risk-sensational',
    desc: '涉及严重人体畸形、重口残害、变态受虐、惊悚恶心等违背公序良俗的猎奇内容',
    severity: 'medium'
  }
};

const RISK_RULES = [
  {
    category: 'armed_group',
    tagId: 'risk:armed_group',
    label: '武装组织',
    severity: 'high',
    patterns: [
      /(?:胡塞武装|胡塞组织|胡塞叛军|胡塞运动|安萨尔真主|安萨尔安拉|哈马斯|真主党|塔利班|基地组织|伊斯兰国(?:组织)?(?!家)|达伊沙)/i,
      /\b(?:houthis?|houthi\s+(?:movement|fighters?)|ansar\s*(?:allah|ullah)|hamas|hezbollah|taliban|al[\s-]?qa(?:e|i)da|isis|isil|da['’]?esh)\b/i
    ]
  },
  {
    category: 'terrorism',
    tagId: 'risk:terrorism',
    label: '恐怖极端',
    severity: 'critical',
    patterns: [
      /(?:恐怖组织|恐怖分子|恐怖主义|恐怖袭击|恐袭|极端组织|极端主义宣传|圣战动员)/i,
      /\b(?:terrorists?|terrorism|terror\s+(?:attacks?|cells?)|violent\s+extremis(?:m|ts?)|jihadists?)\b/i
    ]
  },
  {
    category: 'violence',
    tagId: 'risk:violence',
    label: '暴力',
    severity: 'critical',
    patterns: [
      /(?:恐怖袭击|恐袭|爆炸|自杀式|斩首|割喉|屠杀|灭门|肢解|分尸|碎尸|血腥|虐杀|虐待动物|活埋)/i,
      /(?:持枪扫射|持刀行凶|开枪射杀|以暴制暴|枪击案|谋杀|投毒|毒杀|暴徒|暴动煽动)/i,
      /(?:自残|自杀现场|跳楼自尽|割腕|服毒|上吊|血肉模糊|尸横遍野|脑浆|内脏外露)/i,
      /(?:追杀令|点名追杀|死亡名单|悬赏(?:追杀|杀害|伤害)|(?:点名|公布(?:姓名|住址|地址))[^。！？\n]{0,40}(?:追杀|杀害|处决|围攻))/i,
      /\b(?:terror(?:ism|ist(?:s)?)?|beheading|beheaded|massacres?|bloodbath|decapitat(?:ed|ion|ing)|genocides?|dismember(?:ed|ment)?)\b/i,
      /\b(?:suicide|kill\s+yourself|mass\s+shootings?|homicides?|tortures?|extremists?|militants?|hostages?|kill\s+list|death\s+list|death\s+threats?|hunt\s+down\s+(?:nonbelievers?|infidels?|people|users|them|him|her))\b/i
    ]
  },
  {
    category: 'pornography',
    tagId: 'risk:pornography',
    label: '色情',
    severity: 'critical',
    patterns: [
      /(?:onlyfans|fansly|pornhub|xvideos|xnxx|xhamster|javlibrary|avgle|missav)/i,
      /(?:成人片|三级片|无码|有码|性爱视频|做爱视频|性交|打炮|插入|口交|深喉|颜射|潮吹|乱伦|迷奸|强奸)/i,
      /(?:幼女|幼交|幼齿|恋童|萝莉控成人|群交|换妻|性奴|肉便器|做爱高清)/i,
      /(?:露点|全裸无遮|生殖器|阴茎|阴道|自慰喷水|手淫直播|裸聊平台|成人直播间)/i,
      /\b(?:porn|porno|pornography|hentai|nsfw\s*explicit|nude\s*leaks|hardcore\s*sex|gangbang|creampie)\b/i
    ]
  },
  {
    category: 'politics',
    tagId: 'risk:politics',
    label: '涉政',
    severity: 'high',
    patterns: [
      /(?:中共|共产党|国民党|民进党|党魁|政治局|中南海|维稳|翻墙抗议|暴政|下台|独裁|专制)/i,
      /(?:六四|八九民运|天安门事件|法轮功|李洪志|大纪元|新唐人|退党|反共)/i,
      /(?:台独|藏独|疆独|港独|两岸开战|政治庇护|政治犯|推翻政权|颜色革命|白纸运动)/i,
      /(?:意识形态斗争|政治黑幕|打倒政府|上访维权遭镇压|党派夺权|政变)/i,
      /(?:失业|无业|人口|人民|社会|国家|政府|体制)[\s\S]{0,100}(?:如何反抗|怎么反抗|集体反抗|起来反抗)/i,
      /\b(?:ccp\s+regime|dictatorship|overthrow\s+government|political\s+dissidents?|tiananmen|falun\s*gong)\b/i,
      /\b(?:failed\s+state|coup\s*d['’]?etat|authoritarian|regime\s+change|political\s+oppression)\b/i
    ]
  },
  {
    category: 'military',
    tagId: 'risk:military',
    label: '涉军',
    severity: 'high',
    patterns: [
      /(?:俄乌冲突|俄乌战争|巴以冲突|以巴战争|台海战事|武装冲突|战火蔓延|前线战报)/i,
      /(?:导弹袭击|空袭轰炸|火炮覆盖|军演封锁|实弹演习|围台军演|航母战斗群|战机拦截)/i,
      /(?:核武器|核弹头|核威慑|生化武器|战术核武|军火库爆炸|防空警报|军事占领)/i,
      /(?:阵亡士兵|乌军战损|俄军阵亡|俘虏战俘|征兵动员令|特种部队突袭)/i,
      /\b(?:russia\s*ukraine\s*war|israel\s*hamas|military\s*strikes?|air\s*strikes?|airstrikes?|missile\s*attacks?|nuclear\s*warheads?)\b/i,
      /\b(?:armed\s*forces\s*clash|combat\s*casualties|artillery\s*shellings?|insurgents?|captured\s*enclaves?)\b/i
    ]
  },
  {
    category: 'religion',
    tagId: 'risk:religion',
    label: '涉宗教',
    severity: 'high',
    patterns: [
      /(?:邪教组织|全能神|极端宗教|圣战呼吁|宗教极端分子|圣战组织|异端邪说)/i,
      /(?:宗教迫害|宗教仇恨|亵渎圣物|宗教屠杀|宗教裁判|洗脑灵修|教主附体)/i,
      /\b(?:jihad(?:ists?|ism)?|religious\s*extremis(?:m|t(?:s)?)|religious\s*cults?|sectarian\s*violence)\b/i
    ]
  },
  {
    category: 'suggestive',
    tagId: 'risk:suggestive',
    label: '擦边',
    severity: 'medium',
    patterns: [
      /(?:福利姬|推特福利|推特原味|原味内衣|同城约炮|同城空降|上门按摩服务|高端外围)/i,
      /(?:私房照大尺度|私房写真|性感大尺度|真空上阵|大尺度无圣光|黑丝诱惑|白丝情趣)/i,
      /(?:付费进群看片|加v看私密|加微信领福利|微密圈破解|微密圈福利|门票群|吃瓜视频资源)/i,
      /(?:买春|嫖娼|援交女|包养兼职|陪睡|开房约啪|约跑打炮)/i,
      /\b(?:nsfw|sexy\s*model|erotic|escort\s*service|sugar\s*baby|hookup\s*app)\b/i
    ]
  },
  {
    category: 'sensational',
    tagId: 'risk:sensational',
    label: '猎奇',
    severity: 'medium',
    patterns: [
      /(?:人体畸形|食人族|吃人肉|重口味排泄|粪便恶心|解剖尸体|异物植入极端)/i,
      /(?:变态受虐|极端自虐|生吃活体|蛆虫伤口|怪异残肢|暗网重口)/i,
      /\b(?:cannibalism|gore\s*video|snuff|shock\s*site|gross\s*fetish)\b/i
    ]
  }
];

/**
 * 本地内容风险检测引擎
 * @param {string} text 待检测的文本内容（推文正文、个人简介等）
 * @param {object} options 配置选项
 * @returns {object} 检测结果
 */
export function detectContentRisks(text = '', options = {}) {
  const content = String(text || '').trim();
  if (!content) {
    return {
      hasRisk: false,
      isSevere: false,
      categories: [],
      tagIds: [],
      labels: [],
      evidence: [],
      reasons: []
    };
  }

  const matches = [];
  const matchedCategories = new Set();
  const matchedTagIds = new Set();
  const matchedLabels = new Set();
  let hasCritical = false;
  let hasHigh = false;

  for (const rule of RISK_RULES) {
    if (options.excludeCategories?.includes(rule.category)) continue;

    for (const pattern of rule.patterns) {
      const match = pattern.exec(content);
      if (match) {
        matchedCategories.add(rule.category);
        matchedTagIds.add(rule.tagId);
        matchedLabels.add(rule.label);
        if (rule.severity === 'critical') hasCritical = true;
        if (rule.severity === 'high') hasHigh = true;

        matches.push({
          category: rule.category,
          tagId: rule.tagId,
          label: rule.label,
          severity: rule.severity,
          matchedWord: match[0],
          index: match.index
        });
        break; // 该规则命中一次即可
      }
    }
  }

  const hasRisk = matches.length > 0;
  const isSevere = hasCritical || hasHigh;
  const categories = Array.from(matchedCategories);
  const tagIds = Array.from(matchedTagIds);
  const labels = Array.from(matchedLabels);
  const reasons = matches.map(m => `命中${m.label}信号（“${m.matchedWord}”）`);

  return {
    hasRisk,
    isSevere,
    categories,
    tagIds,
    labels,
    evidence: matches,
    reasons
  };
}

// 用户的互动范围偏好，与高危内容或对作者身份的判断分开处理。
const RELIGIOUS_INTERACTION_TERMS = /(?:宗教|教派|信教|不信教|传教|改宗|皈依|穆斯林|伊斯兰|回教|清真|古兰经|可兰经|斋月|开斋节|古尔邦节|逊尼派?|什叶派?|苏菲派?|阿赫迈底亚|伊巴德派?|阿拉维派?|德鲁兹派?|耶兹迪|雅兹迪|巴哈伊|拜火教|祆教|琐罗亚斯德教|基督教|基督徒|天主教|天主教徒|佛教|佛教徒|道教|犹太教|印度教|圣经|佛经|清真寺|教堂|礼拜堂|做礼拜|弥撒|哈利路亚|\b(?:muslim\w*|islam\w*|sunni\w*|shi(?:a|ite)\w*|sufi\w*|mosque\w*|ramadan|qur[ao]n|zoroastrian\w*|bah[aá][’']?i|yazidi\w*|druze|alawite\w*|alevi\w*|ismaili\w*|christian\w*|catholic\w*|buddhis\w*|hindu\w*|judais\w*|religio(?:n|us)\w*|church|scripture|bible|eid\s*(?:al[- ](?:fitr|adha)|mubarak))\b|مسلم|الإسلام|اسلام|مسجد|رمضان|قرآن)/iu;

export function interactionSkipReason(profile = {}) {
  if (!profile || typeof profile !== 'object') return '';
  const recent = [
    ...(Array.isArray(profile.posts) ? profile.posts : []),
    ...(Array.isArray(profile.recentPosts) ? profile.recentPosts : [])
  ].slice(0, 10);
  const visibleText = [
    String(profile.handle || '').replace(/[_\-.]/g, ' '),
    profile.name, profile.bio, profile.description,
    ...(Array.isArray(profile.tags) ? profile.tags.map(tag => typeof tag === 'string' ? tag : tag?.label || '') : []),
    ...recent.map(post => typeof post === 'string' ? post : post?.text || '')
  ].filter(Boolean).join('\n');
  return RELIGIOUS_INTERACTION_TERMS.test(visibleText)
    ? '账号资料或近期帖子涉及宗教相关内容，按互动偏好跳过关注与引用评价'
    : '';
}

/**
 * 专门校验单条帖子是否安全可用于 Grok 引用评价与自动互动
 * @param {object|string} post 帖子对象或正文字符串
 * @param {object} user 作者信息（可选）
 * @returns {{ safe: boolean, reason?: string, categories?: string[], labels?: string[] }}
 */
export function isPostSafeForComment(post, user = {}) {
  const postText = typeof post === 'string' ? post : String(post?.text || '').trim();
  const userText = `${String(user?.handle || '').replace(/[_-]/g, ' ')} ${user?.name || ''} ${user?.bio || user?.description || ''}`.trim();

  // 若提供了帖子正文，对正文进行风险检测
  if (postText) {
    const postRisk = detectContentRisks(postText);
    if (postRisk.hasRisk) {
      return {
        safe: false,
        reason: `原帖涉及${postRisk.labels.join('、')}等高风险主题，已触发安全门禁拦截`,
        categories: postRisk.categories,
        labels: postRisk.labels,
        evidence: postRisk.evidence
      };
    }
  }

  // 若提供了作者信息，对作者上下文做重度风险（色情/暴力/涉政/涉军/涉宗教）防御
  if (userText) {
    const userRisk = detectContentRisks(userText);
    if (userRisk.isSevere) {
      return {
        safe: false,
        reason: `作者个人信息含${userRisk.labels.join('、')}等高危信号，已跳过互动`,
        categories: userRisk.categories,
        labels: userRisk.labels,
        evidence: userRisk.evidence
      };
    }
  }

  return { safe: true };
}

/**
 * 构建用于向 Grok 提交账号主页与前 10 条推文的深度语义安全打标 Prompt
 */
export function buildGrokProfileAssessmentPrompt({ handle, name, bio, posts = [] } = {}) {
  const cleanHandle = String(handle || '').replace(/^@/, '');
  const postList = Array.isArray(posts) ? posts.slice(0, 10) : [];
  const postsText = postList.map((p, idx) => {
    const raw = typeof p === 'string' ? p : (p?.text || '');
    const clean = raw.replace(/\s+/g, ' ').trim();
    return `${idx + 1}. ${clean.slice(0, 250)}`;
  }).filter(Boolean).join('\n');

  return `你是一个专业严谨的社交媒体内容安全与多维画像打标审核员。请综合分析以下 Twitter/X 账号的主页信息与近期前 10 条推文，完成深度语义画像与安全风险研判。

【待分析账号】
- 用户名：@${cleanHandle}
- 昵称：${name || '未知'}
- 个人简介：${bio || '无'}

【近期推文列表（至多10条）】
${postsText || '（暂无推文）'}

【安全审核红线与判定准则（精准识别对抗风险，严格豁免正常社会生活观察）】
审核核心：识别具有明确政治对抗、违法动员或人身安全风险的高危内容；严禁将普通生活吐槽或社会观察扣上“政治敏感”帽子。

一、高风险类别（safe=false，必须标记并拦截）：
1. politics (涉政高危)：明确号召或鼓动针对政府的非法对抗行动、煽动推翻政权、国家分裂、敏感历史极端事件恶毒煽动、具有政治动员串联意图的内容。
2. military (涉军高危)：交火战况直播、空袭轰炸战损宣扬、极端武装叛乱、军事侵略煽动、恐怖组织据点活动等。
3. armed_group (武装组织高危)：胡塞武装（Houthis/Ansar Allah）等武装组织相关的冲突、宣传或动员；这是内容主题标签，不是对作者宗教身份的判断。
4. terrorism (恐怖极端高危)：恐怖组织、恐怖分子、恐怖主义宣传与极端主义动员。不要仅凭某人的宗教身份推断其属于恐怖组织。
5. religion (涉宗教高危)：邪教组织狂热、宗教圣战仇恨、教派极端暴力冲突。
6. violence (暴力高危)：绑架人质、恶性虐杀、残暴血腥、自残自尽。
7. pornography (色情高危)：成人AV、露点性交、性交易、OnlyFans商业色情。
8. suggestive (擦边高危)：福利姬引流、同城约炮空降、私房情色大尺度写真。
9. sensational (猎奇高危)：人体畸形残害、变态自虐、排泄恶心、暗网恐怖重口。

二、明确豁免清单（safe=true，严禁误打涉政标签）：
- 穆斯林、伊斯兰教徒或其他宗教身份本身，以及普通祈祷、节日和家庭生活内容；不得因宗教身份或普通宗教表达单独打危险标签。
- 个人生活与社会现象观察：就业求职压力、失业在家吃挂面、年轻人躺平摆烂自嘲、不婚不育自娱自乐、房贷车贷吐槽、消费降级、考公考研考编心得；
- 泛社会经济与民生讨论：宏观经济数据公开讨论、行业内卷现状描述、各省物价对比、城市生活自嘲；
- 判定原则（“描述 vs 倡导”）：
  * 正例放行（safe=true）：描述个人生活状态（如“今年失业了天天吃挂面”、“不结婚不买房一身轻”、“躺平爽了金不换”），无对抗意图，归入正常赛道（niche:life 等）；
  * 反例拦截（safe=false）：在社会、人口、失业语境下讨论“如何反抗/怎么反抗”等对抗性行动，论证“应该怎样对抗/推翻体制”、号召串联线下活动、针对具体部门发起围攻动员。

【输出格式约束】
必须仅输出以下 JSON 格式（不要添加任何额外开场白或解释）：
\`\`\`json
{
  "safe": true,
  "riskCategories": [],
  "riskTags": [],
  "nicheTags": ["niche:ai_tech"],
  "reasons": [],
  "summary": "15字以内账号特点总结"
}
\`\`\`
注意：
- 若存在上述任一风险主题，"safe" 必须为 false，"riskCategories" 填入对应英文字符串（如 ["politics", "violence"]），"riskTags" 填入对应标签ID（如 ["risk:politics", "risk:violence"]），"reasons" 简述命中原因与推文片段；
- 若无上述敏感风险，"safe" 为 true，"riskCategories" 与 "riskTags" 为空数组 []；
- "nicheTags" 可包含识别出的赛道：niche:ai_tech, niche:web3, niche:cross_border, niche:design, niche:crypto, niche:life 等。`;
}

/**
 * 解析 Grok 返回的画像与安全打标结果
 * @param {string} rawText Grok 返回的完整文本
 * @returns {object} 解析后的结构化对象
 */
export function parseGrokProfileAssessment(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { evaluated: false, safe: true, categories: [], tags: [], riskTags: [], labels: [], reasons: [], summary: '' };
  }

  let jsonStr = '';
  const codeBlockMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  } else {
    const braceMatch = rawText.match(/\{[\s\S]*\}/);
    if (braceMatch) jsonStr = braceMatch[0].trim();
  }

  if (jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      const riskCategories = Array.isArray(data.riskCategories)
        ? data.riskCategories.map(s => String(s).toLowerCase().trim()).filter(Boolean)
        : [];
      const riskTags = Array.isArray(data.riskTags)
        ? data.riskTags.map(s => String(s).trim()).filter(Boolean)
        : [];
      for (const cat of riskCategories) {
        const tag = `risk:${cat}`;
        if (!riskTags.includes(tag)) riskTags.push(tag);
      }
      for (const tag of riskTags) {
        const cat = tag.replace(/^risk:/, '');
        if (!riskCategories.includes(cat)) riskCategories.push(cat);
      }
      const safe = data.safe === false ? false : (riskCategories.length === 0 && riskTags.length === 0);
      const nicheTags = Array.isArray(data.nicheTags)
        ? data.nicheTags.map(s => String(s).trim()).filter(Boolean)
        : [];
      const allTags = [...new Set([...riskTags, ...nicheTags])];
      const reasons = Array.isArray(data.reasons)
        ? data.reasons.map(s => String(s).trim()).filter(Boolean)
        : (data.reasons ? [String(data.reasons)] : []);
      const labels = riskCategories.map(cat => RISK_DEFINITIONS[`risk:${cat}`]?.label || cat);

      return {
        evaluated: true,
        safe,
        categories: riskCategories,
        tags: allTags,
        riskTags,
        labels,
        reasons,
        summary: String(data.summary || '').slice(0, 50)
      };
    } catch {
      // 容错降级
    }
  }

  // 降级模式：从自然语言或部分文本提取风险
  const localRisks = detectContentRisks(rawText);
  const mentionsUnsafe = /不安全|高风险|违规|敏感|拒绝生成|涉政|涉军|暴力|色情|擦边/i.test(rawText);
  const isSafe = !localRisks.hasRisk && !mentionsUnsafe && /"safe"\s*:\s*true/i.test(rawText);

  return {
    evaluated: true,
    safe: isSafe,
    categories: localRisks.categories,
    tags: localRisks.tagIds,
    riskTags: localRisks.tagIds,
    labels: localRisks.labels,
    reasons: localRisks.reasons.length ? localRisks.reasons : (mentionsUnsafe ? ['Grok回复提示包含安全风险'] : []),
    summary: rawText.slice(0, 30)
  };
}

/**
 * 执行 Profile 的 Grok 深度语义风险打标（带持久化防重标识）
 * 铁律：
 * 1. 若已有 grokAssessedAt 且在有效 TTL 内，直接返回缓存评估，绝不重复调用 Grok API 浪费额度。
 * 2. 返回包含 evaluated、safe、categories、tags、labels、reasons、at、cached 等字段。
 */
export async function evaluateProfileGrokRisk(profile = {}, { runner, sleep, cacheTtlMs = 7 * 24 * 3600000 } = {}) {
  const assessedAt = Number(profile.grokAssessedAt || profile.grokRiskAssessment?.at || 0);
  const existingAssessment = profile.grokRiskAssessment;

  // 1. 检查持久化防重标识：若已有历史研判且在有效 TTL 内，直接复用，不重复消耗额度
  if (assessedAt > 0 && existingAssessment && (Date.now() - assessedAt < cacheTtlMs)) {
    return {
      ...existingAssessment,
      cached: true,
      evaluated: true
    };
  }

  if (typeof runner !== 'function') {
    return {
      evaluated: false,
      safe: true,
      cached: false,
      reason: '未提供 Grok 评测器 runner'
    };
  }

  const prompt = buildGrokProfileAssessmentPrompt(profile);
  const res = await runner(prompt);
  if (res?.quotaExhausted) return {evaluated:false, safe:false, cached:false,
    quotaExhausted:true, code:res.code, retryAt:res.retryAt, reason:res.reason};
  if (!res || !res.ok || !res.text) {
    return {
      evaluated: false,
      safe: true,
      cached: false,
      reason: res?.reason || 'Grok 请求未返回有效内容'
    };
  }

  const assessment = parseGrokProfileAssessment(res.text);
  const now = Date.now();
  assessment.at = now;
  assessment.cached = false;
  assessment.channel = res.channel || '';
  return assessment;
}
