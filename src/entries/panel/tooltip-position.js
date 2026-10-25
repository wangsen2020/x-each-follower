const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function positionInfoTip(anchor, tooltip, viewport, margin = 8) {
  const width = Math.min(tooltip.width, Math.max(0, viewport.width - margin * 2));
  const height = Math.min(tooltip.height, Math.max(0, viewport.height - margin * 2));
  const left = clamp(anchor.left + anchor.width / 2 - width / 2, margin, viewport.width - margin - width);
  const gap = 8;
  const below = viewport.height - anchor.bottom - gap;
  const above = anchor.top - gap;
  const placeAbove = below < height && above > below;
  const candidateTop = placeAbove ? anchor.top - gap - height : anchor.bottom + gap;
  const top = clamp(candidateTop, margin, viewport.height - margin - height);
  return { left, top, width, placement: placeAbove ? 'top' : 'bottom' };
}
