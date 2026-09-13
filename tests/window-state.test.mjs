import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowTransitions } from '../src/window-state.mjs';

function setup(expanded = false) {
  const applied = [], events = [], timers = new Map();
  let count = 0;
  const controller = new WindowTransitions({
    expanded,
    getLayout: () => ({ dockSide: 'right', panelSize: { width: 420, height: 850 } }),
    applyBounds: value => applied.push(value),
    emit: state => events.push(state),
    setTimer: callback => { timers.set(++count, callback); return count; },
    clearTimer: id => timers.delete(id),
  });
  return { controller, applied, events, timers };
}

test('expansion waits for prepared content and collapse keeps full bounds until the final frame', () => {
  const { controller: window, applied } = setup();
  window.request(true);
  assert.equal(window.snapshot().stage, 'prepare');
  assert.deepEqual(applied, []);
  window.finish(window.transitionId);
  assert.equal(window.snapshot().stage, 'prepare');
  assert.deepEqual(applied, []);
  window.ready(window.transitionId);
  assert.deepEqual(applied, [true]);
  assert.equal(window.snapshot().phase, 'expanding');
  window.finish(window.transitionId);
  assert.equal(window.phase, 'expanded');
  window.request(false);
  assert.equal(window.surfaceExpanded, true);
  assert.equal(window.phase, 'collapsing');
  window.finish(window.transitionId);
  assert.equal(window.phase, 'collapsed');
  assert.equal(window.surfaceExpanded, false);
  assert.equal(applied.at(-1), false);
});

test('reversals and stale callbacks cannot resize a newly opened window', () => {
  const { controller: window, applied } = setup(true);
  window.request(false);
  const closing = window.transitionId;
  window.request(true);
  assert.equal(window.stage, 'animate');
  window.finish(closing);
  assert.deepEqual(applied, []);
  window.finish(window.transitionId);
  assert.equal(window.phase, 'expanded');
  assert.deepEqual(applied, [true]);
  window.request(false);
  window.finish(window.transitionId);
  window.request(true);
  const opening = window.transitionId;
  window.request(false);
  window.ready(opening);
  assert.equal(window.surfaceExpanded, false);
  window.finish(window.transitionId);
  assert.equal(window.phase, 'collapsed');
});

test('lost renderer acknowledgements have a bounded fallback; display changes cancel old transitions', () => {
  const { controller: window, timers, applied } = setup();
  window.request(true);
  const stale = window.transitionId;
  const timeout = [...timers.values()][0];
  timeout();
  assert.equal(window.phase, 'expanded');
  assert.equal(applied.at(-1), true);
  window.request(false);
  window.refresh();
  assert.equal(window.phase, 'collapsed');
  window.finish(stale);
  window.ready(stale);
  assert.equal(window.surfaceExpanded, false);
  assert.equal(timers.size, 0);
});

test('twenty rapid alternating commands always settle to the most recent target', () => {
  const { controller: window } = setup(true);
  const ids = [];
  for (let index = 0; index < 20; index++) {
    window.request(!window.expanded);
    ids.push(window.transitionId);
  }
  for (const id of ids.slice(0, -1)) { window.ready(id); window.finish(id); }
  assert.equal(window.expanded, true);
  window.finish(ids.at(-1));
  assert.equal(window.phase, 'expanded');
});
