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

// A transformed native dialog establishes its own containing block. Place the
// tooltip in that block, bounded by the visible dialog, rather than reusing
// viewport coordinates and applying the dialog's translation a second time.
export function positionDialogInfoTip(anchor, tooltip, dialog, viewport, margin = 8) {
  const originX = dialog.left + (dialog.clientLeft || 0);
  const originY = dialog.top + (dialog.clientTop || 0);
  const left = Math.max(0, originX), top = Math.max(0, originY);
  const width = Math.max(0, Math.min(viewport.width, originX + dialog.clientWidth) - left);
  const height = Math.max(0, Math.min(viewport.height, originY + dialog.clientHeight) - top);
  // DOMRect fields live on its prototype and are not spreadable own properties.
  const local = {width:anchor.width,left:anchor.left - left,top:anchor.top - top,bottom:anchor.bottom - top};
  const result = positionInfoTip(local, tooltip, {width, height}, margin);
  return {...result, left:result.left + left - originX + (dialog.scrollLeft || 0), top:result.top + top - originY + (dialog.scrollTop || 0), maxHeight:Math.max(0, height - margin * 2)};
}
