import test from 'node:test';
import assert from 'node:assert/strict';
import { CalendarProjection, groupByDate } from '../src/calendar-ui.mjs';

test('projection computes only the current and newest pending range', t => {
  const requests = [];
  globalThis.Worker = class { postMessage(request) { requests.push(request); } };
  globalThis.window = { addEventListener() {} };
  t.after(() => { delete globalThis.Worker; delete globalThis.window; });
  let updates = 0;
  const projection = new CalendarProjection(() => updates++, assert.fail);
  for (const end of ['2026-09-20', '2026-09-21', '2026-09-22']) projection.schedule([], { start: '2026-09-19', end }, '2026-09-19');
  assert.equal(requests.length, 1);
  projection.worker.onmessage({ data: { id: 1, previews: ['stale'] } });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].end, '2026-09-22');
  assert.equal(updates, 0);
  projection.worker.onmessage({ data: { id: 3, previews: ['current'] } });
  assert.equal(updates, 1);
  assert.deepEqual(projection.previews, ['current']);
  assert.equal(projection.loading, false);
});

test('date indexing preserves task order including the completed tail', () => {
  const tasks = [{ id: 'pending', dueDate: '2026-09-19' }, { id: 'other', dueDate: '2026-09-20' }, { id: 'done', dueDate: '2026-09-19' }];
  assert.deepEqual(groupByDate(tasks, 'dueDate').get('2026-09-19').map(task => task.id), ['pending', 'done']);
});
