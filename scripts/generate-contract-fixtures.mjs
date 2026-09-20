import { writeFile, mkdir } from 'node:fs/promises';
import { applyCommand } from '../src/model.mjs';
import { emptyState, createTask, validateState } from '../src/domain.mjs';

// The existing browser model is the independent compatibility reference for
// the Rust backend. IDs and clocks are fixed; no production data is read.
const now = '2026-01-05T12:00:00.000Z';
const cases = [];
let state = emptyState(), sequence = 0;
function run(command, args, time = now) {
  const before = structuredClone(state);
  const start = sequence;
  const result = applyCommand(state, command, args, time, () => 'contract-' + (++sequence));
  validateState(state);
  cases.push({ command, args: structuredClone(args), now: time, sequence: start, before, after: structuredClone(state), result: structuredClone(result) });
  return result;
}
const category = run('taxonomy:save', { kind: 'categories', input: { name: ' Work ' } }).result;
const tag = run('taxonomy:save', { kind: 'tags', input: { name: '客户', color: '#4676a9' } }).result;
const task = run('task:add', { input: { title: '  月末交付 📝  ', notes: '保留备注', dueDate: '2026-01-31', dueTime: '11:00', reminder: { offsetMinutes: 15 },
  categoryId: category.id, tagIds: [tag.id], recurrence: { frequency: 'monthly' }, subtasks: [{ id: 'child', title: '核对', completed: false }] } }).result;
run('task:update', { id: task.id, patch: { priority: 'high' }, expectedUpdatedAt: task.updatedAt });
const completion = run('task:update', { id: task.id, patch: { completed: true } });
run('task:undo', { undo: completion.undo });
run('task:update', { id: task.id, patch: { completed: true } });
const next = state.tasks.find(item => !item.completedAt);
run('task:update', { id: next.id, patch: { completed: true } });
run('task:update', { id: task.id, patch: { completed: false } });
run('taxonomy:save', { kind: 'categories', input: { ...category, name: '工作' } });
const removed = run('task:delete', { id: task.id }).result;
run('taxonomy:delete', { kind: 'categories', id: category.id });
run('taxonomy:delete', { kind: 'tags', id: tag.id });
run('task:restore', { task: removed });
for (const frequency of ['daily', 'weekly', 'weekdays']) {
  const item = run('task:add', { input: { title: frequency, dueDate: '2026-09-11', recurrence: { frequency, until: '2026-09-20' } } }).result;
  run('task:update', { id: item.id, patch: { completed: true } });
}
run('settings:set', { patch: { dockSide: 'left', themePreset: 'graphite', motionStyle: 'pop', collapsedHandleOpacity: 0.35, panelOpacity: 0.6, showCompleted: false, calendarView: 'month', autoCollapse: false } });
const imported = emptyState();
imported.categories = [{ id: 'remote', name: '个人', color: '#32654d' }];
imported.tasks = [createTask({ title: '导入任务', categoryId: 'remote' }, now, 'imported')];
imported.settings.themePreset = 'sand';
run('data:import', { raw: imported });
run('data:import', { raw: imported });
const alarm = run('task:add', { input: { title: '提醒', dueDate: '2026-10-01', dueTime: '11:00', reminder: { offsetMinutes: 0 } } }).result;
run('reminders:claim', { entries: [{ id: alarm.id, key: `${alarm.id}|2026-10-01|11:00|0` }] }, '2026-10-03T12:00:00.000Z');
run('reminders:claim', { entries: [{ id: alarm.id, key: `${alarm.id}|2026-10-01|11:00|0` }] }, '2026-10-03T12:00:00.000Z');
await mkdir('tests/fixtures', { recursive: true });
await writeFile('tests/fixtures/model-contract.json', JSON.stringify(cases, null, 2) + '\n');
console.log(`已生成 ${cases.length} 项浏览器／原生后台契约样例。`);
