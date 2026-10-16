export function randomizedSeconds(anchorSeconds, jitterSeconds = 0, minSeconds = 1, maxSeconds = 60, random = Math.random) {
  const anchor = Number(anchorSeconds);
  const jitter = Number(jitterSeconds);
  const min = Number(minSeconds);
  const max = Number(maxSeconds);
  const safeMin = Number.isFinite(min) ? min : 1;
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : 60;
  const safeAnchor = Number.isFinite(anchor) ? Math.min(safeMax, Math.max(safeMin, anchor)) : safeMin;
  const safeJitter = Number.isFinite(jitter) ? Math.max(0, jitter) : 0;
  if (!safeJitter) return safeAnchor;
  const low = Math.max(safeMin, safeAnchor - safeJitter);
  const high = Math.min(safeMax, safeAnchor + safeJitter);
  const roll = Math.min(0.999999999, Math.max(0, Number(random()) || 0));
  return low + Math.floor(roll * (high - low + 1));
}
