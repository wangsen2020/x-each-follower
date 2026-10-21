export function safeXPostUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return url.protocol === 'https:' && /^(x\.com|twitter\.com)$/i.test(url.hostname) ? url.href : '';
  } catch {
    return '';
  }
}
