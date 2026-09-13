export const PANEL_WIDTH = 420;
export const CALENDAR_WIDTH = 1120;
export const PANEL_HEIGHT = 850;
// A 40-DIP thickness also clears native minimum heights under mixed Windows DPI.
export const HANDLE_WIDTH = 40;
export const HANDLE_HEIGHT = 40;
export const EDGES = ['right', 'left', 'bottom', 'top'];
export const clamp = (n, min, max) => Math.max(min, Math.min(n, Math.max(min, max)));
export const defaultPlacement = () => ({ mode: 'docked', displayId: null, edge: 'right', anchor: 0.5, floatCenter: { x: 0.5, y: 0.5 } });

export function windowBounds(area, expanded, edge = 'right') {
  const layout = windowLayout(area, { ...defaultPlacement(), edge });
  return expanded ? layout.fullBounds : layout.handleBounds;
}

export function displayForBounds(displays, bounds, preferredId = null) {
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  let best;
  for (const display of displays) {
    const area = display.bounds;
    const overlap = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)) *
      Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
    const distance = Math.hypot(Math.max(area.x - center.x, 0, center.x - area.x - area.width),
      Math.max(area.y - center.y, 0, center.y - area.y - area.height));
    if (!best || overlap > best.overlap || (overlap === best.overlap &&
      (distance < best.distance || (distance === best.distance && display.id === preferredId)))) {
      best = { display, overlap, distance };
    }
  }
  return best?.display;
}

export function validatePlacement(value) {
  if (!value || !['floating', 'docked'].includes(value.mode) || !EDGES.includes(value.edge) ||
      !Number.isFinite(value.anchor) || value.anchor < 0 || value.anchor > 1 ||
      !value.floatCenter || !['x', 'y'].every(key => Number.isFinite(value.floatCenter[key]) && value.floatCenter[key] >= 0 && value.floatCenter[key] <= 1) ||
      !(value.displayId == null || typeof value.displayId === 'string' || Number.isInteger(value.displayId))) throw new Error('窗口位置无效。');
  return { mode: value.mode, displayId: value.displayId ?? null, edge: value.edge, anchor: value.anchor, floatCenter: { ...value.floatCenter } };
}

export function panelSize(area, view = 'day') {
  const margin = Math.min(16, Math.floor(area.height / 10));
  return { width: Math.min(['week', 'month'].includes(view) ? CALENDAR_WIDTH : PANEL_WIDTH, area.width), height: Math.min(PANEL_HEIGHT, area.height - margin * 2) };
}

export function floatingPlacement(area, bounds, previous = defaultPlacement()) {
  return { ...previous, mode: 'floating', floatCenter: {
    x: clamp((bounds.x + bounds.width / 2 - area.x) / area.width, 0, 1),
    y: clamp((bounds.y + bounds.height / 2 - area.y) / area.height, 0, 1),
  } };
}

export function nearestDock(area, bounds, previous = defaultPlacement()) {
  const distances = { left: Math.abs(bounds.x - area.x), right: Math.abs(area.x + area.width - bounds.x - bounds.width),
    top: Math.abs(bounds.y - area.y), bottom: Math.abs(area.y + area.height - bounds.y - bounds.height) };
  const minimum = Math.min(...Object.values(distances));
  const candidates = EDGES.filter(edge => Math.abs(distances[edge] - minimum) < 0.5);
  const edge = candidates.includes(previous.edge) ? previous.edge : candidates[0];
  const vertical = ['left', 'right'].includes(edge);
  const anchor = vertical ? (bounds.y + bounds.height / 2 - area.y) / area.height : (bounds.x + bounds.width / 2 - area.x) / area.width;
  return { ...floatingPlacement(area, bounds, previous), mode: 'docked', edge, anchor: clamp(anchor, 0, 1) };
}

export function windowLayout(area, placement = defaultPlacement(), view = 'day', floatingBounds = null) {
  const size = panelSize(area, view);
  const { edge, anchor } = placement;
  const vertical = ['left', 'right'].includes(edge);
  const handleSize = { width: Math.min(vertical ? HANDLE_WIDTH : HANDLE_HEIGHT, area.width), height: Math.min(vertical ? HANDLE_HEIGHT : HANDLE_WIDTH, area.height) };
  const handle = {
    x: vertical ? (edge === 'left' ? area.x : area.x + area.width - handleSize.width) : clamp(area.x + anchor * area.width - handleSize.width / 2, area.x, area.x + area.width - handleSize.width),
    y: vertical ? clamp(area.y + anchor * area.height - handleSize.height / 2, area.y, area.y + area.height - handleSize.height) : (edge === 'top' ? area.y : area.y + area.height - handleSize.height),
    ...handleSize,
  };
  let full = { ...size, x: area.x, y: area.y };
  if (placement.mode === 'floating') {
    full.x = clamp(area.x + placement.floatCenter.x * area.width - size.width / 2, area.x, area.x + area.width - size.width);
    full.y = clamp(area.y + placement.floatCenter.y * area.height - size.height / 2, area.y, area.y + area.height - size.height);
    if (floatingBounds) full = { ...floatingBounds };
  } else if (vertical) {
    full.x = edge === 'left' ? area.x : area.x + area.width - size.width;
    full.y = clamp(handle.y + handle.height / 2 - size.height / 2, area.y, area.y + area.height - size.height);
  } else {
    full.x = clamp(handle.x + handle.width / 2 - size.width / 2, area.x, area.x + area.width - size.width);
    full.y = edge === 'top' ? area.y : area.y + area.height - size.height;
  }
  const shift = { x: vertical ? (edge === 'left' ? -1 : 1) * (full.width - handleSize.width) : 0,
    y: vertical ? 0 : (edge === 'top' ? -1 : 1) * (full.height - handleSize.height) };
  const handleOffset = { x: vertical ? (edge === 'right' ? 0 : full.width - handleSize.width) : handle.x - full.x,
    y: vertical ? handle.y - full.y : (edge === 'bottom' ? 0 : full.height - handleSize.height) };
  return { dockSide: edge, placementMode: placement.mode, panelSize: { width: full.width, height: full.height },
    fullBounds: full, handleBounds: handle, handleSize, handleOffset, shift };
}
