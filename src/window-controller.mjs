import { WindowTransitions } from './window-state.mjs';
import { defaultPlacement, floatingPlacement, nearestDock, windowLayout } from './window-layout.mjs';

export class AutoDockController {
  constructor(collapse, cancel = () => {}) {
    Object.assign(this, { collapse, cancel, focused: true, protected: false, enabled: true, eligible: false, automatic: false, disposed: false });
  }
  update(patch) {
    if (this.disposed) return;
    Object.assign(this, patch);
    const eligible = this.enabled && !this.focused && !this.protected;
    const changed = eligible !== this.eligible;
    this.eligible = eligible;
    if (eligible && changed) { this.automatic = true; this.collapse(); }
    else if (!eligible && this.automatic) { this.automatic = false; this.cancel(); }
  }
  dispose() { this.disposed = true; }
}

export class WindowController {
  constructor({ placement = defaultPlacement(), view = 'day', expanded = true, getArea, setBounds, emit, persist = () => {}, settled = () => {} }) {
    Object.assign(this, { placement: structuredClone(placement), view, getArea, setBounds, emit, persist, settled });
    this.motionId = 0;
    this.reducedMotion = false;
    this.dragging = false;
    this.docking = false;
    this.focusRestored = false;
    this.nativeBounds = windowLayout(this.getArea(), this.placement, this.view).fullBounds;
    if (!expanded && this.placement.mode === 'floating') this.placement = nearestDock(this.getArea(), this.nativeBounds, this.placement);
    this.transitions = new WindowTransitions({ expanded, getLayout: () => ({ ...this.layout(), dragging: this.dragging, docking: this.docking,
      focusRestored: this.focusRestored && this.transitions.stage !== 'settled', bounds: this.nativeBounds }),
      applyBounds: full => this.apply(full), emit: value => this.emit(value), settled: value => { this.save(); this.settled(value); } });
    this.apply(expanded);
  }
  layout() { return windowLayout(this.getArea(), this.placement, this.view, this.placement.mode === 'floating' ? this.nativeBounds : null); }
  snapshot() { return this.transitions.snapshot(); }
  apply(full) {
    const layout = this.layout();
    this.nativeBounds = { ...(full ? layout.fullBounds : layout.handleBounds) };
    this.setBounds(this.nativeBounds);
  }
  save() { Promise.resolve(this.persist(structuredClone(this.placement))).catch(() => {}); }
  stopTravel() { this.motionId++; clearTimeout(this.travelTimer); this.docking = false; }
  expand({ focusRestore = false } = {}) {
    const changedFocus = this.focusRestored !== focusRestore;
    const id = this.transitions.transitionId;
    this.focusRestored = focusRestore;
    if (this.docking) {
      this.stopTravel();
      this.placement = floatingPlacement(this.getArea(), this.nativeBounds, this.placement);
      this.transitions.expanded = true;
      this.transitions.refresh();
    } else this.transitions.request(true);
    if (changedFocus && id === this.transitions.transitionId) this.transitions.publish();
  }
  collapse() {
    if (this.dragging || this.docking) return;
    this.focusRestored = false;
    if (this.placement.mode === 'floating') {
      const source = { ...this.nativeBounds };
      this.placement = nearestDock(this.getArea(), source, this.placement);
      const target = this.layout().fullBounds;
      this.docking = true;
      const id = ++this.motionId;
      const start = performance.now();
      const step = () => {
        if (id !== this.motionId) return;
        const progress = this.reducedMotion ? 1 : Math.min(1, (performance.now() - start) / 160);
        const eased = 1 - (1 - progress) ** 3;
        this.nativeBounds = { ...target, x: Math.round(source.x + (target.x - source.x) * eased), y: Math.round(source.y + (target.y - source.y) * eased) };
        this.setBounds(this.nativeBounds);
        this.transitions.publish();
        if (progress < 1) this.travelTimer = setTimeout(step, 16);
        else { this.docking = false; this.transitions.request(false); }
      };
      step();
    } else this.transitions.request(false);
  }
  toggle() { this.docking || !this.transitions.expanded ? this.expand() : this.collapse(); }
  setView(view) {
    if (!['day', 'week', 'month', 'list'].includes(view)) throw new Error('窗口布局无效。');
    if (this.view === view) return;
    this.stopTravel();
    this.view = view;
    this.nativeBounds = windowLayout(this.getArea(), this.placement, view).fullBounds;
    this.transitions.refresh();
  }
  move(bounds, displayId = this.placement.displayId) {
    if (this.transitions.stage !== 'settled' || this.docking) return false;
    this.dragging = true;
    this.nativeBounds = { ...bounds };
    // A collapsed handle stays docked while it is dragged, so its toggle remains
    // available after the move. Expanded surfaces can still be freely floated.
    this.placement = this.transitions.expanded
      ? floatingPlacement(this.getArea(), bounds, { ...this.placement, displayId })
      : nearestDock(this.getArea(), bounds, { ...this.placement, displayId });
    this.transitions.publish();
    return true;
  }
  endMove(bounds = this.nativeBounds, displayId = this.placement.displayId) {
    if (!this.dragging) return;
    this.move(bounds, displayId);
    this.dragging = false;
    if (!this.transitions.expanded) {
      // Keep a collapsed handle flush with its selected edge. This prevents
      // a free-floating native window from disagreeing with its docked layout.
      this.nativeBounds = { ...this.layout().handleBounds };
      this.setBounds(this.nativeBounds);
    }
    this.transitions.publish();
    this.save();
  }
  relocate(placement) {
    this.stopTravel();
    this.placement = structuredClone(placement);
    this.nativeBounds = windowLayout(this.getArea(), this.placement, this.view).fullBounds;
    this.transitions.refresh();
  }
  refresh() { this.relocate(this.placement); }
  ready(id) { this.transitions.ready(id); }
  finish(id) { this.transitions.finish(id); }
  dispose() { this.stopTravel(); this.transitions.dispose(); }
}
