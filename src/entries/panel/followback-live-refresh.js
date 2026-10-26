// autoUnfollowState is persisted after reconciliation. Read the committed row,
// rather than inferring a successful action from a cleared pending operation.
export async function refreshCompletedUnfollow(changes, {lookup, getUsers, setUsers}) {
  const change = changes.autoUnfollowState;
  const handle = String(change?.oldValue?.pending?.user?.handle || '').replace(/^@/, '').toLowerCase();
  if (!handle || !change.newValue || change.newValue.pending) return false;
  const result = await lookup(handle);
  if (!result?.ok) throw new Error(result?.error || '取关记录刷新失败');
  const row = result.records?.find(row => row.module === 'unreciprocated' && String(row.payload?.handle || '').toLowerCase() === handle);
  if (!row) return false;
  const latest = {...row.payload, __userKey: row.userKey, __expectedHandle: row.handle,
    __sourceKey: row.sourceKey || row.sourcePath?.[0], __sourceBucket: row.bucket || row.sourcePath?.[1]};
  // Read at completion so another update received during the query is preserved.
  const users = getUsers();
  const found = users.some(user => String(user.handle || '').toLowerCase() === handle);
  setUsers(found ? users.map(user => String(user.handle || '').toLowerCase() === handle ? latest : user) : [...users, latest]);
  return true;
}
