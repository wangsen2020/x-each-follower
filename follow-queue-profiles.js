// Presentation-only join: never use profile metadata to change task identity or follow state.
export function enrichQueueProfiles(jobs, data = {}) {
  const key = v => String(v || '').replace(/^@/, '').toLowerCase();
  const profiles = new Map();
  const merge = (user, fallback = '') => {
    if (!user || typeof user !== 'object') return;
    const handle = key(user.handle || fallback); if (!handle) return;
    const result = {...profiles.get(handle)};
    for (const field of ['name','bio','avatarUrl','followersText','followingText']) {
      if (user[field] !== undefined && user[field] !== null && String(user[field]).trim() !== '') result[field] = String(user[field]);
    }
    const blue = user.is_blue_verified ?? user.isBlueVerified;
    if (typeof blue === 'boolean') result.blueVerified = blue;
    if (typeof user.verified === 'boolean') result.verified = user.verified;
    profiles.set(handle, result);
  };
  for (const rows of [data.monitor?.users,data.monitor?.queue,data.monitor?.followingUsers,data.mutualNetwork?.users,data.commentTracking?.users]) {
    for (const user of Array.isArray(rows) ? rows : []) merge(user);
  }
  for (const [handle,user] of Object.entries(data.profileCache || {})) merge(user, handle);
  return jobs.map(job => ({...job, profile:{...job.profile,...profiles.get(key(job.handle))}}));
}
