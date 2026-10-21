export function randomizedInteger(anchorValue, jitterValue = 0, minValue = 1, maxValue = Number.MAX_SAFE_INTEGER, random = Math.random) {
  const anchor = Number(anchorValue);
  const jitter = Number(jitterValue);
  const min = Number(minValue);
  const max = Number(maxValue);
  const safeMin = Number.isFinite(min) ? Math.ceil(min) : 1;
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, Math.floor(max)) : Number.MAX_SAFE_INTEGER;
  const safeAnchor = Number.isFinite(anchor) ? Math.min(safeMax, Math.max(safeMin, Math.round(anchor))) : safeMin;
  const safeJitter = Number.isFinite(jitter) ? Math.max(0, Math.floor(jitter)) : 0;
  if (!safeJitter) return safeAnchor;
  const low = Math.max(safeMin, safeAnchor - safeJitter);
  const high = Math.min(safeMax, safeAnchor + safeJitter);
  const roll = Math.min(0.999999999, Math.max(0, Number(random()) || 0));
  return low + Math.floor(roll * (high - low + 1));
}

export const randomizedSeconds = randomizedInteger;
