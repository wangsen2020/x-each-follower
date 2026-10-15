function collectUsers(value, out = new Map()) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) { for (const item of value) collectUsers(item, out); return out; }
  const legacy = value.legacy || value.core?.user_results?.result?.legacy;
  const restId = value.rest_id || value.restId || value.id_str || value.id;
  const handle = legacy?.screen_name || value.screen_name;
  if (restId && handle && /^[A-Za-z0-9_]{1,15}$/.test(handle)) out.set(handle.toLowerCase(), {id:String(restId), handle, name:legacy?.name || value.name || handle, bio:legacy?.description || value.description || '', followersText:legacy?.followers_count == null ? '' : String(legacy.followers_count), followingText:legacy?.friends_count == null ? '' : String(legacy.friends_count), state:legacy?.following === true || value.following === true ? 'following' : 'follow_back'});
  for (const child of Object.values(value)) collectUsers(child, out);
  return out;
}

function findCursor(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.cursor === 'string') return value.cursor;
  if (typeof value.value === 'string' && /cursor/i.test(value.cursorType || value.type || '')) return value.value;
  for (const child of Object.values(value)) { const result = findCursor(child); if (result) return result; }
  return '';
}

export async function networkFetch(tabId, op, variables) {
  const {networkTemplates = {}} = await chrome.storage.local.get('networkTemplates');
  const template = networkTemplates[op];
  if (!template) return {status:0, error:`未捕获 ${op} 模板`};
  const result = await chrome.scripting.executeScript({target:{tabId}, world:'MAIN', func:async (operation, vars, t) => {
    if (!t) return {status:0, error:`未捕获 ${operation} 模板`};
    let base = {}; try { base = t.variables ? JSON.parse(t.variables) : {}; } catch {}
    const query = new URLSearchParams({variables:JSON.stringify({...base,...vars}), ...(t.features ? {features:t.features} : {}), ...(t.fieldToggles ? {fieldToggles:t.fieldToggles} : {})});
    const response = await fetch(`${t.origin}/i/api/graphql/${t.queryId}/${operation}?${query}`, {credentials:'include', headers:{...(t.headers || {}), 'content-type':'application/json'}});
    return {status:response.status, json:await response.json().catch(() => null)};
  }, args:[op, variables, template]});
  return result?.[0]?.result || {status:0, error:'页面没有返回网络结果'};
}

export function parseNetworkUsers(json) { return [...collectUsers(json).values()]; }
export { findCursor };
