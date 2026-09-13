import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, emptyState, nextRepeatDate, patchTask, reminderAt, reminderKey, selectTasks, taskCounts, validateState } from '../src/domain.mjs';
import { applyCommand, UndoHistory } from '../src/model.mjs';

process.env.TZ = 'Asia/Shanghai';
const now = '2026-09-07T02:00:00.000Z';
function model() {
  let state = emptyState();
  let sequence = 0;
  return {
    get state() { return state; },
    run(type, args, time = now) {
      const next = structuredClone(state);
      const result = applyCommand(next, type, args, time, () => 'new-' + (++sequence));
      state = next;
      validateState(state);
      return structuredClone(result);
    },
  };
}
const input = (title, extra = {}) => ({ title, dueDate: '2026-09-07', ...extra });

test('categories, multiple tags, search and date views compose without changing global counts', () => {
  const app = model();
  const work = app.run('taxonomy:save', { kind: 'categories', input: { name: '工作' } }).result;
  const urgent = app.run('taxonomy:save', { kind: 'tags', input: { name: '紧急' } }).result;
  const writing = app.run('taxonomy:save', { kind: 'tags', input: { name: '写作' } }).result;
  app.run('task:add', { input: input('今天写稿', { categoryId: work.id, tagIds: [urgent.id, writing.id], subtasks: [{ id: 'child', title: '整理 PDF', completed: false }] }) });
  app.run('task:add', { input: input('明天会议', { categoryId: work.id, tagIds: [urgent.id], dueDate: '2026-09-08' }) });
  app.run('task:add', { input: input('未安排', { dueDate: null }) });
  const { tasks, categories, tags } = app.state;
  const filters = { today: '2026-09-07', categories, tags, categoryId: work.id, tagIds: [urgent.id, writing.id] };
  assert.deepEqual(selectTasks(tasks, filters).map(task => task.title), ['今天写稿']);
  assert.equal(selectTasks(tasks, { ...filters, search: 'pdf' }).length, 1);
  assert.equal(selectTasks(tasks, { ...filters, search: '写作' }).length, 1);
  assert.equal(selectTasks(tasks, { ...filters, search: '其他' }).length, 0);
  assert.deepEqual(selectTasks(tasks, { view: 'planned', today: '2026-09-07' }).map(task => task.title), ['明天会议']);
  assert.equal(taskCounts(tasks, '2026-09-07', filters).all, 1);
  assert.equal(taskCounts(tasks, '2026-09-07').all, 3);
});

test('taxonomy validation prevents duplicate names and deletion only removes references', () => {
  const app = model();
  const category = app.run('taxonomy:save', { kind: 'categories', input: { name: 'Work' } }).result;
  const tag = app.run('taxonomy:save', { kind: 'tags', input: { name: '客户' } }).result;
  const task = app.run('task:add', { input: input('沟通', { categoryId: category.id, tagIds: [tag.id] }) }).result;
  assert.throws(() => app.run('taxonomy:save', { kind: 'categories', input: { name: ' work ' } }), /已经存在/);
  app.run('taxonomy:save', { kind: 'categories', input: { ...category, name: '工作' } });
  assert.equal(app.state.tasks[0].categoryId, category.id);
  app.run('taxonomy:delete', { kind: 'categories', id: category.id });
  app.run('taxonomy:delete', { kind: 'tags', id: tag.id });
  assert.equal(app.state.tasks.length, 1);
  assert.equal(app.state.tasks[0].id, task.id);
  assert.equal(app.state.tasks[0].categoryId, null);
  assert.deepEqual(app.state.tasks[0].tagIds, []);
  assert.throws(() => app.run('task:add', { input: input('无效分类', { categoryId: 'missing' }) }), /分类已不存在/);
});

test('subtasks do not complete the parent; parent completion and undo restore the exact checklist', () => {
  const app = model();
  const task = app.run('task:add', { input: input('交付', { subtasks: [
    { id: 'a', title: '起草', completed: true }, { id: 'b', title: '审核', completed: false },
  ] }) }).result;
  app.run('task:update', { id: task.id, patch: { subtasks: task.subtasks.map(item => ({ ...item, completed: true })) } });
  assert.equal(app.state.tasks[0].completedAt, null);
  app.run('task:update', { id: task.id, patch: { subtasks: task.subtasks } });
  const before = structuredClone(app.state.tasks[0]);
  const completed = app.run('task:update', { id: task.id, patch: { completed: true } });
  assert.ok(app.state.tasks[0].subtasks.every(item => item.completed));
  app.run('task:undo', { undo: completed.undo });
  assert.deepEqual(app.state.tasks[0], before);
  assert.equal(taskCounts(app.state.tasks, '2026-09-07').all, 1);
});

test('completing a recurring task atomically preserves history and creates only one next instance', () => {
  const app = model();
  const task = app.run('task:add', { input: input('每日复盘', {
    notes: '写下下一步', recurrence: { frequency: 'daily' },
    subtasks: [{ id: 'child', title: '记录', completed: false }],
  }) }).result;
  const completion = app.run('task:update', { id: task.id, patch: { completed: true } }, '2026-09-10T08:00:00.000Z');
  assert.equal(app.state.tasks.length, 2);
  const successor = app.state.tasks.find(item => !item.completedAt);
  assert.equal(successor.dueDate, '2026-09-11');
  assert.equal(successor.previousId, task.id);
  assert.equal(successor.seriesId, task.seriesId);
  assert.equal(successor.notes, task.notes);
  assert.equal(successor.subtasks[0].completed, false);
  assert.notEqual(successor.subtasks[0].id, task.subtasks[0].id);
  app.run('task:undo', { undo: completion.undo });
  assert.deepEqual(app.state.tasks, [task]);
  app.run('task:update', { id: task.id, patch: { completed: true } });
  app.run('task:update', { id: task.id, patch: { completed: true } });
  assert.equal(app.state.tasks.length, 2);
});

test('recurrence keeps monthly anchors, skips weekends and respects an inclusive end date', () => {
  const monthly = createTask({ title: '月末', dueDate: '2026-01-31', recurrence: { frequency: 'monthly' } }, now, 'month');
  assert.equal(nextRepeatDate(monthly, '2026-01-31T10:00:00+08:00'), '2026-02-28');
  assert.equal(nextRepeatDate({ ...monthly, dueDate: '2026-02-28' }, '2026-02-28T10:00:00+08:00'), '2026-03-31');
  const leap = { ...monthly, dueDate: '2028-01-31' };
  assert.equal(nextRepeatDate(leap, '2028-01-31T10:00:00+08:00'), '2028-02-29');
  assert.equal(nextRepeatDate({ ...monthly, dueDate: '2026-12-31' }, '2026-12-31T10:00:00+08:00'), '2027-01-31');
  const weekdays = createTask({ title: '工作日', dueDate: '2026-09-11', recurrence: { frequency: 'weekdays' } }, now, 'weekdays');
  assert.equal(nextRepeatDate(weekdays, '2026-09-11T10:00:00+08:00'), '2026-09-14');
  const weekly = createTask({ title: '每周', dueDate: '2026-09-07', recurrence: { frequency: 'weekly', until: '2026-09-14' } }, now, 'weekly');
  assert.equal(nextRepeatDate(weekly, '2026-09-09T10:00:00+08:00'), '2026-09-14');
  assert.equal(nextRepeatDate({ ...weekly, dueDate: '2026-09-14' }, '2026-09-14T10:00:00+08:00'), null);
  assert.equal(nextRepeatDate({ ...weekly, dueDate: '9999-12-31', recurrence: { ...weekly.recurrence, until: null } }, now), null);
});

test('undo rejects changed successors; reopening recurring history detaches it from the series', () => {
  const app = model();
  const task = app.run('task:add', { input: input('循环', { recurrence: { frequency: 'daily' } }) }).result;
  const completion = app.run('task:update', { id: task.id, patch: { completed: true } });
  const successor = app.state.tasks.find(item => !item.completedAt);
  app.run('task:update', { id: successor.id, patch: { title: '已经调整的下一次' } });
  const before = structuredClone(app.state);
  assert.throws(() => app.run('task:undo', { undo: completion.undo }), /已经修改/);
  assert.deepEqual(app.state, before);
  app.run('task:update', { id: task.id, patch: { completed: false } });
  const reopened = app.state.tasks.find(item => item.id === task.id);
  assert.equal(reopened.recurrence, null);
  assert.equal(reopened.seriesId, null);
  assert.equal(app.state.tasks.filter(item => !item.completedAt && item.recurrence).length, 1);
});

test('editing an active recurrence changes the next instance without modifying completed history', () => {
  const app = model();
  const first = app.run('task:add', { input: input('循环', { recurrence: { frequency: 'daily' } }) }).result;
  app.run('task:update', { id: first.id, patch: { completed: true } });
  const history = structuredClone(app.state.tasks[0]);
  const current = app.state.tasks[1];
  app.run('task:update', { id: current.id, patch: { recurrence: { frequency: 'weekly' }, notes: '新规则' } });
  app.run('task:update', { id: current.id, patch: { completed: true } }, '2026-09-08T10:00:00+08:00');
  assert.deepEqual(app.state.tasks[0], history);
  assert.equal(app.state.tasks.at(-1).dueDate, '2026-09-15');
  assert.equal(app.state.tasks.at(-1).notes, '新规则');
});

test('restore repairs references removed after deletion without restoring deleted taxonomies', () => {
  const app = model();
  const category = app.run('taxonomy:save', { kind: 'categories', input: { name: '工作' } }).result;
  const task = app.run('task:add', { input: input('恢复', { categoryId: category.id }) }).result;
  const removed = app.run('task:delete', { id: task.id }).result;
  app.run('taxonomy:delete', { kind: 'categories', id: category.id });
  app.run('task:restore', { task: removed });
  assert.equal(app.state.tasks[0].categoryId, null);
  assert.equal(app.state.categories.length, 0);
});

test('backup merge maps taxonomy IDs and skips duplicate active recurrence series', () => {
  const app = model();
  const work = app.run('taxonomy:save', { kind: 'categories', input: { name: '工作' } }).result;
  const repeating = app.run('task:add', { input: input('本地循环', { categoryId: work.id, recurrence: { frequency: 'daily' } }) }).result;
  const backup = {
    ...emptyState(), categories: [{ id: 'remote-work', name: '工作', color: '#4676a9' }],
    tags: [{ id: 'remote-tag', name: '客户', color: '#32654d' }],
    tasks: [
      { ...repeating, id: 'old-occurrence', categoryId: 'remote-work' },
      createTask(input('新任务', { categoryId: 'remote-work', tagIds: ['remote-tag'] }), now, 'import-new'),
    ],
    settings: { ...emptyState().settings, dockSide: 'left' },
  };
  const response = app.run('data:import', { raw: backup });
  assert.deepEqual(response.result, { imported: 1, skipped: 1 });
  assert.equal(app.state.categories.length, 1);
  assert.equal(app.state.tasks.at(-1).categoryId, work.id);
  assert.equal(app.state.tasks.at(-1).tagIds[0], app.state.tags[0].id);
  assert.equal(app.state.settings.dockSide, 'right');
  assert.deepEqual(app.run('data:import', { raw: backup }).result, { imported: 0, skipped: 2 });
  assert.equal(app.state.tags.length, 1);
  const tag = app.state.tags[0];
  app.run('taxonomy:save', { kind: 'tags', input: { ...tag, name: '已重命名' } });
  app.run('data:import', { raw: backup });
  assert.equal(app.state.tags.length, 1);
  assert.equal(app.state.tags[0].name, '已重命名');
});

test('v1 migration supplies safe defaults and future or broken v2 data is rejected', () => {
  const task = createTask(input('旧任务'), now, 'old');
  const migrated = validateState({ version: 1, tasks: [task] });
  assert.equal(migrated.version, 3);
  assert.equal(migrated.tasks[0].id, 'old');
  assert.deepEqual(migrated.categories, []);
  assert.equal(migrated.tasks[0].recurrence, null);
  assert.equal(migrated.tasks[0].reminder, null);
  assert.deepEqual(migrated.tasks[0].subtasks, []);
  assert.throws(() => validateState({ version: 4, tasks: [] }), /数据版本/);
  assert.throws(() => validateState({ ...emptyState(), tasks: [{ ...task, categoryId: 'missing' }] }), /分类已不存在/);
  const recurring = createTask(input('重复', { recurrence: { frequency: 'daily' } }), now, 'series');
  assert.throws(() => validateState({ ...emptyState(), tasks: [recurring, { ...recurring, id: 'duplicate' }] }), /一个未完成/);
});

test('reminders require future local times; modifying other fields keeps a past delivery record', () => {
  assert.throws(() => createTask(input('无时间', { reminder: { offsetMinutes: 0 } }), now, 'bad'), /日期、时间/);
  assert.throws(() => createTask(input('过去', { dueTime: '09:00', reminder: { offsetMinutes: 0 } }), now, 'past'), /已经过去/);
  const task = createTask(input('提醒', { dueTime: '11:00', reminder: { offsetMinutes: 15 } }), now, 'alarm');
  assert.equal(reminderAt(task), Date.parse('2026-09-07T10:45:00+08:00'));
  const delivered = { ...task, reminderSentKey: reminderKey(task) };
  const changed = patchTask(delivered, { title: '更新标题' }, '2026-09-07T12:00:00+08:00');
  assert.equal(changed.reminderSentKey, delivered.reminderSentKey);
  const rescheduled = patchTask(changed, { dueDate: '2026-09-08' }, '2026-09-07T12:00:00+08:00');
  assert.equal(rescheduled.reminderSentKey, null);
});

test('reminder claims recheck concurrent changes and do not mark an edited or completed task', () => {
  const app = model();
  const task = app.run('task:add', { input: input('提醒', { dueTime: '11:00', reminder: { offsetMinutes: 0 } }) }).result;
  const entry = { id: task.id, key: reminderKey(task) };
  app.run('task:update', { id: task.id, patch: { dueDate: '2026-09-08' } });
  assert.deepEqual(app.run('reminders:claim', { entries: [entry] }, '2026-09-07T04:00:00.000Z').result, []);
  const changed = app.state.tasks[0];
  const newEntry = { id: changed.id, key: reminderKey(changed) };
  const first = app.run('reminders:claim', { entries: [newEntry] }, '2026-09-08T04:00:00.000Z');
  assert.equal(first.result.length, 1);
  assert.equal(app.run('reminders:claim', { entries: [newEntry] }, '2026-09-08T04:00:00.000Z').result.length, 0);
});

test('concurrent editor saves are rejected even when both operations occur in the same millisecond', () => {
  const app = model();
  const task = app.run('task:add', { input: input('原始内容') }).result;
  app.run('task:update', { id: task.id, patch: { notes: '先保存' }, expectedUpdatedAt: task.updatedAt });
  assert.throws(() => app.run('task:update', { id: task.id, patch: { title: '覆盖' }, expectedUpdatedAt: task.updatedAt }), /别处修改/);
  assert.equal(app.state.tasks[0].notes, '先保存');
  assert.equal(app.state.tasks[0].title, '原始内容');
});

test('undo tokens expire and cannot be fabricated', () => {
  let time = 1000;
  const history = new UndoHistory(() => time);
  const token = history.remember({ before: { id: 'a' } });
  assert.equal(history.get(token).before.id, 'a');
  assert.throws(() => history.get('invented'), /过期/);
  time += 10001;
  assert.throws(() => history.get(token), /过期/);
});

test('time sorting and pagination inputs never mutate stored task order', () => {
  const tasks = [
    createTask(input('晚些', { dueTime: '18:00', priority: 'high' }), now, 'a'),
    createTask(input('早些', { dueTime: '09:00' }), now, 'b'),
  ];
  assert.deepEqual(selectTasks(tasks, { today: '2026-09-07', sort: 'time' }).map(task => task.id), ['b', 'a']);
  assert.deepEqual(selectTasks(tasks, { today: '2026-09-07', sort: 'priority' }).map(task => task.id), ['a', 'b']);
  assert.deepEqual(tasks.map(task => task.id), ['a', 'b']);
});
