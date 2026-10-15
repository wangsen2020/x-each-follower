export function parseCount(value) {
  if (!value) return null;
  const text = value.replace(/[\u200e\u200f\u202a-\u202e\u00a0\u202f]/g, '').trim();
  const match = text.match(/^(\d[\d, .]*)(万|萬|亿|億|[kmb])?/i);
  if (!match) return null;
  const number = Number(match[1].replace(/[,\s]/g, ''));
  const multiplier = {k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 萬: 1e4, 亿: 1e8, 億: 1e8}[match[2]?.toLowerCase()] || 1;
  return Number.isFinite(number) ? Math.round(number * multiplier) : null;
}

export function normalizeHandle(input) {
  const value = input.trim().replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, '').replace(/^@/, '').replace(/\/$/, '');
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(value)) throw new Error('请输入有效的 X 用户名，例如 @username 或完整个人主页链接。');
  return value;
}

export function assess(profile, options) {
  const promise = /互关|互關|回关|回關|关必回|關必回|fo\s*back|follow\s*back|follow\s*for\s*follow|\bf4f\b|\bifb\b/i.test(`${profile.name || ''} ${profile.bio || ''}`);
  const ratio = profile.followers !== null && profile.following > 0 ? profile.followers / profile.following : null;
  const balanced = ratio !== null && ratio >= options.minRatio && ratio <= options.maxRatio;
  const enough = profile.followers !== null && profile.following !== null && Math.min(profile.followers, profile.following) >= options.minCount;
  const readable = profile.status === 'ok';
  let verdict = '未命中';
  if (!readable || ratio === null) verdict = '需复核';
  else if (promise && !balanced) verdict = '承诺与比例不符';
  else if (balanced && enough && (!options.requirePromise || promise)) verdict = '候选';
  const risk = riskAssess(profile);
  if (risk.level === 'danger') verdict = '危险';
  return { ...profile, promise, balanced, ratio, risk, verdict };
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
  const columns = ['handle', 'name', 'bio', 'followers', 'following', 'followersText', 'followingText', 'ratio', 'promise', 'riskLevel', 'riskHits', 'verdict', 'status', 'url', 'checkedAt'];
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\ufeff' + [columns, ...rows.map(row => columns.map(key => key === 'riskLevel' ? row.risk?.level : key === 'riskHits' ? row.risk?.hits?.join('; ') : row[key]))].map(row => row.map(cell).join(',')).join('\r\n');
}
