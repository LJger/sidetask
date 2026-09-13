import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskStore } from './reference/node-store.mjs';
import { createTask, emptyState } from '../src/domain.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sidetask-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new TaskStore(directory);
  await store.load();
  return store;
}

test('a fresh install has no sample tasks and persists tasks and settings across restarts', async t => {
  const store = await fixture(t);
  assert.equal(store.snapshot().tasks.length, 0);
  const added = await store.add({ title: '整理本周计划', dueDate: '2026-09-07', priority: 'high' });
  await store.update(added.result.id, { completed: true, notes: '明天复盘' });
  await store.setSettings({ dockSide: 'left', alwaysOnTop: false, collapsedHandleOpacity: 0.35 });
  const restarted = new TaskStore(store.directory);
  assert.deepEqual(await restarted.load(), store.snapshot());
  const external = restarted.snapshot();
  external.tasks.length = 0;
  assert.equal(restarted.snapshot().tasks.length, 1);
});

test('serializes simultaneous writes without losing tasks', async t => {
  const store = await fixture(t);
  await Promise.all(Array.from({ length: 25 }, (_, index) => store.add({ title: `任务 ${index}` })));
  await store.flush();
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(saved.tasks.length, 25);
  assert.equal(new Set(saved.tasks.map(task => task.id)).size, 25);
});

test('deletion returns the full task so undo preserves dates and notes', async t => {
  const store = await fixture(t);
  const { result: task } = await store.add({ title: '删除再恢复', notes: '不能丢失的备注', dueDate: '2026-09-07' });
  const removed = await store.remove(task.id);
  assert.equal(store.snapshot().tasks.length, 0);
  await store.restore(removed.result);
  assert.deepEqual(store.snapshot().tasks[0], task);
  await assert.rejects(store.restore(task), /已经存在/);
});

test('imports only new IDs, preserving current task content and desktop settings', async t => {
  const store = await fixture(t);
  const { result: existing } = await store.add({ title: '当前版本' });
  const backup = emptyState();
  backup.settings.dockSide = 'left';
  backup.settings.launchAtLogin = true;
  backup.tasks = [{ ...existing, title: '旧版本' }, createTask({ title: '来自备份' })];
  const response = await store.importData(backup);
  assert.deepEqual(response.result, { imported: 1, skipped: 1 });
  assert.equal(store.snapshot().tasks[0].title, '当前版本');
  assert.equal(store.snapshot().settings.dockSide, 'right');
  assert.equal(store.snapshot().settings.launchAtLogin, false);
});

test('an invalid import leaves the in-memory and on-disk data untouched', async t => {
  const store = await fixture(t);
  await store.add({ title: '保留这条' });
  const before = await readFile(store.file, 'utf8');
  const invalid = { ...emptyState(), tasks: [{ id: 'bad', title: '' }] };
  assert.throws(() => store.importData(invalid));
  assert.equal(await readFile(store.file, 'utf8'), before);
  assert.equal(store.snapshot().tasks.length, 1);
});

test('a rejected operation does not block later writes', async t => {
  const store = await fixture(t);
  await assert.rejects(store.update('missing-id', { completed: true }), /不存在/);
  await store.add({ title: '仍然可以保存' });
  assert.equal(store.snapshot().tasks.length, 1);
});

test('a disk-write failure preserves the task draft state and allows retry', async t => {
  const store = await fixture(t);
  await store.add({ title: '已经保存' });
  const before = await readFile(store.file, 'utf8');
  await mkdir(`${store.file}.tmp`);
  await assert.rejects(store.add({ title: '这次写入失败' }), /保存失败/);
  assert.equal(store.snapshot().tasks.length, 1);
  assert.equal(await readFile(store.file, 'utf8'), before);
  await rm(`${store.file}.tmp`, { recursive: true });
  await store.add({ title: '重试成功' });
  assert.equal(store.snapshot().tasks.length, 2);
});

test('recovers the previous good backup and preserves a corrupted primary file', async t => {
  const store = await fixture(t);
  await store.add({ title: '上一份备份中的任务' });
  await store.add({ title: '最近一次更改' });
  await writeFile(store.file, '{ broken json', 'utf8');
  const recovered = new TaskStore(store.directory);
  const state = await recovered.load();
  assert.deepEqual(state.tasks.map(task => task.title), ['上一份备份中的任务']);
  assert.match(recovered.warning, /恢复上一次备份/);
  const preserved = (await readdir(store.directory)).find(file => file.startsWith('tasks.corrupt-'));
  assert.equal(await readFile(path.join(store.directory, preserved), 'utf8'), '{ broken json');
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).tasks.length, 1);
});

test('preserves a corrupted file even when no backup exists', async t => {
  const store = await fixture(t);
  await writeFile(store.file, 'corrupted without backup', 'utf8');
  const recovered = new TaskStore(store.directory);
  assert.equal((await recovered.load()).tasks.length, 0);
  assert.match(recovered.warning, /原文件|已保留/);
  assert.equal((await readdir(store.directory)).filter(file => file.startsWith('tasks.corrupt-')).length, 1);
});

test('refuses to overwrite data from an unsupported future version', async t => {
  const store = await fixture(t);
  const future = JSON.stringify({ version: 4, tasks: [{ content: 'future data' }] });
  await writeFile(store.file, future, 'utf8');
  const reopened = new TaskStore(store.directory);
  await assert.rejects(reopened.load(), /数据版本/);
  assert.equal(await readFile(store.file, 'utf8'), future);
});

test('migrates v1 on disk and preserves an independent original across later writes and restarts', async t => {
  const store = await fixture(t);
  const oldTask = createTask({ title: '旧版任务', dueDate: '2026-09-07', notes: '保留备注' });
  const original = JSON.stringify({ version: 1, tasks: [oldTask], settings: { dockSide: 'left' } }, null, 2);
  await writeFile(store.file, original);
  const upgraded = new TaskStore(store.directory);
  const state = await upgraded.load();
  assert.equal(state.version, 3);
  assert.equal(state.tasks[0].id, oldTask.id);
  assert.equal(state.tasks[0].notes, '保留备注');
  assert.equal(state.tasks[0].reminder, null);
  assert.equal(state.settings.dockSide, 'left');
  assert.equal(await readFile(upgraded.legacyFile, 'utf8'), original);
  await upgraded.add({ title: '新版任务' });
  await upgraded.add({ title: '再次保存' });
  const restarted = new TaskStore(store.directory);
  assert.equal((await restarted.load()).tasks.length, 3);
  assert.equal(await readFile(upgraded.legacyFile, 'utf8'), original);
  assert.equal(JSON.parse(await readFile(store.file, 'utf8')).version, 3);
});

test('a failed recurring completion never persists a partial history or next occurrence', async t => {
  const store = await fixture(t);
  const task = (await store.add({ title: '每日安排', dueDate: '2026-09-07', recurrence: { frequency: 'daily' } })).result;
  await mkdir(store.file + '.tmp');
  await assert.rejects(store.update(task.id, { completed: true }), /保存失败/);
  assert.equal(store.snapshot().tasks.length, 1);
  assert.equal(store.snapshot().tasks[0].completedAt, null);
  await rm(store.file + '.tmp', { recursive: true });
  const completed = await store.update(task.id, { completed: true });
  assert.equal(store.snapshot().tasks.length, 2);
  assert.ok(completed.undoToken);
  await store.undoCompletion(completed.undoToken);
  assert.deepEqual(store.snapshot().tasks, [task]);
  await assert.rejects(store.undoCompletion(completed.undoToken), /过期/);
});
