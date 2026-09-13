import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, emptyState, patchTask, reminderKey } from '../src/domain.mjs';
import { applyCommand } from '../src/model.mjs';
import { ReminderScheduler } from '../src/reminders.mjs';

process.env.TZ = 'Asia/Shanghai';
function setup() {
  let now = Date.parse('2026-09-07T10:00:00+08:00');
  let state = emptyState();
  const notices = [], errors = [], timers = new Map();
  let timerId = 0;
  let fail = false;
  const scheduler = new ReminderScheduler({
    read: () => structuredClone(state), clock: () => now,
    claim: async entries => {
      if (fail) throw new Error('磁盘写入失败');
      const next = structuredClone(state);
      const { result } = applyCommand(next, 'reminders:claim', { entries }, new Date(now).toISOString());
      state = next;
      return { state, result };
    },
    notify: (tasks, meta) => notices.push({ ids: tasks.map(task => task.id), ...meta }),
    onError: error => errors.push(error.message),
    setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  return { scheduler, notices, errors, timers,
    set now(value) { now = Date.parse(value); },
    get state() { return state; },
    set state(value) { state = value; },
    set fail(value) { fail = value; },
  };
}
function alarm(id, dueTime = '11:00') {
  return createTask({ title: id, dueDate: '2026-09-07', dueTime, reminder: { offsetMinutes: 0 } }, '2026-09-07T08:00:00+08:00', id);
}

test('startup merges missed reminders once, durably deduplicating across scheduler restarts', async () => {
  const app = setup();
  app.state.tasks = [alarm('a', '09:00'), alarm('b', '09:30')];
  await app.scheduler.start();
  assert.deepEqual(app.notices, [{ ids: ['a', 'b'], missed: true }]);
  assert.ok(app.state.tasks.every(task => task.reminderSentKey === reminderKey(task)));
  await app.scheduler.refresh(true);
  app.scheduler.stop();
  await app.scheduler.start();
  assert.equal(app.notices.length, 1);
  app.scheduler.stop();
  assert.equal(app.timers.size, 0);
});

test('future alarms trigger at the right local time and edits rearm them without resending old alarms', async () => {
  const app = setup();
  app.state.tasks = [alarm('a', '10:01')];
  await app.scheduler.start();
  assert.equal(app.notices.length, 0);
  app.now = '2026-09-07T10:01:00+08:00';
  await app.scheduler.refresh();
  assert.equal(app.notices.length, 1);
  assert.equal(app.notices[0].missed, false);
  app.state.tasks[0] = patchTask(app.state.tasks[0], { dueTime: '10:05' }, '2026-09-07T10:02:00+08:00');
  app.now = '2026-09-07T10:03:00+08:00';
  await app.scheduler.refresh();
  assert.equal(app.notices.length, 1);
  app.now = '2026-09-07T10:05:00+08:00';
  await app.scheduler.refresh(true);
  assert.equal(app.notices.length, 2);
  app.scheduler.stop();
});

test('sleep recovery batches missed reminders while completed and deleted tasks remain silent', async () => {
  const app = setup();
  app.state.tasks = [alarm('a'), alarm('b'), { ...alarm('done'), completedAt: '2026-09-07T02:00:00.000Z' }];
  await app.scheduler.start();
  app.state.tasks = app.state.tasks.filter(task => task.id !== 'b');
  app.now = '2026-09-07T14:00:00+08:00';
  await app.scheduler.refresh();
  assert.deepEqual(app.notices, [{ ids: ['a'], missed: true }]);
  app.scheduler.stop();
});

test('a failed claim never delivers an unrecorded alarm and remains retryable', async () => {
  const app = setup();
  app.state.tasks = [alarm('a', '09:00')];
  app.fail = true;
  await app.scheduler.start();
  assert.equal(app.notices.length, 0);
  assert.equal(app.state.tasks[0].reminderSentKey, null);
  assert.deepEqual(app.errors, ['磁盘写入失败']);
  app.fail = false;
  await app.scheduler.refresh(true);
  assert.equal(app.notices.length, 1);
  app.scheduler.stop();
});

test('concurrent refreshes share one claim and stopping cancels future checks', async () => {
  const app = setup();
  app.state.tasks = [alarm('a', '09:00')];
  await Promise.all([app.scheduler.start(), app.scheduler.refresh(), app.scheduler.refresh(true)]);
  assert.equal(app.notices.length, 1);
  app.scheduler.stop();
  await app.scheduler.refresh();
  assert.equal(app.notices.length, 1);
});

test('shutdown drains an in-flight claimed reminder before it can be mistaken for a missed delivery', async () => {
  let completeClaim;
  const delivered = [];
  const task = alarm('in-flight', '09:00');
  const scheduler = new ReminderScheduler({
    read: () => ({ tasks: [task] }),
    clock: () => Date.parse('2026-09-07T10:00:00+08:00'),
    claim: () => new Promise(resolve => { completeClaim = resolve; }),
    notify: tasks => delivered.push(...tasks),
  });
  const starting = scheduler.start();
  const stopped = scheduler.stop();
  completeClaim({ result: [task] });
  await Promise.all([starting, stopped]);
  assert.equal(delivered.length, 1);
  assert.equal(scheduler.running, false);
});
