// Shared sequencing for native windows and the browser preview.
export class WindowTransitions {
  constructor({ expanded = true, getLayout, applyBounds, emit, settled = () => {}, setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = id => clearTimeout(id) }) {
    Object.assign(this, { expanded, getLayout, applyBounds, emit, settled, setTimer, clearTimer });
    this.surfaceExpanded = expanded;
    this.phase = expanded ? 'expanded' : 'collapsed';
    this.stage = 'settled';
    this.transitionId = 0;
    this.timer = null;
  }

  snapshot() {
    return { expanded: this.expanded, surfaceExpanded: this.surfaceExpanded, phase: this.phase,
      stage: this.stage, transitionId: this.transitionId, ...this.getLayout() };
  }

  publish() { this.emit(this.snapshot()); }

  request(expanded) {
    if (this.expanded === expanded && this.stage !== 'settled') return;
    if (this.expanded === expanded && this.stage === 'settled') { this.settled(this.snapshot()); return; }
    this.clearTimer(this.timer);
    this.expanded = expanded;
    this.transitionId += 1;
    this.phase = expanded ? 'expanding' : 'collapsing';
    this.stage = expanded && !this.surfaceExpanded ? 'prepare' : 'animate';
    const id = this.transitionId;
    this.timer = this.setTimer(() => this.settle(id), 800);
    this.publish();
  }

  ready(id) {
    if (id !== this.transitionId || this.stage !== 'prepare') return;
    this.surfaceExpanded = true;
    this.applyBounds(true);
    this.stage = 'animate';
    this.publish();
  }

  finish(id) {
    if (this.stage !== 'animate') return;
    this.settle(id);
  }

  settle(id) {
    if (id !== this.transitionId || this.stage === 'settled') return;
    this.clearTimer(this.timer);
    this.surfaceExpanded = this.expanded;
    this.applyBounds(this.expanded);
    this.phase = this.expanded ? 'expanded' : 'collapsed';
    this.stage = 'settled';
    this.publish();
    this.settled(this.snapshot());
  }

  refresh() {
    this.clearTimer(this.timer);
    this.transitionId += 1;
    this.surfaceExpanded = this.expanded;
    this.phase = this.expanded ? 'expanded' : 'collapsed';
    this.stage = 'settled';
    this.applyBounds(this.expanded);
    this.publish();
    this.settled(this.snapshot());
  }

  dispose() { this.clearTimer(this.timer); }
}
