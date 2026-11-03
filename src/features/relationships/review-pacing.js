// Business settings shared by the panel and persisted review checkpoints.
export function reviewIntervalRange(config = {}) {
  const clamp = (value, fallback) => value === '' || value == null || !Number.isFinite(Number(value))
    ? fallback : Math.max(0, Math.min(300, Math.round(Number(value))));
  const min = clamp(config.intervalSeconds, 3);
  const max = Math.max(min, clamp(config.intervalMaxSeconds, min === 0 ? 0 : Math.min(300, min + 5)));
  return {intervalSeconds:min, intervalMaxSeconds:max};
}

export function reviewIntervalMs(config, random = Math.random) {
  const {intervalSeconds:min, intervalMaxSeconds:max} = reviewIntervalRange(config);
  return Math.round((min + Math.max(0, Math.min(1, random())) * (max - min)) * 1000);
}

export function validReviewInterval(config = {}) {
  const valid = value => value !== '' && value != null && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 300;
  return valid(config.intervalSeconds) && (config.intervalMaxSeconds === undefined
    || valid(config.intervalMaxSeconds) && Number(config.intervalMaxSeconds) >= Number(config.intervalSeconds));
}
