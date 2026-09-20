const STAGES = { prepare: 0, animate: 1, settled: 2 };
const EASE = 'cubic-bezier(.22,1,.36,1)';
const OVERSHOOT = 'cubic-bezier(.2,.9,.3,1.04)';
const IDENTITY = 'matrix(1, 0, 0, 1, 0, 0)';

// Visual styles for the opening and closing of the panel. Every style keeps
// the same three animations on the drawer, the panel and the handle, so the
// native window sequencing and the tests that pause them remain unchanged.
function hiddenClip(dock) {
  return { right: 'inset(0 0 0 100%)', left: 'inset(0 100% 0 0)', top: 'inset(100% 0 0 0)', bottom: 'inset(0 0 100% 0)' }[dock] ?? 'inset(0 0 0 100%)';
}
function normalize(value, fallback) {
  return !value || value === 'none' ? fallback : value;
}

export class SidebarMotion {
  constructor(api, { onSettled = () => {}, getStyle = () => 'slide' } = {}) {
    Object.assign(this, { api, onSettled, getStyle, drawer: document.getElementById('drawer'), panel: document.getElementById('panel'), handle: document.getElementById('edge-handle'), animations: [], run: 0 });
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { this.api.setReducedMotion?.(this.reduced.matches); if (this.previous) this.render(this.previous); };
    this.reduced.addEventListener('change', update);
    this.api.setReducedMotion?.(this.reduced.matches);
  }
  render(state) {
    const previous = this.previous;
    if (previous && (state.transitionId < previous.transitionId ||
        (state.transitionId === previous.transitionId && STAGES[state.stage] < STAGES[previous.stage]))) return;
    const style = this.getStyle();
    // Repeated IPC and native movement can change bounds without restarting an
    // animation or invalidating its pending ready frame.
    const key = JSON.stringify([state.transitionId, state.stage, state.expanded, state.surfaceExpanded,
      state.docking, state.dockSide, state.placementMode, state.panelSize.width, state.panelSize.height,
      state.shift.x, state.shift.y, this.reduced.matches, style]);
    const continuing = key === this.motionKey;
    const from = continuing ? null : this.capture();
    this.previous = state;
    this.motionKey = key;
    const root = document.documentElement;
    for (const [name, value] of Object.entries({ 'panel-width': state.panelSize.width, 'panel-height': state.panelSize.height,
      'handle-width': state.handleSize.width, 'handle-height': state.handleSize.height, 'handle-x': state.handleOffset.x, 'handle-y': state.handleOffset.y,
      'window-x': state.bounds.x, 'window-y': state.bounds.y, 'window-width': state.bounds.width, 'window-height': state.bounds.height })) root.style.setProperty('--' + name, value + 'px');
    Object.assign(document.body.dataset, { dock: state.dockSide, placement: state.placementMode, expanded: String(state.expanded), surfaceExpanded: String(state.surfaceExpanded), phase: state.docking ? 'docking' : state.phase, dragging: String(state.dragging), focusRestored: String(state.focusRestored === true), motion: style });
    this.updateHandleLabel();
    this.handle.setAttribute('aria-expanded', String(state.expanded));
    this.panel.inert = !state.expanded || state.stage === 'prepare';
    this.panel.setAttribute('aria-hidden', String(this.panel.inert));
    if (continuing) {
      if (state.stage === 'settled') this.onSettled(state);
      return;
    }
    const run = ++this.run;
    this.animations.forEach(animation => animation.cancel());
    this.animations = [];
    const changed = previous && (previous.dockSide !== state.dockSide || previous.placementMode !== state.placementMode || previous.surfaceExpanded !== state.surfaceExpanded);
    // Only the panel uses full-size travel coordinates. The independent handle
    // uses a unitless progress and the actual viewport, including during resize.
    const collapsed = state.surfaceExpanded
      ? 'translate(' + state.shift.x + 'px, ' + state.shift.y + 'px)'
      : 'translate(0px, 0px)';
    const closed = this.pose(style, state.dockSide, false, collapsed);
    const opened = this.pose(style, state.dockSide, true, collapsed);
    if (state.stage === 'prepare') {
      this.applyPose(closed);
      this.handle.style.setProperty('--handle-open', '0');
      requestAnimationFrame(() => requestAnimationFrame(() => { if (run === this.run) this.api.transitionReady(state.transitionId).catch(() => {}); }));
      return;
    }
    const open = state.expanded ? 1 : 0;
    const target = state.expanded ? opened : closed;
    this.applyPose(target);
    this.handle.style.setProperty('--handle-open', String(open));
    if (state.stage === 'settled' || state.docking) { if (state.stage === 'settled') this.onSettled(state); return; }
    if (previous?.stage === 'prepare' || !state.surfaceExpanded) from.open = 0;
    const start = changed ? closed : from;
    const options = { duration: this.reduced.matches ? 0 : (state.expanded ? 240 : 200) * Math.abs(open - from.open), easing: style === 'pop' && state.expanded ? OVERSHOOT : EASE, fill: 'forwards' };
    const animations = [
      this.drawer.animate([{ transform: start.drawer }, { transform: target.drawer }], options),
      this.panel.animate([{ opacity: start.opacity, transform: start.transform, clipPath: start.clip }, { opacity: target.opacity, transform: target.transform, clipPath: target.clip }], options),
      this.handle.animate([{ '--handle-open': from.open }, { '--handle-open': open }], options),
    ];
    this.animations = animations;
    Promise.all(animations.map(animation => animation.finished)).then(() => {
      if (run !== this.run) return;
      animations.forEach(animation => animation.cancel());
      this.animations = [];
      return this.api.transitionFinished(state.transitionId);
    }).catch(() => {});
  }
  // The current rendered values, so a reversed request continues from where
  // the previous animation was rather than jumping to its end.
  capture() {
    const panel = getComputedStyle(this.panel);
    return {
      drawer: normalize(getComputedStyle(this.drawer).transform, IDENTITY),
      opacity: panel.opacity,
      transform: normalize(panel.transform, IDENTITY),
      clip: normalize(panel.clipPath, 'inset(0px)'),
      open: Math.max(0, Math.min(1, Number(getComputedStyle(this.handle).getPropertyValue('--handle-open')))),
    };
  }
  pose(style, dock, expanded, collapsed) {
    const rest = { drawer: 'translate(0px, 0px)', opacity: '1', transform: IDENTITY, clip: 'inset(0px)' };
    if (expanded) return rest;
    if (style === 'fade') return { ...rest, opacity: '0', transform: 'scale(0.98)' };
    if (style === 'pop') return { ...rest, opacity: '0', transform: 'scale(0.9)' };
    if (style === 'reveal') return { ...rest, opacity: '0.6', clip: hiddenClip(dock) };
    return { ...rest, drawer: collapsed, opacity: '0' };
  }
  applyPose(pose) {
    this.drawer.style.transform = pose.drawer;
    this.panel.style.opacity = pose.opacity;
    this.panel.style.transform = pose.transform;
    this.panel.style.clipPath = pose.clip;
  }
  updateHandleLabel() {
    const expanded = this.previous?.expanded !== false;
    const count = this.handle.dataset.count ?? '0';
    this.handle.setAttribute('aria-label', expanded ? '收起侧记' : `展开侧记，${count} 件待办`);
    this.handle.title = expanded ? '收起侧记' : `${count} 件待办 · 单击展开，按住拖动`;
  }
}
