import {
  assertObject, assertReferences, COLORS, createTask, MAX_TASKS, nextRepeatDate,
  patchTask, reminderAt, reminderKey, validateSettings, validateState, validateTask, validateTaxonomy,
} from './domain.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const value = result => ({ result });

function findTask(state, id) {
  const index = state.tasks.findIndex(task => task.id === id);
  if (index < 0) throw new Error('这条任务已不存在。');
  return index;
}

function assertCapacity(state) {
  if (state.tasks.length >= MAX_TASKS) throw new Error('最多支持 ' + MAX_TASKS + ' 条任务，请先导出并整理旧任务。');
}

function assertSingleSeries(task, state, exceptId = null) {
  if (!task.completedAt && task.recurrence && state.tasks.some(other =>
    other.id !== exceptId && !other.completedAt && other.recurrence && other.seriesId === task.seriesId)) {
    throw new Error('这个重复系列已经有一个未完成任务。');
  }
}

function update(state, id, patch, now, newId) {
  assertObject(patch, '任务修改');
  const index = findTask(state, id);
  const before = state.tasks[index];
  if (Object.keys(patch).length === 1 && typeof patch.completed === 'boolean' && patch.completed === Boolean(before.completedAt)) return value(before);
  const task = patchTask(before, patch, now);
  assertReferences(task, state);
  assertSingleSeries(task, state, id);
  let successor = null;
  const newlyCompleted = !before.completedAt && task.completedAt;
  if (newlyCompleted && task.recurrence) {
    const dueDate = nextRepeatDate(task, now);
    if (dueDate) {
      assertCapacity(state);
      successor = validateTask({
        ...task, id: newId(), dueDate, completedAt: null,
        previousId: task.id, reminderSentKey: null, createdAt: now, updatedAt: now,
        subtasks: task.subtasks.map(item => ({ ...item, id: newId(), completed: false })),
      });
    }
  }
  state.tasks[index] = task;
  if (successor) state.tasks.push(successor);
  return { result: task, ...(newlyCompleted ? { undo: { before, after: task, successor } } : {}) };
}

function taxonomyKind(kind) {
  if (!['categories', 'tags'].includes(kind)) throw new Error('分类或标签类型无效。');
  return kind;
}

function upsertTaxonomy(state, kind, input, now, newId) {
  taxonomyKind(kind);
  assertObject(input, '分类或标签');
  const editing = input.id != null;
  const index = editing ? state[kind].findIndex(item => item.id === input.id) : -1;
  if (editing && index < 0) throw new Error('分类或标签已不存在。');
  if (!editing && state[kind].length >= 1000) throw new Error('分类或标签数量已达到上限。');
  const item = validateTaxonomy({ id: editing ? input.id : newId(), name: input.name, color: input.color ?? COLORS[0] });
  if (state[kind].some(other => other.id !== item.id && other.name.toLocaleLowerCase() === item.name.toLocaleLowerCase())) {
    throw new Error('这个名称已经存在。');
  }
  if (editing) state[kind][index] = item;
  else state[kind].push(item);
  return value(item);
}

function removeTaxonomy(state, kind, id, now) {
  taxonomyKind(kind);
  const index = state[kind].findIndex(item => item.id === id);
  if (index < 0) throw new Error('分类或标签已不存在。');
  const removed = state[kind].splice(index, 1)[0];
  for (const task of state.tasks) {
    if (kind === 'categories' && task.categoryId === id) {
      task.categoryId = null;
      task.updatedAt = now;
    }
    if (kind === 'tags' && task.tagIds.includes(id)) {
      task.tagIds = task.tagIds.filter(tag => tag !== id);
      task.updatedAt = now;
    }
  }
  return value(removed);
}

function importData(state, raw) {
  const imported = validateState(raw);
  const maps = {};
  for (const kind of ['categories', 'tags']) {
    maps[kind] = new Map();
    for (const item of imported[kind]) {
      let match = state[kind].find(local => local.id === item.id)
        ?? state[kind].find(local => local.name.toLocaleLowerCase() === item.name.toLocaleLowerCase());
      if (!match) {
        if (state[kind].length >= 1000) throw new Error('导入后的分类或标签数量超过上限。');
        match = { ...item };
        state[kind].push(match);
      }
      maps[kind].set(item.id, match.id);
    }
  }
  const ids = new Set(state.tasks.map(task => task.id));
  const activeSeries = new Set(state.tasks.filter(task => !task.completedAt && task.recurrence).map(task => task.seriesId));
  let added = 0;
  for (const task of imported.tasks) {
    if (ids.has(task.id) || (!task.completedAt && task.recurrence && activeSeries.has(task.seriesId))) continue;
    assertCapacity(state);
    state.tasks.push({
      ...task,
      categoryId: task.categoryId ? maps.categories.get(task.categoryId) : null,
      tagIds: task.tagIds.map(id => maps.tags.get(id)),
    });
    ids.add(task.id);
    if (!task.completedAt && task.recurrence) activeSeries.add(task.seriesId);
    added += 1;
  }
  return value({ imported: added, skipped: imported.tasks.length - added });
}

// The caller runs commands on a private snapshot and commits only after persistence succeeds.
export function applyCommand(state, type, args = {}, now = new Date().toISOString(), newId = () => crypto.randomUUID()) {
  assertObject(args, '操作');
  switch (type) {
    case 'task:add': {
      assertCapacity(state);
      const task = createTask(args.input, now, newId());
      assertReferences(task, state);
      state.tasks.push(task);
      return value(task);
    }
    case 'task:update':
      if (args.expectedUpdatedAt && state.tasks[findTask(state, args.id)].updatedAt !== args.expectedUpdatedAt) {
        throw new Error('任务已在别处修改，请重新载入后编辑。当前草稿仍保留。');
      }
      return update(state, args.id, args.patch, now, newId);
    case 'task:delete':
      return value(state.tasks.splice(findTask(state, args.id), 1)[0]);
    case 'task:restore': {
      assertCapacity(state);
      const task = validateTask(args.task);
      if (state.tasks.some(item => item.id === task.id)) throw new Error('这条任务已经存在。');
      if (!state.categories.some(item => item.id === task.categoryId)) task.categoryId = null;
      task.tagIds = task.tagIds.filter(id => state.tags.some(item => item.id === id));
      assertSingleSeries(task, state);
      state.tasks.push(task);
      return value(task);
    }
    case 'task:undo': {
      const { before, after, successor } = args.undo;
      const index = findTask(state, after.id);
      if (!same(state.tasks[index], after) || (successor && !same(state.tasks.find(task => task.id === successor.id), successor))) {
        throw new Error('任务或下一次安排已经修改，无法直接撤销；现有内容已保留。');
      }
      assertReferences(before, state);
      if (successor) state.tasks.splice(findTask(state, successor.id), 1);
      state.tasks[findTask(state, after.id)] = structuredClone(before);
      return value(before);
    }
    case 'taxonomy:save':
      return upsertTaxonomy(state, args.kind, args.input, now, newId);
    case 'taxonomy:delete':
      return removeTaxonomy(state, args.kind, args.id, now);
    case 'settings:set':
      Object.assign(state.settings, validateSettings(args.patch));
      return value(state.settings);
    case 'data:import':
      return importData(state, args.raw);
    case 'reminders:claim': {
      if (!Array.isArray(args.entries)) throw new Error('提醒列表无效。');
      const keys = new Map(args.entries.map(entry => [entry.id, entry.key]));
      const due = state.tasks.filter(task => {
        const key = reminderKey(task);
        return !task.completedAt && key && keys.get(task.id) === key && task.reminderSentKey !== key && reminderAt(task) <= Date.parse(now);
      });
      for (const task of due) task.reminderSentKey = reminderKey(task);
      return value(due);
    }
    default:
      throw new Error('不支持这个操作。');
  }
}

export class UndoHistory {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.entries = new Map();
  }
  remember(undo) {
    for (const [key, entry] of this.entries) if (entry.expires <= this.clock()) this.entries.delete(key);
    if (!undo) return null;
    const token = crypto.randomUUID();
    this.entries.set(token, { undo: structuredClone(undo), expires: this.clock() + 10000 });
    return token;
  }
  get(token) {
    const entry = this.entries.get(token);
    if (!entry || entry.expires <= this.clock()) {
      this.entries.delete(token);
      throw new Error('撤销已过期，可在已完成列表中重新打开任务。');
    }
    return entry.undo;
  }
  forget(token) { this.entries.delete(token); }
}
