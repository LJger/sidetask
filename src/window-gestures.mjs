// Click and drag share the entire handle. Pointer capture is released before
// entering the native move loop; native window events tell us when it ends.
export function bindWindowGestures(api, onError = () => {}) {
  let gesture = null;
  let suppressClick = null;
  let handlePress = null;
  const native = document.body.dataset.runtime === 'tauri';
  const handleTarget = () => document.body.dataset.expanded !== 'true' || document.body.dataset.focusRestored === 'true';
  // Capture the intended action before focus can cancel an automatic collapse.
  // Native focus may arrive first; focusRestored identifies that same reversal.
  document.addEventListener('pointerdown', event => {
    handlePress = event.button === 0 && event.isPrimary && event.target.closest('#edge-handle')
      ? { expanded: handleTarget() } : null;
  }, true);
  document.getElementById('edge-handle').addEventListener('click', event => {
    const expanded = event.detail > 0 && handlePress ? handlePress.expanded : handleTarget();
    handlePress = null;
    api.setExpanded(expanded).catch(onError);
  });
  const release = current => {
    if (current?.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
  };
  const finish = () => {
    const current = gesture;
    if (!current) return;
    gesture = null;
    release(current);
    if (current.moved && !native) api.endDrag().catch(onError);
  };
  document.addEventListener('pointerdown', event => {
    suppressClick = null;
    if (gesture) finish();
    if (event.button !== 0 || !event.isPrimary || !['expanded', 'collapsed'].includes(document.body.dataset.phase)) return;
    const handle = event.target.closest('#edge-handle');
    const collapsed = handle && document.body.dataset.expanded === 'false';
    const header = event.target.closest('[data-drag]');
    if (!collapsed && (!header || event.target.closest('button, input, textarea, select, a'))) return;
    const target = collapsed ? handle : header;
    gesture = { target, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    target.setPointerCapture(event.pointerId);
  });
  document.addEventListener('pointermove', event => {
    const current = gesture;
    if (!current || current.pointerId !== event.pointerId) return;
    const point = { x: event.clientX, y: event.clientY };
    if (!current.moved) {
      if (Math.hypot(point.x - current.x, point.y - current.y) <= 4) return;
      current.moved = true;
      suppressClick = current.target;
      event.preventDefault();
      if (native) release(current);
      api.startDrag({ x: current.x, y: current.y }).then(() => {
        if (gesture === current && !native) return api.moveDrag(point);
      }).catch(error => { finish(); onError(error); });
    } else if (!native) api.moveDrag(point).catch(onError);
  });
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', () => { handlePress = null; if (!native || !gesture?.moved) finish(); });
  document.addEventListener('lostpointercapture', () => { if (!native || !gesture?.moved) finish(); });
  document.addEventListener('click', event => {
    if (event.detail > 0 && suppressClick?.contains(event.target)) {
      handlePress = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  api.onWindowChange(value => { if (native && gesture?.moved && !value.dragging) finish(); });
  window.addEventListener('blur', () => { handlePress = null; if (!native || !gesture?.moved) finish(); });
}
