export function parseCount(value) {
  if (!value) return null;
  const text = value.replace(/[\u200e\u200f\u202a-\u202e\u00a0\u202f]/g, '').trim();
  const match = text.match(/^(\d[\d, .]*)(万|萬|亿|億|[kmb])?/i);
  if (!match) return null;
  const number = Number(match[1].replace(/[,\s]/g, ''));
  const multiplier = {k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8}[match[2]?.toLowerCase()] || 1;
  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

export function formatPageSummary(page, totalPages, totalCount) {
  if (!totalCount) return '0 / 0 · 0';
  return `${page} / ${totalPages} · ${totalCount}`;
}

export function normalizeHandle(input) {
  const value = input.trim().replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, '').replace(/^@/, '').replace(/\/$/, '');
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(value)) throw new Error('请输入有效的 X 用户名，例如 @username 或完整个人主页链接。');
  return value;
}

const MUTUAL_KEYWORD_PATTERNS = [
  // 中文互粉/互动高频词
  { pattern: /串门/i, label: '串门' },
  { pattern: /出摊|摆摊/i, label: '出摊' },
  { pattern: /互关|互關/i, label: '互关' },
  { pattern: /互粉/i, label: '互粉' },
  { pattern: /回关|回關/i, label: '回关' },
  { pattern: /必回|关必回|關必回|有粉必回|有赞必回|秒回/i, label: '必回' },
  { pattern: /多评|多评论/i, label: '多评' },
  { pattern: /多互动|常互动|互动起来/i, label: '多互动' },
  { pattern: /蓝\s*v|蓝标|蓝勾/i, label: '蓝V' },
  { pattern: /加好友|交朋友|认识新朋友|扩关|扩列/i, label: '加好友' },
  { pattern: /多发|日更/i, label: '多发' },
  { pattern: /互赞|互讚|互浇|互暖|互推|互助|抱团|一起涨粉/i, label: '互助互动' },
  // 英文互粉/互动高频词
  { pattern: /follow\s*back|followback|fo\s*back/i, label: 'follow back' },
  { pattern: /follow\s*(?:for|4)\s*follow|\bf4f\b|\bifb\b|\bl4l\b/i, label: 'F4F' },
  { pattern: /\bmutuals\b|be\s+mutuals|new\s+mutuals|active\s+mutuals/i, label: 'mutuals' },
  { pattern: /let'?s\s+connect|connect\s+with|grow\s+together|support\s+each\s+other/i, label: "let's connect" },
  { pattern: /drop\s+your\s+(?:handle|@|profile|link)|stay\s+active|active\s+followers/i, label: 'engage' },
  { pattern: /blue\s+check|verified\s+followers|blue\s+verified|road\s+to\s+\d+k/i, label: 'blue verified' },
  { pattern: /add\s+friends|make\s+friends|new\s+friends|visit\s+my\s+profile/i, label: 'make friends' }
];

export function matchMutualKeywords(profile = {}) {
  const bioText = `${profile.name || ''} ${profile.bio || ''}`;
  const posts = Array.isArray(profile.posts) ? profile.posts.slice(0, 10) : [];
  const postsText = posts.map(post => (typeof post === 'string' ? post : (post?.text || ''))).join(' ');
  const bioHits = [];
  const postHits = [];
  const allHits = [];
  for (const { pattern, label } of MUTUAL_KEYWORD_PATTERNS) {
    const inBio = pattern.test(bioText);
    const inPosts = pattern.test(postsText);
    if (inBio) bioHits.push(label);
    if (inPosts) postHits.push(label);
    if (inBio || inPosts) allHits.push(label);
  }
  return {
    matched: allHits.length > 0,
    matchedInPosts: postHits.length > 0,
    matchedInBio: bioHits.length > 0,
    postHits: [...new Set(postHits)],
    bioHits: [...new Set(bioHits)],
    hits: [...new Set(allHits)],
    postCount: posts.length
  };
}

export function evaluateMutualProfile(profile = {}) {
  const followers = typeof profile.followers === 'number' && Number.isFinite(profile.followers)
    ? profile.followers
    : parseCount(String(profile.followersText ?? ''));
  const following = typeof profile.following === 'number' && Number.isFinite(profile.following)
    ? profile.following
    : parseCount(String(profile.followingText ?? ''));
  const kw = matchMutualKeywords(profile);
  const promise = kw.matched;
  const countsKnown = followers !== null && following !== null && followers > 0;
  // 关注量比粉丝量少在 1/5 以内（即 following >= followers * 4/5，如关注 4000 / 粉丝 5000）视为推荐比例；低于 4/5 视为不推荐
  const hasBaitRisk = countsKnown && following < followers * 0.8;
  const noBaitRisk = countsKnown && following >= followers * 0.8;
  const risk = riskAssess(profile);
  let intentSource = 'local';
  if (kw.matchedInPosts) intentSource = 'posts';
  else if (typeof profile.grokMutualIntent === 'boolean') intentSource = 'grok';
  const rawIntent = kw.matched || profile.grokMutualIntent === true;
  const isDanger = risk.level === 'danger';
  const isNotRecommended = hasBaitRisk || isDanger;
  const isRecommended = countsKnown && noBaitRisk && !isDanger;

  let baitRiskLabel = '待评估';
  let baitRiskDetail = '尚未读取完整粉丝与关注数量，刷新资料后可生成推荐评估';
  if (isDanger) {
    baitRiskLabel = '不推荐';
    baitRiskDetail = `不推荐原因：命中高风险内容信号（${risk.hits.join('、')}）`;
  } else if (countsKnown) {
    if (hasBaitRisk) {
      baitRiskLabel = '不推荐';
      baitRiskDetail = `不推荐原因：关注(${following})少于粉丝(${followers})的 4/5（差额超 1/5），回关比例偏低`;
    } else {
      baitRiskLabel = '推荐';
      const reasons = [`关注(${following}) / 粉丝(${followers}) 差额在 1/5 以内（>=80%），回关比例健康`];
      if (kw.postHits.length) reasons.push(`首页前 ${kw.postCount} 条帖子命中互粉词（${kw.postHits.join('、')}）`);
      else if (kw.bioHits.length) reasons.push(`简介/名称命中互粉词（${kw.bioHits.join('、')}）`);
      if (profile.grokMutualIntent === true) reasons.push(`Grok 分析有互粉倾向${profile.grokReason ? `（${profile.grokReason}）` : ''}`);
      baitRiskDetail = `推荐原因：${reasons.join('；')}`;
    }
  }

  const hasMutualIntent = Boolean(rawIntent) && !isNotRecommended;
  const tag = hasMutualIntent ? '互粉' : '无';

  let intentTooltip;
  if (hasMutualIntent) {
    const reasons = [];
    if (kw.postHits.length) reasons.push(`首页前 ${kw.postCount} 条帖子命中互粉词（${kw.postHits.join('、')}）`);
    if (kw.bioHits.length) reasons.push(`简介/名称命中互粉词（${kw.bioHits.join('、')}）`);
    if (intentSource === 'grok' || profile.grokMutualIntent === true) {
      reasons.push(`Grok 分析有互粉倾向${profile.grokReason ? `（${profile.grokReason}）` : ''}`);
    }
    if (countsKnown && noBaitRisk) {
      reasons.push(`关注(${following}) / 粉丝(${followers}) 差额在 1/5 以内（>=80%），回关比例健康`);
    }
    intentTooltip = `推荐原因：${reasons.join('；') || '具备互粉意向且关注比例健康'}`;
  } else {
    const reasons = [];
    if (isDanger) {
      reasons.push(`命中高风险内容信号（${risk.hits.join('、')}）`);
    }
    if (hasBaitRisk) {
      reasons.push(`关注(${following})少于粉丝(${followers})的 4/5（差额超 1/5），回关比例偏低`);
    }
    if (intentSource === 'grok' && profile.grokMutualIntent === false) {
      reasons.push(`Grok 分析无明显互粉倾向${profile.grokReason ? `（${profile.grokReason}）` : ''}`);
    } else if (!rawIntent) {
      reasons.push(kw.postCount > 0 ? `已扫描简介与前 ${kw.postCount} 条帖子，未命中互粉关键词` : '简介未命中互粉关键词（可刷新资料扫描首页前 5-10 条帖子确认）');
    }
    intentTooltip = `不推荐原因：${reasons.join('；')}`;
  }

  return {
    followers,
    following,
    promise,
    keywordHits: kw.hits,
    postKeywordHits: kw.postHits,
    bioKeywordHits: kw.bioHits,
    postCount: kw.postCount,
    countsKnown,
    hasBaitRisk,
    noBaitRisk,
    isRecommended,
    isNotRecommended,
    recommendLabel: baitRiskLabel,
    recommendReason: baitRiskDetail,
    baitRiskLabel,
    baitRiskDetail,
    intentTooltip,
    hasMutualIntent,
    intentSource,
    tag,
    risk
  };
}

export function parseGrokMutualAnalysis(text = '', handles = []) {
  const results = {};
  if (!text || typeof text !== 'string') return results;
  const structuredRe = /@([A-Za-z0-9_]{1,15})\s*\|\s*互粉意向\s*[:：]\s*([^|\n\]]+?)(?:\s*\|\s*互粉标签\s*[:：]\s*([^|\n\]]+?))?(?:\s*\|\s*(?:推荐评估|骗关风险)\s*[:：]\s*([^|\n\]]+?))?(?:\s*\|\s*理由\s*[:：]\s*([^\n\]]+))?(?=[\]\n]|$)/gi;
  let match;
  while ((match = structuredRe.exec(text)) !== null) {
    const handle = match[1];
    const key = handle.toLowerCase();
    const intentRaw = (match[2] || '').trim();
    const tagRaw = (match[3] || '').trim();
    const baitRaw = (match[4] || '').trim();
    const reasonRaw = (match[5] || '').trim();
    const isPositive = /^(有|是|愿意|高|互粉|推荐|true|yes)/i.test(intentRaw) || tagRaw === '互粉';
    results[key] = {
      handle,
      grokMutualIntent: isPositive && !/^(无|否|不愿意|低|不推荐|false|no)/i.test(intentRaw),
      mutualTag: (isPositive && !/^(无|否|不愿意|低|不推荐|false|no)/i.test(intentRaw)) ? '互粉' : '无',
      grokBaitRisk: baitRaw || '',
      grokReason: reasonRaw || ''
    };
  }
  for (const rawHandle of handles) {
    const clean = String(rawHandle || '').replace(/^@/, '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (results[key]) continue;
    const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockRe = new RegExp(`@${escaped}\\b([\\s\\S]{0,600}?)(?=(?:\\n\\s*(?:---+|账号\\s*\\d+|@))|$)`, 'i');
    const blockMatch = text.match(blockRe);
    if (!blockMatch) continue;
    const block = blockMatch[1];
    const tagMatch = block.match(/互粉标签\s*[:：]\s*(互粉|无)/i);
    const intentMatch = block.match(/(?:互粉意向|互粉倾向|是否愿意互粉)\s*[:：]\s*(有互粉意向|无互粉意向|有|无|是|否|愿意|不愿意)/i);
    if (tagMatch || intentMatch) {
      const val = (tagMatch?.[1] || intentMatch?.[1] || '').trim();
      const positive = /^(互粉|有互粉意向|有|是|愿意)$/i.test(val);
      const reasonMatch = block.match(/(?:理由|结论|推荐原因|不推荐原因)\s*[:：]\s*([^\n]+)/i);
      results[key] = {
        handle: clean,
        grokMutualIntent: positive,
        mutualTag: positive ? '互粉' : '无',
        grokBaitRisk: '',
        grokReason: reasonMatch ? reasonMatch[1].trim() : ''
      };
    }
  }
  return results;
}

export function assess(profile, options) {
  const evalResult = evaluateMutualProfile(profile);
  const promise = evalResult.promise;
  const ratio = profile.followers !== null && profile.following > 0 ? profile.followers / profile.following : null;
  // 低比例（关注多、粉丝少）是正常的主动关注信号；高比例才是互关承诺与行为不一致的信号。
  const balanced = ratio !== null && ratio <= options.maxRatio && !evalResult.hasBaitRisk;
  const reverseRatioRisk = (ratio !== null && ratio > options.maxRatio) || evalResult.hasBaitRisk;
  const enough = profile.followers !== null && profile.following !== null && Math.min(profile.followers, profile.following) >= options.minCount;
  const readable = profile.status === 'ok';
  let verdict = '未命中';
  if (!readable || ratio === null) verdict = '需复核';
  else if (promise && reverseRatioRisk) verdict = '不推荐';
  else if (balanced && enough && (!options.requirePromise || promise)) verdict = '候选';
  const risk = evalResult.risk;
  if (risk.level === 'danger') verdict = '危险';
  return {
    ...profile,
    promise,
    balanced,
    reverseRatioRisk,
    hasBaitRisk: evalResult.hasBaitRisk,
    baitRiskLabel: evalResult.baitRiskLabel,
    baitRiskDetail: evalResult.baitRiskDetail,
    mutualTag: evalResult.tag,
    ratio,
    risk,
    verdict
  };
}

export function riskAssess(profile) {
  const text = `${profile.name || ''} ${profile.bio || ''} ${(profile.posts || []).map(post => post.text || '').join(' ')}`.toLowerCase();
  const hits = [];
  const rules = [
    [/onlyfans|fansly|pornhub|xvideos|xnxx|成人直播|成人视频|裸聊|约炮|援交|情色|色情|成人视频|私密视频|福利视频|写真|同城约|上门服务/i, '成人或擦边平台/服务'],
    [/18\s*\+|nsfw|n\s*s\s*f\s*w|sexy|性感|爆乳|巨乳|白丝|黑丝|内衣|裸|露点|私房照|尺度/i, '成人或擦边内容词'],
    [/t\.me\/|telegram|加微|微信|私聊看|付费解锁|订阅解锁|机场|低价代充|博彩|赌场|下注|返利/i, '导流、付费或高风险外链'],
  ];
  for (const [pattern, label] of rules) if (pattern.test(text)) hits.push(label);
  return {level:hits.length ? 'danger' : 'normal', hits:[...new Set(hits)]};
}

export function csv(rows) {
  const columns = ['handle', 'name', 'bio', 'followers', 'following', 'followersText', 'followingText', 'ratio', 'promise', 'mutualTag', 'baitRiskLabel', 'riskLevel', 'riskHits', 'verdict', 'status', 'url', 'checkedAt'];
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\ufeff' + [columns, ...rows.map(row => columns.map(key => key === 'riskLevel' ? row.risk?.level : key === 'riskHits' ? row.risk?.hits?.join('; ') : row[key]))].map(row => row.map(cell).join(',')).join('\r\n');
}

const win1252Map = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f
};

export function repairMojibake(str) {
  if (!str || typeof str !== 'string') return str;
  if (!/[ÂÃÄÅæåçèéêëìíîïðñòóôõöøùúûüýþÿâã]/i.test(str)) return str;
  try {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code < 256) bytes.push(code);
      else if (win1252Map[code]) bytes.push(win1252Map[code]);
      else return str;
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return decoded;
  } catch {
    return str;
  }
}

export function filterMutualTrackingUsers(users = [], keyword = '', profileCache = {}) {
  const q = String(keyword || '').trim().toLowerCase();
  if (!q) return [...users];
  const qNoAt = q.replace(/^@+/, '');
  return users.filter(user => {
    const key = String(user?.handle || '').toLowerCase();
    const cached = profileCache[key] || {};
    const merged = {
      ...user,
      ...cached,
      name: repairMojibake(cached.name || user.name || user.handle || ''),
      bio: repairMojibake(cached.bio || user.bio || ''),
      posts: Array.isArray(cached.posts) && cached.posts.length ? cached.posts : (user.posts || [])
    };
    const evalRes = evaluateMutualProfile(merged);
    const postTexts = (merged.posts || []).map(p => String(typeof p === 'string' ? p : (p?.text || ''))).join(' ');
    const fields = [
      merged.handle,
      `@${merged.handle}`,
      merged.name,
      merged.bio,
      postTexts,
      evalRes.tag,
      evalRes.recommendLabel,
      ...(evalRes.keywordHits || [])
    ];
    return fields.some(val => {
      const text = String(val || '').toLowerCase();
      return text.includes(q) || (qNoAt && text.includes(qNoAt));
    });
  });
}

export function selectValuableMutualTargets(users = [], config = {}, profileCache = {}, ownFollowingSet = new Set()) {
  const onlyIntent = typeof config.onlyIntent === 'boolean'
    ? config.onlyIntent
    : (config.onlyMutualIntent !== false);
  const minFollowers = Number.isFinite(Number(config.minFollowers)) ? Number(config.minFollowers) : 50;
  const batchLimit = Math.max(1, Math.min(20, Number(config.batchSize || config.batchLimit) || 10));
  const visitedList = config.visitedHandles || config.processedHandles || [];
  const processedSet = new Set(visitedList.map(h => String(h || '').toLowerCase()));
  const scored = [];

  for (const user of users || []) {
    const handle = String(user?.handle || '').trim();
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (processedSet.has(key) || ownFollowingSet.has(key)) continue;
    if (user.relationship?.following === true || user.state === 'following') continue;

    const cached = profileCache[key] || {};
    const merged = {
      ...user,
      ...cached,
      name: repairMojibake(cached.name || user.name || handle),
      bio: repairMojibake(cached.bio || user.bio || ''),
      followersText: cached.followersText || user.followersText || '',
      followingText: cached.followingText || user.followingText || '',
      posts: Array.isArray(cached.posts) && cached.posts.length ? cached.posts : (user.posts || []),
      grokMutualIntent: typeof cached.grokMutualIntent === 'boolean' ? cached.grokMutualIntent : user.grokMutualIntent,
      grokReason: cached.grokReason || user.grokReason || ''
    };
    const evalRes = evaluateMutualProfile(merged);
    if (evalRes.isNotRecommended) continue;
    if (evalRes.followers !== null && evalRes.followers < minFollowers) continue;

    const hasIntentOrRec = evalRes.tag === '互粉' || evalRes.recommendLabel === '推荐';
    const unscannedPotential = !evalRes.countsKnown && !(merged.posts?.length) && (evalRes.promise || user.relationship?.followedBy === true);
    if (onlyIntent && !hasIntentOrRec && !unscannedPotential) continue;

    let score = 0;
    if (evalRes.tag === '互粉') score += 100;
    if (evalRes.recommendLabel === '推荐') score += 50;
    if (user.relationship?.followedBy === true) score += 35;
    if (evalRes.postKeywordHits?.length) score += 25;
    if (evalRes.bioKeywordHits?.length) score += 15;
    scored.push({ user: merged, evalResult: evalRes, score });
  }

  scored.sort((a, b) => b.score - a.score || String(a.user.handle).localeCompare(String(b.user.handle)));
  return scored.slice(0, batchLimit).map(entry => entry.user);
}



export function normalizeUnreciprocatedConfig(cfg = {}) {
  const defaults = {
    enabled: false,
    every: 60,
    jitter: 10,
    overdueDays: 14,
    autoUnfollow: false,
    batchLimit: 10,
    unfollowDelay: 3,
    unfollowDelayJitter: 2,
    whitelist: '',
    lastRunAt: null,
    lastSummary: '尚未执行回关监测'
  };
  const res = { ...defaults, ...(cfg || {}) };
  res.every = Math.max(5, Math.min(1440, Number(res.every) || 60));
  res.jitter = Math.max(1, Math.min(60, Number(res.jitter) || 10));
  res.overdueDays = Math.max(1, Math.min(90, Number(res.overdueDays) || 14));
  res.autoUnfollow = Boolean(res.autoUnfollow);
  res.batchLimit = Math.max(1, Math.min(50, Number(res.batchLimit) || 10));
  res.unfollowDelay = Math.max(1, Math.min(30, Number(res.unfollowDelay) || 3));
  res.unfollowDelayJitter = Math.max(1, Math.min(15, Number(res.unfollowDelayJitter) || 0));
  res.whitelist = String(res.whitelist || '').trim();
  return res;
}
