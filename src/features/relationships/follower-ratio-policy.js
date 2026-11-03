// Only exact profile API counts authorize a destructive relationship change.
export function followerRatioDecision(profile = {}, ratioLimit = 10) {
  const threshold = Number.isInteger(Number(ratioLimit)) && Number(ratioLimit) >= 1 && Number(ratioLimit) <= 1000 ? Number(ratioLimit) : 10;
  const count = value => /^\d+$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const following = count(profile.followingText), followers = count(profile.followersText);
  const known = following !== null && followers !== null;
  const remove = known && following > followers * threshold;
  return {known, remove, following, followers, threshold,
    reason:!known ? '关注数或粉丝数未读全，比例待核实'
      : remove ? `关注数 ${following} 超过粉丝数 ${followers} 的 ${threshold} 倍，跳过回关并移除此关注者`
        : `关注数未超过粉丝数的 ${threshold} 倍，继续待回关放行`};
}
