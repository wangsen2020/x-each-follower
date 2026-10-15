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
  return { ...profile, promise, balanced, ratio, verdict };
}

export function csv(rows) {
  const columns = ['handle', 'name', 'bio', 'followers', 'following', 'followersText', 'followingText', 'ratio', 'promise', 'verdict', 'status', 'url', 'checkedAt'];
  const cell = value => {
    let text = String(value ?? '');
    if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\ufeff' + [columns, ...rows.map(row => columns.map(key => row[key]))].map(row => row.map(cell).join(',')).join('\r\n');
}
