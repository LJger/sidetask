import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, createTask, DEFAULT_SETTINGS, describeDate, emptyState, groupTasks, isDateOnly, localDate, patchTask, selectTasks, taskCounts, validateSettings, validateState } from '../src/domain.mjs';

const now = '2026-09-07T03:00:00.000Z';
const today = '2026-09-07';
const task = (id, values = {}) => createTask({ title: id, ...values }, now, id);

test('validates real calendar dates, including leap days', () => {
  assert.equal(isDateOnly('2024-02-29'), true);
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', '0099-01-01', '2026-09-07T00:00:00Z']) assert.equal(isDateOnly(value), false);
});

test('rejects blank, oversized, and invalid task fields without changing the original', () => {
  assert.throws(() => task('blank', { title: '   ' }), /请填写/);
  assert.throws(() => task('large', { title: '字'.repeat(161) }), /160/);
  assert.throws(() => task('bad-date', { dueDate: '2026-02-30' }), /日期/);
  const original = task('valid');
  assert.throws(() => patchTask(original, { priority: 'urgent' }), /优先级/);
  assert.throws(() => patchTask(original, { completed: 'yes' }), /完成状态/);
  assert.equal(original.priority, 'normal');
});

test('preserves text as text and prevents changes to task identity', () => {
  const original = task('safe-id', { title: '  <img src=x onerror=alert(1)>  ' });
  assert.equal(original.title, '<img src=x onerror=alert(1)>');
  const next = patchTask(original, { id: 'different', createdAt: '2020-01-01', title: '新标题' }, now);
  assert.equal(next.id, 'safe-id');
  assert.equal(next.createdAt, now);
});

test('completion can be reversed and repeated completion preserves its first timestamp', () => {
  const original = task('complete');
  const completed = patchTask(original, { completed: true }, now);
  assert.equal(completed.completedAt, now);
  assert.equal(patchTask(completed, { completed: true }, '2026-09-08T03:00:00Z').completedAt, now);
  assert.equal(patchTask(completed, { completed: false }, now).completedAt, null);
  assert.equal(original.completedAt, null);
});

test('today includes overdue tasks and excludes undated, future, and completed tasks', () => {
  const tasks = [task('future', { dueDate: '2026-09-08' }), task('undated'), task('today', { dueDate: today }), task('overdue', { dueDate: '2026-09-06' }), patchTask(task('done', { dueDate: today }), { completed: true }, now)];
  assert.deepEqual(selectTasks(tasks, { today }).map(item => item.id), ['overdue', 'today']);
  assert.equal(selectTasks(tasks, { view: 'all', today }).length, 4);
  assert.deepEqual(selectTasks(tasks, { view: 'completed', today }).map(item => item.id), ['done']);
});

test('sorts overdue and today ahead of future tasks, with important tasks first within each group', () => {
  const tasks = [task('later', { dueDate: '2026-09-20' }), task('normal', { dueDate: today }), task('important', { dueDate: today, priority: 'high' }), task('undated', { priority: 'high' }), task('overdue', { dueDate: '2026-09-01' })];
  const selected = selectTasks(tasks, { view: 'all', today });
  assert.deepEqual(selected.map(item => item.id), ['overdue', 'important', 'normal', 'later', 'undated']);
  assert.equal(groupTasks(selected, 'all', today).length, 4);
  assert.equal(tasks[0].id, 'later');
});

test('searches both title and notes without treating input as markup or regular expressions', () => {
  const tasks = [task('a', { title: '准备会议', notes: 'Bring PDF [draft]' }), task('b', { title: '买咖啡' })];
  assert.equal(selectTasks(tasks, { view: 'all', search: 'pdf', today })[0].id, 'a');
  assert.equal(selectTasks(tasks, { view: 'all', search: '[draft]', today }).length, 1);
  assert.equal(selectTasks(tasks, { view: 'all', search: '  咖啡 ', today })[0].id, 'b');
});

test('counts completion by the local day, including tasks without a due date', () => {
  const tasks = [task('pending', { dueDate: today }), task('overdue', { dueDate: '2026-09-06' }), task('future', { dueDate: '2026-09-08' }), patchTask(task('done'), { completed: true }, now), patchTask(task('old'), { completed: true }, '2026-09-04T03:00:00Z')];
  const counts = taskCounts(tasks, today);
  assert.deepEqual(counts, { today: 2, planned: 1, all: 3, completed: 2, doneToday: 1, totalToday: 3 });
});

test('uses local dates rather than UTC dates at midnight in China', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Shanghai';
    assert.equal(localDate(new Date('2026-09-06T16:30:00Z')), today);
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('date labels handle daylight saving transitions and year changes', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(describeDate('2026-10-31', '2026-11-02').label, '逾期 2 天');
    assert.equal(addDays('2026-11-01', 1), '2026-11-02');
    assert.equal(describeDate('2027-02-01', today).label, '2027年2月1日');
    assert.equal(describeDate('2026-09-08', today).label, '明天');
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('requires a supported backup schema and unique task IDs', () => {
  assert.throws(() => validateState({ version: 4, tasks: [] }), /数据版本/);
  assert.throws(() => validateState({ ...emptyState(), tasks: [task('same'), task('same')] }), /重复/);
  assert.throws(() => validateState({ ...emptyState(), tasks: [task('same'), {}] }), /编号/);
  assert.deepEqual(validateState({ version: 1, tasks: [] }).settings, DEFAULT_SETTINGS);
});

test('accepts only known setting values', () => {
  assert.throws(() => validateSettings({ autoCollapse: 'false' }), /设置值/);
  assert.throws(() => validateSettings({ dockSide: 'top' }), /方向/);
  assert.deepEqual(validateSettings({ alwaysOnTop: false, unknown: true }), { alwaysOnTop: false });
});

test('handle opacity validates numeric bounds and defaults older settings', () => {
  for (const value of [0.2, 0.35, 0.8, 1]) assert.equal(validateSettings({ collapsedHandleOpacity: value }).collapsedHandleOpacity, value);
  for (const value of [0, 0.19, 1.01, '0.5', null, true, NaN, Infinity]) {
    assert.throws(() => validateSettings({ collapsedHandleOpacity: value }), /透明度/);
  }
  const old = emptyState();
  delete old.settings.collapsedHandleOpacity;
  assert.equal(validateState(old).settings.collapsedHandleOpacity, 0.8);
});
