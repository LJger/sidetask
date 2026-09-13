const STAGES = { prepare: 0, animate: 1, settled: 2 };

export class SidebarMotion {
  constructor(api, { onSettled = () => {} } = {}) {
    Object.assign(this, { api, onSettled, drawer: document.getElementById('drawer'), panel: document.getElementById('panel'), handle: document.getElementById('edge-handle'), animations: [], run: 0 });
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => { this.api.setReducedMotion?.(this.reduced.matches); if (this.previous) this.render(this.previous); };
    this.reduced.addEventListener('change', update);
    this.api.setReducedMotion?.(this.reduced.matches);
  }
  render(state) {
    const previous = this.previous;
    if (previous && (state.transitionId < previous.transitionId ||
        (state.transitionId === previous.transitionId && STAGES[state.stage] < STAGES[previous.stage]))) return;
    // Repeated IPC and native movement can change bounds without restarting an
    // animation or invalidating its pending ready frame.
    const key = JSON.stringify([state.transitionId, state.stage, state.expanded, state.surfaceExpanded,
      state.docking, state.dockSide, state.placementMode, state.panelSize.width, state.panelSize.height,
      state.shift.x, state.shift.y, this.reduced.matches]);
    const continuing = key === this.motionKey;
    const from = continuing ? null : {
      transform: getComputedStyle(this.drawer).transform,
      opacity: getComputedStyle(this.panel).opacity,
      open: Math.max(0, Math.min(1, Number(getComputedStyle(this.handle).getPropertyValue('--handle-open')))),
    };
    this.previous = state;
    this.motionKey = key;
    const root = document.documentElement;
    for (const [name, value] of Object.entries({ 'panel-width': state.panelSize.width, 'panel-height': state.panelSize.height,
      'handle-width': state.handleSize.width, 'handle-height': state.handleSize.height, 'handle-x': state.handleOffset.x, 'handle-y': state.handleOffset.y,
      'window-x': state.bounds.x, 'window-y': state.bounds.y, 'window-width': state.bounds.width, 'window-height': state.bounds.height })) root.style.setProperty('--' + name, value + 'px');
    Object.assign(document.body.dataset, { dock: state.dockSide, placement: state.placementMode, expanded: String(state.expanded), surfaceExpanded: String(state.surfaceExpanded), phase: state.docking ? 'docking' : state.phase, dragging: String(state.dragging), focusRestored: String(state.focusRestored === true) });
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
    if (state.stage === 'prepare') {
      this.drawer.style.transform = collapsed;
      this.panel.style.opacity = '0';
      this.handle.style.setProperty('--handle-open', '0');
      requestAnimationFrame(() => requestAnimationFrame(() => { if (run === this.run) this.api.transitionReady(state.transitionId).catch(() => {}); }));
      return;
    }
    const open = state.expanded ? 1 : 0;
    const target = state.expanded ? 'translate(0px, 0px)' : collapsed;
    this.drawer.style.transform = target;
    this.panel.style.opacity = String(open);
    this.handle.style.setProperty('--handle-open', String(open));
    if (state.stage === 'settled' || state.docking) { if (state.stage === 'settled') this.onSettled(state); return; }
    if (previous?.stage === 'prepare' || !state.surfaceExpanded) from.open = 0;
    const options = { duration: this.reduced.matches ? 0 : (state.expanded ? 240 : 200) * Math.abs(open - from.open), easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' };
    const animations = [
      this.drawer.animate([{ transform: changed ? collapsed : from.transform }, { transform: target }], options),
      this.panel.animate([{ opacity: from.opacity }, { opacity: open }], options),
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
  updateHandleLabel() {
    const expanded = this.previous?.expanded !== false;
    const count = this.handle.dataset.count ?? '0';
    this.handle.setAttribute('aria-label', expanded ? '收起侧记' : `展开侧记，${count} 件待办`);
    this.handle.title = expanded ? '收起侧记' : `${count} 件待办 · 单击展开，按住拖动`;
  }
}
