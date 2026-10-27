// autoUnfollowState is persisted after reconciliation. Read the committed row,
// rather than inferring a successful action from a cleared pending operation.
import {pendingOperations, pendingHandle, samePendingTarget} from '../../features/relationships/auto-unfollow-state.js';
export async function refreshCompletedUnfollow(changes, {lookup, getUsers, setUsers}) {
  const change = changes.autoUnfollowState;
  if(!change?.oldValue || !change.newValue)return false;
  const oldAccounts=change.oldValue.accounts || {legacy:change.oldValue};
  const newAccounts=change.newValue.accounts || {legacy:change.newValue};
  const handles=new Set();
  for(const [account,previous] of Object.entries(oldAccounts)){
    const current=newAccounts[account];
    if(!current)continue;
    const pending=pendingOperations(current);
    for(const item of pendingOperations(previous))if(!pending.some(other=>samePendingTarget(other,item.user)) && pendingHandle(item.user))handles.add(pendingHandle(item.user));
  }
  let refreshed=false;
  for(const handle of handles){
  const result = await lookup(handle);
  if (!result?.ok) throw new Error(result?.error || '取关记录刷新失败');
  const row = result.records?.find(row => row.module === 'unreciprocated' && String(row.payload?.handle || '').toLowerCase() === handle);
  if (!row) continue;
  const latest = {...row.payload, __userKey: row.userKey, __expectedHandle: row.handle,
    __sourceKey: row.sourceKey || row.sourcePath?.[0], __sourceBucket: row.bucket || row.sourcePath?.[1]};
  // Read at completion so another update received during the query is preserved.
  const users = getUsers();
  const found = users.some(user => String(user.handle || '').toLowerCase() === handle);
  setUsers(found ? users.map(user => String(user.handle || '').toLowerCase() === handle ? latest : user) : [...users, latest]);
  refreshed=true;
  }
  return refreshed;
}
