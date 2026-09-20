import { defaultPlacement, validatePlacement } from './window-layout.mjs';
export const SCHEMA_VERSION = 3;
export const MAX_TASKS = 10000;
export const COLORS = ['#32654d', '#4676a9', '#8262ad', '#b9784a', '#b55b7b', '#697781'];
export const REPEAT_LABELS = { daily: '每天', weekdays: '工作日', weekly: '每周', monthly: '每月' };
export const MOTION_STYLES = ['slide', 'fade', 'pop', 'reveal'];
export const DEFAULT_SETTINGS = Object.freeze({
  dockSide: 'right', alwaysOnTop: true, autoCollapse: true, launchAtLogin: false,
  themePreset: 'pine', motionStyle: 'slide', collapsedHandleOpacity: 0.8, panelOpacity: 1, showCompleted: true, calendarView: 'day', windowPlacement: Object.freeze(defaultPlacement()),
});

export function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + '格式不正确。');
}

export function cleanText(value, max, label, required = false) {
  if (typeof value !== 'string') throw new Error(label + '必须是文字。');
  const text = value.trim();
  if (required && !text) throw new Error('请填写' + label + '。');
  if (text.length > max) throw new Error(label + '最多 ' + max + ' 个字符。');
  return text;
}

function identifier(value, label = '编号') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error(label + '格式不正确。');
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(label + '格式不正确。');
  }
  return new Date(value).toISOString();
}

export function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 9999) return false;
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function localDate(date = new Date()) {
  return String(date.getFullYear()).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

export function addDays(value, amount) {
  const [year, month, day] = value.split('-').map(Number);
  return localDate(new Date(year, month - 1, day + amount, 12));
}

export function validateTaxonomy(value) {
  assertObject(value, '分类或标签');
  if (!COLORS.includes(value.color)) throw new Error('请选择有效的颜色。');
  return { id: identifier(value.id), name: cleanText(value.name, 40, '名称', true), color: value.color };
}

function validateRecurrence(value, dueDate) {
  if (value == null) return null;
  assertObject(value, '重复规则');
  if (!Object.hasOwn(REPEAT_LABELS, value.frequency)) throw new Error('重复规则无效。');
  if (!dueDate || !isDateOnly(value.anchorDate)) throw new Error('重复任务需要有效的计划日期。');
  if (value.until != null && (!isDateOnly(value.until) || value.until < dueDate)) throw new Error('结束日期不能早于计划日期。');
  return { frequency: value.frequency, anchorDate: value.anchorDate, until: value.until ?? null };
}

export function validateTask(value) {
  assertObject(value, '任务');
  identifier(value.id, '任务编号');
  if (value.dueDate !== null && !isDateOnly(value.dueDate)) throw new Error('任务日期无效。');
  if (!['normal', 'high'].includes(value.priority)) throw new Error('任务优先级无效。');
  const dueTime = value.dueTime ?? null;
  if (dueTime !== null && (!value.dueDate || typeof dueTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime))) {
    throw new Error('请为任务设置有效的日期和时间。');
  }
  const tagIds = value.tagIds ?? [];
  if (!Array.isArray(tagIds) || tagIds.length > 100 || new Set(tagIds).size !== tagIds.length) throw new Error('任务标签无效。');
  tagIds.forEach(id => identifier(id, '标签编号'));
  const subtasks = value.subtasks ?? [];
  if (!Array.isArray(subtasks) || subtasks.length > 100) throw new Error('每个任务最多支持 100 个子任务。');
  const cleanSubtasks = subtasks.map(item => {
    assertObject(item, '子任务');
    if (typeof item.completed !== 'boolean') throw new Error('子任务完成状态无效。');
    return { id: identifier(item.id, '子任务编号'), title: cleanText(item.title, 160, '子任务名称', true), completed: item.completed };
  });
  if (new Set(cleanSubtasks.map(item => item.id)).size !== cleanSubtasks.length) throw new Error('子任务编号重复。');
  let reminder = null;
  if (value.reminder != null) {
    assertObject(value.reminder, '提醒');
    if (!value.dueDate || !dueTime || ![0, 15, 60].includes(value.reminder.offsetMinutes)) {
      throw new Error('提醒需要明确的日期、时间和有效的提前量。');
    }
    reminder = { offsetMinutes: value.reminder.offsetMinutes };
  }
  const recurrence = validateRecurrence(value.recurrence, value.dueDate);
  const seriesId = value.seriesId == null ? null : identifier(value.seriesId, '重复系列编号');
  if (recurrence && !seriesId) throw new Error('重复任务缺少系列编号。');
  return {
    id: value.id, title: cleanText(value.title, 160, '任务名称', true),
    notes: cleanText(value.notes, 2000, '备注'), dueDate: value.dueDate, dueTime, priority: value.priority,
    categoryId: value.categoryId == null ? null : identifier(value.categoryId, '分类编号'),
    tagIds: [...tagIds], subtasks: cleanSubtasks, reminder,
    reminderSentKey: value.reminderSentKey == null ? null : cleanText(value.reminderSentKey, 250, '提醒记录'),
    recurrence, seriesId, previousId: value.previousId == null ? null : identifier(value.previousId, '上次任务编号'),
    completedAt: value.completedAt === null ? null : timestamp(value.completedAt, '完成时间'),
    createdAt: timestamp(value.createdAt, '创建时间'), updatedAt: timestamp(value.updatedAt, '修改时间'),
  };
}

export function reminderKey(task) {
  return task.reminder && task.dueDate && task.dueTime
    ? [task.id, task.dueDate, task.dueTime, task.reminder.offsetMinutes].join('|') : null;
}

export function reminderAt(task) {
  if (!task.reminder || !task.dueDate || !task.dueTime) return null;
  return new Date(task.dueDate + 'T' + task.dueTime + ':00').getTime() - task.reminder.offsetMinutes * 60000;
}

export function assertFutureReminder(task, now, previous = null) {
  if (task.reminder && !task.completedAt && (!previous || reminderKey(previous) !== reminderKey(task)) && reminderAt(task) <= Date.parse(now)) {
    throw new Error('提醒时间已经过去，请选择未来的日期或时间。');
  }
}

export function createTask(input, now = new Date().toISOString(), id = crypto.randomUUID()) {
  assertObject(input, '任务');
  const recurrence = input.recurrence ? { ...input.recurrence, anchorDate: input.recurrence.anchorDate ?? input.dueDate } : null;
  const task = validateTask({
    id, title: input.title, notes: input.notes ?? '', dueDate: input.dueDate ?? null,
    dueTime: input.dueTime ?? null, priority: input.priority ?? 'normal',
    categoryId: input.categoryId ?? null, tagIds: input.tagIds ?? [], subtasks: input.subtasks ?? [],
    reminder: input.reminder ?? null, reminderSentKey: null, recurrence, seriesId: recurrence ? id : null,
    previousId: null, completedAt: null, createdAt: now, updatedAt: now,
  });
  assertFutureReminder(task, now);
  return task;
}

export function patchTask(task, patch, now = new Date().toISOString()) {
  assertObject(patch, '任务修改');
  const next = { ...task, updatedAt: new Date(Math.max(Date.parse(now), Date.parse(task.updatedAt) + 1)).toISOString() };
  for (const key of ['title', 'notes', 'dueDate', 'dueTime', 'priority', 'categoryId', 'tagIds', 'subtasks', 'reminder', 'recurrence']) {
    if (Object.hasOwn(patch, key)) next[key] = patch[key];
  }
  if (Object.hasOwn(patch, 'recurrence') && patch.recurrence) {
    next.recurrence = {
      ...patch.recurrence,
      anchorDate: patch.recurrence.anchorDate ?? (task.recurrence?.frequency === patch.recurrence.frequency ? task.recurrence.anchorDate : next.dueDate),
    };
    next.seriesId ??= task.id;
  }
  if (!next.recurrence && !task.completedAt) next.seriesId = null;
  if (Object.hasOwn(patch, 'completed')) {
    if (typeof patch.completed !== 'boolean') throw new Error('完成状态无效。');
    next.completedAt = patch.completed ? (task.completedAt ?? now) : null;
    if (patch.completed) next.subtasks = next.subtasks.map(item => ({ ...item, completed: true }));
    else if (task.completedAt && task.seriesId) {
      next.recurrence = null;
      next.seriesId = null;
      next.previousId = null;
    }
  }
  if (reminderKey(next) !== reminderKey(task)) next.reminderSentKey = null;
  const valid = validateTask(next);
  assertFutureReminder(valid, now, task);
  return valid;
}

export function nextRepeatDate(task, now = new Date()) {
  const rule = task.recurrence;
  if (!rule || !task.dueDate) return null;
  const after = [task.dueDate, localDate(new Date(now))].sort().at(-1);
  let candidate = addDays(after, 1);
  if (rule.frequency === 'weekdays') {
    while (isDateOnly(candidate) && [0, 6].includes(new Date(candidate + 'T12:00:00').getDay())) candidate = addDays(candidate, 1);
  } else if (rule.frequency === 'weekly') {
    const weekday = new Date(rule.anchorDate + 'T12:00:00').getDay();
    while (isDateOnly(candidate) && new Date(candidate + 'T12:00:00').getDay() !== weekday) candidate = addDays(candidate, 1);
  } else if (rule.frequency === 'monthly') {
    const anchorDay = Number(rule.anchorDate.slice(-2));
    let [year, month] = after.split('-').map(Number);
    const inMonth = () => localDate(new Date(year, month - 1, Math.min(anchorDay, new Date(year, month, 0, 12).getDate()), 12));
    candidate = inMonth();
    if (candidate <= after) {
      month += 1;
      if (month > 12) { month = 1; year += 1; }
      candidate = inMonth();
    }
  }
  if (!isDateOnly(candidate) || (rule.until && candidate > rule.until)) return null;
  return candidate;
}

export function validateSettings(patch) {
  assertObject(patch, '设置');
  const result = {};
  if (Object.hasOwn(patch, 'dockSide')) {
    if (!['left', 'right'].includes(patch.dockSide)) throw new Error('停靠方向无效。');
    result.dockSide = patch.dockSide;
    if (!Object.hasOwn(patch, 'windowPlacement')) result.windowPlacement = { ...defaultPlacement(), edge: patch.dockSide };
  }
  if (Object.hasOwn(patch, 'themePreset')) {
    if (!['pine', 'mist', 'sand', 'graphite', 'system'].includes(patch.themePreset)) throw new Error('主题无效。');
    result.themePreset = patch.themePreset;
  }
  if (Object.hasOwn(patch, 'motionStyle')) {
    if (!MOTION_STYLES.includes(patch.motionStyle)) throw new Error('展开方式无效。');
    result.motionStyle = patch.motionStyle;
  }
  if (Object.hasOwn(patch, 'collapsedHandleOpacity')) {
    if (!Number.isFinite(patch.collapsedHandleOpacity) || patch.collapsedHandleOpacity < 0.2 || patch.collapsedHandleOpacity > 1) throw new Error('收起图标透明度无效。');
    result.collapsedHandleOpacity = patch.collapsedHandleOpacity;
  }
  if (Object.hasOwn(patch, 'panelOpacity')) {
    if (!Number.isFinite(patch.panelOpacity) || patch.panelOpacity < 0.2 || patch.panelOpacity > 1) throw new Error('面板透明度无效。');
    result.panelOpacity = patch.panelOpacity;
  }
  if (Object.hasOwn(patch, 'calendarView')) {
    if (!['day', 'week', 'month'].includes(patch.calendarView)) throw new Error('日历视图无效。');
    result.calendarView = patch.calendarView;
  }
  if (Object.hasOwn(patch, 'windowPlacement')) result.windowPlacement = validatePlacement(patch.windowPlacement);
  for (const key of ['alwaysOnTop', 'autoCollapse', 'launchAtLogin', 'showCompleted']) {
    if (Object.hasOwn(patch, key)) {
      if (typeof patch[key] !== 'boolean') throw new Error('设置值无效。');
      result[key] = patch[key];
    }
  }
  return result;
}

export function emptyState() {
  return { version: SCHEMA_VERSION, tasks: [], categories: [], tags: [], settings: structuredClone(DEFAULT_SETTINGS) };
}

export function assertReferences(task, state) {
  if (task.categoryId && !state.categories.some(item => item.id === task.categoryId)) throw new Error('分类已不存在，请重新选择。');
  if (task.tagIds.some(id => !state.tags.some(item => item.id === id))) throw new Error('标签已不存在，请重新选择。');
}

export function validateState(value) {
  assertObject(value, '数据文件');
  if (![1, 2, SCHEMA_VERSION].includes(value.version)) {
    throw Object.assign(new Error('不支持这个数据版本，请使用匹配的侧记版本或兼容的备份。'), { code: 'UNSUPPORTED_VERSION' });
  }
  if (!Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) throw new Error('任务列表无效，最多支持 ' + MAX_TASKS + ' 条任务。');
  const state = emptyState();
  for (const kind of ['categories', 'tags']) {
    const items = value.version === 1 ? [] : value[kind] ?? [];
    if (!Array.isArray(items) || items.length > 1000) throw new Error('分类或标签列表无效，最多支持 1000 项。');
    state[kind] = items.map(validateTaxonomy);
    if (new Set(state[kind].map(item => item.id)).size !== items.length ||
        new Set(state[kind].map(item => item.name.toLocaleLowerCase())).size !== items.length) throw new Error('分类或标签的编号、名称不能重复。');
  }
  state.tasks = value.tasks.map(task => {
    assertObject(task, '任务');
    return validateTask(value.version === 1 ? {
      id: task.id, title: task.title, notes: task.notes, dueDate: task.dueDate, priority: task.priority,
      completedAt: task.completedAt, createdAt: task.createdAt, updatedAt: task.updatedAt,
    } : task);
  });
  if (new Set(state.tasks.map(task => task.id)).size !== state.tasks.length) throw new Error('备份中存在重复的任务编号。');
  const activeSeries = new Set();
  for (const task of state.tasks) {
    assertReferences(task, state);
    if (!task.completedAt && task.recurrence) {
      if (activeSeries.has(task.seriesId)) throw new Error('同一重复系列只能有一个未完成任务。');
      activeSeries.add(task.seriesId);
    }
  }
  state.settings = { ...structuredClone(DEFAULT_SETTINGS), ...validateSettings(value.settings ?? {}) };
  return state;
}

export function describeDate(value, today = localDate()) {
  if (!value) return { label: '未安排', tone: 'muted' };
  if (value === today) return { label: '今天', tone: 'today' };
  if (value === addDays(today, 1)) return { label: '明天', tone: 'muted' };
  if (value < today) {
    const dayNumber = date => Date.UTC(...date.split('-').map((number, index) => Number(number) - (index === 1 ? 1 : 0)));
    return { label: '逾期 ' + Math.round((dayNumber(today) - dayNumber(value)) / 86400000) + ' 天', tone: 'overdue' };
  }
  const [year, month, day] = value.split('-').map(Number);
  return { label: (year !== Number(today.slice(0, 4)) ? year + '年' : '') + month + '月' + day + '日', tone: 'muted' };
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
export function formatPeriod(view, anchor, selected, today = localDate()) {
  const parts = value => value.split('-').map(Number);
  const [year, month, day] = parts(view === 'day' ? selected : anchor);
  const thisYear = year === Number(today.slice(0, 4));
  if (view === 'month') return year + '年' + month + '月';
  if (view === 'day') {
    const weekday = '周' + WEEKDAYS[new Date(year, month - 1, day, 12).getDay()];
    return (thisYear ? '' : year + '年') + month + '月' + day + '日 ' + weekday;
  }
  const start = addDays(anchor, -((new Date(anchor + 'T12:00:00').getDay() + 6) % 7));
  const end = addDays(start, 6);
  const [startYear, startMonth, startDay] = parts(start);
  const [endYear, endMonth, endDay] = parts(end);
  const sameYear = startYear === endYear;
  const head = (sameYear && startYear === Number(today.slice(0, 4)) ? '' : startYear + '年') + startMonth + '月' + startDay + '日';
  const tail = (sameYear ? '' : endYear + '年') + (startMonth === endMonth && sameYear ? '' : endMonth + '月') + endDay + '日';
  return head + ' – ' + tail;
}

export function matchesFilters(task, { categoryId, tagIds = [], search = '', categories = [], tags = [], taskIds } = {}) {
  if (categoryId !== undefined && task.categoryId !== categoryId) return false;
  if (tagIds.some(id => !task.tagIds.includes(id))) return false;
  if (taskIds && !taskIds.includes(task.id)) return false;
  const query = search.trim().toLocaleLowerCase();
  if (!query) return true;
  const text = [task.title, task.notes, ...task.subtasks.map(item => item.title),
    categories.find(item => item.id === task.categoryId)?.name ?? '',
    ...tags.filter(item => task.tagIds.includes(item.id)).map(item => item.name)].join('\n').toLocaleLowerCase();
  return text.includes(query);
}

export function taskCounts(tasks, today = localDate(), filters = {}) {
  const matching = tasks.filter(task => matchesFilters(task, filters));
  const active = matching.filter(task => !task.completedAt);
  const doneToday = matching.filter(task => task.completedAt && localDate(new Date(task.completedAt)) === today).length;
  const todayCount = active.filter(task => task.dueDate && task.dueDate <= today).length;
  return { today: todayCount, planned: active.filter(task => task.dueDate > today).length,
    all: active.length, completed: matching.length - active.length, doneToday, totalToday: todayCount + doneToday };
}

export function selectTasks(tasks, options = {}) {
  const { view = 'today', today = localDate(), sort = 'priority' } = options;
  const group = task => !task.dueDate ? 3 : task.dueDate < today ? 0 : task.dueDate === today ? 1 : 2;
  return tasks.filter(task => {
    if (view === 'completed' ? !task.completedAt : !options.includeCompleted && Boolean(task.completedAt)) return false;
    if (view === 'today' && (!task.dueDate || task.dueDate > today)) return false;
    if (view === 'planned' && (!task.dueDate || task.dueDate <= today)) return false;
    return matchesFilters(task, options);
  }).sort((a, b) => {
    if (view === 'completed') return b.completedAt.localeCompare(a.completedAt) || a.id.localeCompare(b.id);
    const byStatus = Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt));
    if (byStatus) return byStatus;
    if (a.completedAt && b.completedAt) return b.completedAt.localeCompare(a.completedAt) || a.id.localeCompare(b.id);
    const byGroup = group(a) - group(b);
    const byDate = (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31');
    if (byGroup || (group(a) === 2 && byDate)) return byGroup || byDate;
    if (sort === 'created') return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
    const byPriority = Number(b.priority === 'high') - Number(a.priority === 'high');
    const byTime = byDate || (a.dueTime ?? '99:99').localeCompare(b.dueTime ?? '99:99');
    return (sort === 'time' ? byTime || byPriority : byPriority || byTime) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
}

export function groupTasks(tasks, view, today = localDate()) {
  const groups = new Map();
  for (const task of tasks) {
    const label = view === 'completed' || task.completedAt ? '已完成' : !task.dueDate ? '未安排'
      : task.dueDate < today ? '逾期' : task.dueDate === today ? '今天' : describeDate(task.dueDate, today).label;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(task);
  }
  return [...groups].map(([label, items]) => ({ label, tasks: items }));
}
