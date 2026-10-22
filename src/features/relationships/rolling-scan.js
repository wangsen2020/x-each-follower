export function acceptRollingPage(users, consumed, limit) {
  if (!Array.isArray(users) || users.length === 0) return {state:'empty', users:[]};
  if (users.length > limit - consumed) return {state:consumed ? 'defer' : 'oversize', users:[]};
  return {state:'accept', users, consumed:consumed + users.length};
}

export function changedFollowBackRows(before, after) {
  const previous = new Map((before || []).filter(user => user?.handle).map(user => [user.handle.toLowerCase(), JSON.stringify(user)]));
  return (after || []).filter(user => user?.handle && previous.get(user.handle.toLowerCase()) !== JSON.stringify(user));
}
