import { addDays, describeDate, emptyState, groupTasks, localDate, REPEAT_LABELS, selectTasks, taskCounts } from './domain.mjs';
import { createBrowserBridge } from './browser-bridge.mjs';
import { createTauriBridge } from './tauri-bridge.mjs';
import { bindWindowGestures } from './window-gestures.mjs';
import { calendarRange, shiftPeriod, periodSelection, CALENDAR_VIEWS } from './calendar.mjs';
import { CalendarProjection, calendarGrid } from './calendar-ui.mjs';
import { applyTheme, THEME_NAMES } from './themes.mjs';
import { SidebarMotion } from './motion.mjs';
import { TaskEditor } from './editor.mjs';
import { TaxonomyManager } from './taxonomy.mjs';
import { $, $$, el, icon, button, colorDot, options, message, toast, hideToast, bindToasts, Popovers } from './ui.mjs';

let api, editor, manager, motion, popovers;
let state = emptyState();
let info = {};
let view = 'day';
let today = localDate();
let selectedDate = today, anchorDate = today, projection, previewSource, dayDialogDate;
let composerDateExplicit = false;
let followToday = true;
let pendingMutations = 0;
let searchScope = 'view', includeCompleted = false;
const columnLimits = new Map();
let composer = { dueDate: today, categoryId: null, tagIds: [], priority: 'normal' };
let filters = { categoryId: undefined, tagIds: [], search: '', sort: 'priority', taskIds: undefined };
let renderLimit = 100;
let adding = false;
let savingSettings = false;
let settingsDraft = null;
let transferring = false;
let composing = false;
let interactionActive = null;
let dueTarget = null;
let ready = false;
let pendingWindow;
let pendingState;
let pendingFocus = false;
const earlyActions = [];
const taskLocks = new Set();
const openSubtasks = new Set();
const getTask = id => state.tasks.find(task => task.id === id);
const selectionOptions = () => ({ ...filters, today, view, categories: state.categories, tags: state.tags });

function saveStatus(status) {
  const text = status === 'saving' ? '正在保存…' : status === 'error' ? '保存失败，请重试'
    : info.runtime === 'browser' ? '已保存到浏览器' : '已保存到本机';
  $('save-indicator').dataset.status = status;
  $('save-indicator').title = text;
  $('save-label').textContent = text;
}

function reportError(error, target) {
  const text = error.message || '操作失败，请重试。';
  saveStatus('error');
  if (target) message(target, text, true);
  else toast(text, null, '', 12000);
}

async function mutate(operation, target) {
  pendingMutations++; updateInteraction();
  saveStatus('saving');
  try {
    const response = await operation();
    if (response.state) { state = response.state; render(); }
    saveStatus('saved');
    return response;
  } catch (error) { reportError(error, target); throw error; }
  finally { pendingMutations--; updateInteraction(); }
}

function updateInteraction() {
  if (!api) return;
  const panelBounds = $('panel').getBoundingClientRect();
  for (const dialog of $$('dialog[open]')) {
    const box = dialog.getBoundingClientRect();
    dialog.style.transform = 'none';
    dialog.style.left = Math.max(8, Math.min(innerWidth - box.width - 8, panelBounds.x + (panelBounds.width - box.width) / 2)) + 'px';
    dialog.style.top = Math.max(8, Math.min(innerHeight - box.height - 8, panelBounds.y + (panelBounds.height - box.height) / 2)) + 'px';
  }
  const active = Boolean(pendingMutations || adding || savingSettings || transferring || editor?.dirty || editor?.busy || composing || popovers?.active || $$('dialog[open]').length || $('task-title').value.trim());
  if (active !== interactionActive) {
    interactionActive = active;
    api.setInteractionActive(active).catch(() => {});
  }
}

function openDialog(id) {
  popovers.close();
  if (!$(id).open) $(id).showModal();
  updateInteraction();
}

function renderWindow(value) {
  if (!value.expanded) {
    popovers?.close();
    $$('dialog[open]').forEach(dialog => dialog.close());
  }
  motion.render(value);
}

function syncComposerDate() {
  if (!$('task-title').value.trim() && !composerDateExplicit && !editor?.dirty) composer.dueDate = selectedDate;
}
function setView(next) {
  if (editor?.isOpen) { editor.leave(() => { editor.close(); setView(next); }); return; }
  view = next;
  if (CALENDAR_VIEWS.includes(view)) {
    anchorDate = selectedDate;
    if (state.settings.calendarView !== view) void api.setSettings({ calendarView: view }).catch(reportError);
  }
  popovers?.close();
  void api.setLayout(CALENDAR_VIEWS.includes(view) ? view : 'list').catch(reportError);
  renderLimit = 100; columnLimits.clear();
  $('task-scroll').scrollTop = 0;
  syncComposerDate();
  render();
}
function chooseCalendarDate(date) {
  followToday = false;
  selectedDate = date;
  syncComposerDate(); render();
}
function resetComposer() {
  composerDateExplicit = false;
  composer.priority = 'normal';
  syncComposerDate(); inheritFilters();
}
function matchingTasks() {
  const global = !$('search-box').hidden && searchScope === 'all';
  const options = { ...selectionOptions(), view: !global && view === 'completed' ? 'completed' : 'all' };
  let tasks = selectTasks(state.tasks, options);
  if (includeCompleted && !$('search-box').hidden && options.view !== 'completed') tasks = tasks.concat(selectTasks(state.tasks, { ...options, view: 'completed' }));
  return tasks;
}
function visibleTasks() {
  const tasks = matchingTasks();
  if (!$('search-box').hidden && searchScope === 'all') return tasks;
  if (view === 'overdue') return tasks.filter(task => task.dueDate && task.dueDate < today);
  if (view === 'unscheduled') return tasks.filter(task => !task.dueDate);
  if (!CALENDAR_VIEWS.includes(view)) return tasks;
  const range = calendarRange(view, view === 'day' ? selectedDate : anchorDate);
  return tasks.filter(task => task.dueDate && task.dueDate >= range.start && task.dueDate <= range.end);
}
function visiblePreviews() {
  const ids = new Set(matchingTasks().map(task => task.id));
  return (projection?.previews ?? []).filter(item => ids.has(item.sourceTaskId));
}
function openPreview(item) {
  const task = getTask(item.sourceTaskId);
  if (!task) return;
  previewSource = task.id;
  $('preview-title').textContent = task.title;
  $('preview-date').textContent = '预计日期：' + item.date;
  $('preview-rule').textContent = '重复频率：' + REPEAT_LABELS[task.recurrence.frequency];
  openDialog('preview-dialog');
}
function previewRow(item) {
  const task = getTask(item.sourceTaskId);
  const row = button('预览：' + task.title + '，' + item.date, 'preview-row', () => openPreview(item));
  row.replaceChildren(el('span', 'preview-badge', '预计'), el('span', '', task.title), el('span', 'preview-time', task.dueTime ?? ''));
  return row;
}
function renderDayDialog() {
  if (!$('day-dialog').open) return;
  $('day-heading').textContent = dayDialogDate + ' 的安排';
  const tasks = matchingTasks().filter(task => task.dueDate === dayDialogDate);
  const previews = visiblePreviews().filter(item => item.date === dayDialogDate);
  $('day-tasks').replaceChildren(...tasks.slice(0, renderLimit).map(taskRow), ...previews.slice(0, renderLimit).map(previewRow));
  if (tasks.length > renderLimit || previews.length > renderLimit) $('day-tasks').append(button('显示更多', 'text-button', () => { renderLimit += 100; renderDayDialog(); }));
}
function openDay(date) { dayDialogDate = date; openDialog('day-dialog'); renderDayDialog(); }
function addAt(date) {
  const open = () => {
    if ($('task-title').value.trim()) { chooseCalendarDate(date); focusComposer(); toast('已保留正在输入的任务；请先完成当前草稿。'); return; }
    followToday = false; selectedDate = date; composerDateExplicit = false; syncComposerDate();
    editor.open(null, { ...composer, dueDate: date });
  };
  editor.isOpen ? editor.leave(open) : open();
}

function inheritFilters() {
  if ($('task-title').value.trim() || editor?.dirty) return;
  composer.categoryId = filters.categoryId ?? null;
  composer.tagIds = [...filters.tagIds];
}

function clearFilters() {
  filters = { categoryId: undefined, tagIds: [], search: '', sort: filters.sort, taskIds: undefined };
  $('search-input').value = '';
  inheritFilters();
  renderLimit = 100;
  render();
}

function ensureVisible(task) {
  if (visibleTasks().some(item => item.id === task.id)) return false;
  toast('已保存到' + (task.completedAt ? '已完成' : task.dueDate ? task.dueDate : '未安排'), () => {
    clearFilters();
    if (task.dueDate) { selectedDate = anchorDate = task.dueDate; followToday = false; }
    setView(task.completedAt ? 'completed' : task.dueDate ? 'day' : 'unscheduled');
  }, '查看');
  return true;
}

function focusComposer() {
  const focus = () => {
    if (editor.isOpen) editor.close();
    if (document.body.dataset.expanded !== 'true') { pendingFocus = true; api.toggle().catch(reportError); return; }
    $('task-title').focus();
  };
  editor.isOpen ? editor.leave(focus) : focus();
}

function completionToast(response) {
  const successor = state.tasks.find(task => task.previousId === response.result.id && !task.completedAt);
  const text = successor ? '已完成 · 下次安排在' + describeDate(successor.dueDate, today).label : '已完成';
  toast(text, response.undoToken ? async () => {
    await mutate(() => api.undoCompletion(response.undoToken));
    toast('已撤销完成');
  } : null);
}

function deletionToast(response) {
  toast('任务已删除', async () => {
    const restored = await mutate(() => api.restoreTask(response.result));
    ensureVisible(restored.result);
    toast('任务已恢复');
  });
}

async function toggleTask(task) {
  if (taskLocks.has(task.id)) return;
  taskLocks.add(task.id);
  renderTasks();
  try {
    const response = await mutate(() => api.updateTask(task.id, { completed: !task.completedAt }, task.updatedAt));
    if (task.completedAt) toast(task.seriesId ? '已作为普通任务重新打开' : '已放回待办');
    else completionToast(response);
  } catch { /* Keep the current saved state. */ }
  finally { taskLocks.delete(task.id); renderTasks(); }
}

async function patchRow(task, patch) {
  if (taskLocks.has(task.id)) return;
  taskLocks.add(task.id);
  renderTasks();
  try { await mutate(() => api.updateTask(task.id, patch, task.updatedAt)); }
  catch { /* Already reported. */ }
  finally { taskLocks.delete(task.id); renderTasks(); }
}

function openDate(task, trigger) {
  dueTarget = task?.id ?? null;
  $('composer-date').value = task?.dueDate ?? composer.dueDate ?? '';
  const presets = { today, tomorrow: addDays(today, 1), 'next-week': addDays(today, 7), none: '' };
  $$('#due-popover [data-date]').forEach(button => {
    button.setAttribute('aria-pressed', String(presets[button.dataset.date] === $('composer-date').value));
  });
  $('due-heading').textContent = task ? '调整计划日期' : '安排日期';
  message('date-message');
  popovers.open('due-popover', trigger);
}

async function chooseDate(date) {
  if (!dueTarget) {
    composer.dueDate = date;
    composerDateExplicit = true;
    popovers.close();
    renderComposer();
    $('task-title').focus();
    return;
  }
  const task = getTask(dueTarget);
  if (!task) { popovers.close(); return; }
  if (!date && task.recurrence) {
    message('date-message', '重复任务需要日期，请在任务详情中先关闭重复。', true);
    return;
  }
  const patch = { dueDate: date, ...(!date ? { dueTime: null, reminder: null } : {}) };
  try {
    await mutate(() => api.updateTask(task.id, patch, task.updatedAt), 'date-message');
    popovers.close();
    toast('已调整日期');
  } catch { /* Keep date choices visible for correction. */ }
}

function taskMenu(task, trigger) {
  let menu = $('task-menu');
  if (!menu) { menu = el('div', 'popover task-menu'); menu.id = 'task-menu'; menu.hidden = true; document.body.append(menu); }
  const act = action => () => { popovers.close(); action(); };
  menu.replaceChildren(
    button('编辑详情', '', act(() => editor.open(getTask(task.id))), 'note'),
    button('调整日期', '', act(() => openDate(getTask(task.id), trigger)), 'calendar'),
    button(task.priority === 'high' ? '取消重要标记' : '标记为重要', '', act(() => { void patchRow(getTask(task.id), { priority: task.priority === 'high' ? 'normal' : 'high' }); }), 'flag'),
    button(task.recurrence && !task.completedAt ? '删除并停止重复' : '删除任务', 'danger', act(async () => {
      try { deletionToast(await mutate(() => api.deleteTask(task.id))); } catch { /* Already reported. */ }
    }), 'trash'),
  );
  for (const item of menu.children) item.append(document.createTextNode(item.getAttribute('aria-label')));
  popovers.open('task-menu', trigger);
}

function taskRow(task) {
  const row = el('article', 'task-row' + (task.completedAt ? ' is-completed' : '') + (task.priority === 'high' ? ' is-important' : ''));
  row.dataset.taskId = task.id;
  const checkbox = button((task.completedAt ? '重新打开：' : '完成：') + task.title, 'task-checkbox', () => { void toggleTask(task); }, 'check');
  checkbox.setAttribute('role', 'checkbox');
  checkbox.setAttribute('aria-checked', String(Boolean(task.completedAt)));
  checkbox.dataset.action = 'complete';
  checkbox.dataset.taskId = task.id;
  checkbox.disabled = taskLocks.has(task.id);
  if (task.completedAt && task.seriesId) checkbox.title = '作为普通任务重新打开，原重复计划继续';
  const body = el('div', 'task-body');
  const title = button('编辑：' + task.title, 'task-title-button', () => editor.open(getTask(task.id)));
  title.replaceChildren(el('span', 'task-title', task.title));
  title.title = task.title;
  title.dataset.action = 'edit';
  title.dataset.taskId = task.id;
  const meta = el('div', 'task-meta');
  const due = describeDate(task.dueDate, today);
  const dateText = task.completedAt ? (localDate(new Date(task.completedAt)) === today ? '今天完成' : localDate(new Date(task.completedAt)).slice(5).replace('-', '/') + ' 完成')
    : due.label + (task.dueTime ? ' ' + task.dueTime : '');
  const date = button('调整日期：' + task.title, 'task-date ' + (task.completedAt ? 'muted' : due.tone), () => openDate(task, date));
  date.replaceChildren(icon(task.completedAt ? 'check' : 'calendar'), document.createTextNode(dateText));
  date.dataset.action = 'date';
  date.dataset.taskId = task.id;
  date.disabled = Boolean(task.completedAt);
  meta.append(date);
  const category = state.categories.find(item => item.id === task.categoryId);
  if (category) {
    const label = el('span', 'task-category');
    label.title = category.name;
    label.append(colorDot(category.color), document.createTextNode(category.name));
    meta.append(label);
  }
  if (task.subtasks.length) {
    const progress = task.subtasks.filter(item => item.completed).length + '/' + task.subtasks.length;
    const toggle = button('子任务：' + task.title + '（' + progress + '）', 'subtask-toggle', () => {
      openSubtasks.has(task.id) ? openSubtasks.delete(task.id) : openSubtasks.add(task.id);
      renderTasks();
    });
    toggle.replaceChildren(icon('list'), document.createTextNode(progress));
    toggle.setAttribute('aria-expanded', String(openSubtasks.has(task.id)));
    toggle.dataset.action = 'subtasks';
    toggle.dataset.taskId = task.id;
    meta.append(toggle);
  }
  for (const [enabled, symbol, label, className] of [
    [task.priority === 'high', 'flag', '重要', 'priority-label'],
    [task.recurrence, 'repeat', task.recurrence ? REPEAT_LABELS[task.recurrence.frequency] : '', 'repeat-label'],
    [task.reminder, 'bell', '已设提醒', 'reminder-label'],
    [task.notes, 'note', '有备注', 'note-label'],
  ]) {
    if (!enabled) continue;
    const marker = el('span', className);
    marker.title = label;
    marker.append(icon(symbol), el('span', 'sr-only', label));
    meta.append(marker);
  }
  const tags = state.tags.filter(tag => task.tagIds.includes(tag.id));
  for (const tag of tags.slice(0, 2)) {
    const label = el('span', 'task-tag', '#' + tag.name);
    label.title = tag.name;
    meta.append(label);
  }
  if (tags.length > 2) {
    const overflow = el('span', 'tag-overflow', '+' + (tags.length - 2));
    overflow.title = tags.slice(2).map(tag => tag.name).join('、');
    meta.append(overflow);
  }
  body.append(title, meta);
  const more = button('更多操作：' + task.title, 'icon-button task-more', () => taskMenu(task, more), 'more');
  more.dataset.action = 'more';
  more.dataset.taskId = task.id;
  row.append(checkbox, body, more);
  if (openSubtasks.has(task.id)) {
    const children = el('div', 'task-subtasks');
    for (const item of task.subtasks) {
      const label = el('label', 'inline-subtask' + (item.completed ? ' is-completed' : ''));
      const input = el('input');
      input.type = 'checkbox';
      input.checked = item.completed;
      input.disabled = Boolean(task.completedAt) || taskLocks.has(task.id);
      input.setAttribute('aria-label', '子任务：' + item.title);
      input.dataset.taskId = task.id;
      input.dataset.action = 'child-' + item.id;
      input.addEventListener('change', () => {
        void patchRow(task, { subtasks: task.subtasks.map(child => child.id === item.id ? { ...child, completed: input.checked } : child) });
      });
      label.append(input, el('span', '', item.title));
      children.append(label);
    }
    row.append(children);
  }
  return row;
}

function renderTasks() {
  const focused = document.activeElement?.closest('#task-list [data-action]');
  const focusTask = focused?.dataset.taskId, focusAction = focused?.dataset.action;
  const tasks = visibleTasks();
  const global = !$('search-box').hidden && searchScope === 'all';
  const calendar = CALENDAR_VIEWS.includes(view) && !global;
  const range = calendar ? calendarRange(view, view === 'day' ? selectedDate : anchorDate) : null;
  if (range) projection?.schedule(state.tasks, range, today);
  const previews = calendar ? visiblePreviews() : [];
  const grid = calendar && view !== 'day';
  $('task-list').classList.toggle('has-calendar', grid);
  $('task-scroll').classList.toggle('calendar-scroll', grid);
  const fragment = document.createDocumentFragment();
  if (grid) {
    fragment.append(calendarGrid({ view, range, anchor: anchorDate, selected: selectedDate, today, tasks, previews,
      getTask, selectDate: chooseCalendarDate, edit: task => editor.open(task), toggle: task => { void toggleTask(task); },
      preview: openPreview, openDay, addAt, limits: columnLimits, loadMore: date => { columnLimits.set(date, (columnLimits.get(date) ?? 50) + 50); renderTasks(); } }));
  } else {
    const shown = tasks.slice(0, renderLimit);
    const groups = groupTasks(shown, view === 'completed' ? 'completed' : 'all', today);
    for (const group of groups) {
      const section = el('section', 'task-group');
      const title = calendar ? (selectedDate === today ? '今天' : selectedDate) : group.label;
      const heading = el('h2', 'group-heading' + (title === '逾期' ? ' overdue' : ''), title);
      const count = calendar ? tasks.length : groupTasks(tasks, view === 'completed' ? 'completed' : 'all', today).find(item => item.label === group.label)?.tasks.length;
      heading.append(el('span', '', String(count ?? group.tasks.length)));
      section.append(heading, ...group.tasks.map(taskRow)); fragment.append(section);
    }
    if (tasks.length > renderLimit) fragment.append(button('显示更多 · 还有 ' + (tasks.length - renderLimit) + ' 件', 'text-button load-more', () => { renderLimit += 100; renderTasks(); }));
    if (previews.length) {
      const group = el('section', 'task-group'); group.append(el('h2', 'group-heading', '重复计划预览'), ...previews.slice(0, renderLimit).map(previewRow));
      if (previews.length > renderLimit) group.append(button('显示更多预览', 'text-button', () => { renderLimit += 100; renderTasks(); }));
      fragment.append(group);
    }
  }
  $('task-list').replaceChildren(fragment);
  $('task-list').setAttribute('aria-labelledby', CALENDAR_VIEWS.includes(view) ? 'tab-' + view : 'more-views-trigger');
  $('empty-state').hidden = grid || tasks.length > 0 || previews.length > 0;
  const filtered = filters.categoryId !== undefined || filters.tagIds.length || filters.search || filters.taskIds;
  const completedOnDay = state.tasks.filter(task => task.completedAt && localDate(new Date(task.completedAt)) === selectedDate).length;
  $('empty-title').textContent = filtered ? '没有匹配的任务' : view === 'completed' ? '还没有完成记录' : !state.tasks.length ? '还没有任务' : view === 'day' ? (completedOnDay ? '当天已完成 ' + completedOnDay + ' 项' : selectedDate === today ? '今天还没有安排' : '当天还没有安排') : view === 'overdue' ? '没有逾期任务' : view === 'unscheduled' ? '没有未安排的任务' : '任务已处理完';
  $('empty-copy').textContent = filtered ? '调整筛选条件，或扩大搜索范围。' : view === 'completed' ? '完成的任务会保留在这里。' : '记下一件要做的事，随时安排。';
  $('empty-action').textContent = filters.search && searchScope === 'view' ? '搜索全部待办' : filtered ? '清除筛选' : view === 'completed' ? '查看待办' : '添加任务';
  $('projection-status').textContent = calendar && projection?.loading ? '更新重复计划…' : '';
  renderDayDialog();
  if (focusTask && !editor.isOpen) {
    const target = $('task-list').querySelector('[data-task-id="' + CSS.escape(focusTask) + '"][data-action="' + CSS.escape(focusAction) + '"]');
    (target && !target.disabled ? target : $('task-list').querySelector('.task-checkbox:not(:disabled)') ?? $('task-title')).focus({ preventScroll: true });
  }
}

function renderTagChoices(id, selected, change) {
  const activeTag = $(id).contains(document.activeElement) ? document.activeElement.dataset.tagId : null;
  const fragment = document.createDocumentFragment();
  for (const tag of state.tags) {
    const label = el('label', 'check-option');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = selected.includes(tag.id);
    input.dataset.tagId = tag.id;
    input.addEventListener('change', () => change(tag.id, input.checked));
    label.append(input, colorDot(tag.color), document.createTextNode(tag.name));
    fragment.append(label);
  }
  if (!state.tags.length) fragment.append(el('p', 'field-help', '还没有标签，可在「管理分类与标签」中创建。'));
  $(id).replaceChildren(fragment);
  if (activeTag) $(id).querySelector('[data-tag-id="' + CSS.escape(activeTag) + '"]')?.focus({ preventScroll: true });
}

function renderComposer() {
  $('composer-date-label').textContent = describeDate(composer.dueDate, today).label;
  $('due-trigger').dataset.active = String(Boolean(composer.dueDate));
  $('priority-trigger').setAttribute('aria-pressed', String(composer.priority === 'high'));
  options($('composer-category'), state.categories, composer.categoryId ?? 'none', [{ value: 'none', label: '未分类' }]);
  $('composer-tags-label').textContent = composer.tagIds.length ? state.tags.filter(tag => composer.tagIds.includes(tag.id)).map(tag => tag.name).join('、') : '标签';
  $('composer-tags-trigger').dataset.active = String(composer.tagIds.length > 0);
  $('add-task').disabled = adding || !$('task-title').value.trim();
  for (const id of ['task-title', 'due-trigger', 'priority-trigger', 'composer-category', 'composer-tags-trigger', 'composer-detail']) $(id).disabled = adding;
}

function renderSettings() {
  const settings = { ...state.settings, ...settingsDraft };
  applyTheme(settings.themePreset);
  const transparency = Math.round((1 - settings.collapsedHandleOpacity) * 100);
  document.documentElement.style.setProperty('--collapsed-handle-opacity', String(settings.collapsedHandleOpacity));
  $('setting-handle-transparency').value = String(transparency);
  $('setting-handle-transparency').setAttribute('aria-valuetext', transparency + '% 透明');
  $('setting-handle-transparency').disabled = savingSettings;
  $('handle-transparency-value').textContent = transparency + '%';
  for (const [id, key] of [['setting-pin', 'alwaysOnTop'], ['setting-collapse', 'autoCollapse'], ['setting-startup', 'launchAtLogin']]) {
    $(id).checked = settings[key];
    $(id).disabled = savingSettings || (key === 'launchAtLogin' && !info.canLaunchAtLogin);
  }
  if (!info.canLaunchAtLogin) $('startup-help').textContent = '在 Windows 安装版或便携版中启用';
  $$('[data-theme-choice]').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.themeChoice === settings.themePreset)); button.disabled = savingSettings; });
  $('app-version').textContent = info.version;
  $('data-folder').hidden = !info.canOpenDataFolder;
  $('export-data').disabled = transferring;
  $('import-data').disabled = transferring;
}

function render() {
  if (!ready) return;
  if (filters.categoryId && !state.categories.some(item => item.id === filters.categoryId)) filters.categoryId = undefined;
  if (composer.categoryId && !state.categories.some(item => item.id === composer.categoryId)) composer.categoryId = null;
  filters.tagIds = filters.tagIds.filter(id => state.tags.some(item => item.id === id));
  composer.tagIds = composer.tagIds.filter(id => state.tags.some(item => item.id === id));
  applyTheme(settingsDraft?.themePreset ?? state.settings.themePreset);
  const counts = taskCounts(state.tasks, today, selectionOptions());
  const pendingMatches = selectTasks(state.tasks, { ...selectionOptions(), view: 'all' });
  for (const mode of CALENDAR_VIEWS) {
    const range = calendarRange(mode, mode === 'day' ? selectedDate : anchorDate);
    counts[mode] = pendingMatches.filter(task => task.dueDate && task.dueDate >= range.start && task.dueDate <= range.end).length;
  }
  $('count-overdue').textContent = pendingMatches.filter(task => task.dueDate && task.dueDate < today).length;
  $('count-unscheduled').textContent = pendingMatches.filter(task => !task.dueDate).length;
  const isCalendar = CALENDAR_VIEWS.includes(view);
  document.body.dataset.view = view;
  document.body.dataset.wide = String(['week', 'month'].includes(view));
  $('period-navigation').hidden = !isCalendar;
  $('period-label').textContent = view === 'month' ? anchorDate.slice(0, 4) + '年' + Number(anchorDate.slice(5, 7)) + '月' : view === 'week' ? calendarRange(view, anchorDate).start + ' — ' + calendarRange(view, anchorDate).end.slice(5) : selectedDate;
  $('period-date').value = selectedDate;
  $('more-views-trigger').firstChild.textContent = isCalendar ? '更多视图' : ({ all: '全部待办', completed: '已完成', overdue: '逾期任务', unscheduled: '未安排' }[view] ?? '更多视图');

  const pending = state.tasks.filter(task => !task.completedAt).length;
  $('handle-count').textContent = pending > 99 ? '99+' : String(pending);
  $('edge-handle').dataset.count = String(pending);
  motion?.updateHandleLabel();
  $('current-date').textContent = today.replaceAll('-', '.');
  $('weekday').textContent = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(new Date(today + 'T12:00:00'));
  $$('button[data-view]').forEach(tab => {
    const active = tab.dataset.view === view;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    const count = counts[tab.dataset.view];
    if ($('count-' + tab.dataset.view)) $('count-' + tab.dataset.view).textContent = count > 99 ? '99+' : String(count);
  });
  options($('category-filter'), state.categories, filters.categoryId === undefined ? 'all' : filters.categoryId ?? 'none', [{ value: 'all', label: '全部分类' }, { value: 'none', label: '未分类' }]);
  $('tag-filter-label').textContent = filters.tagIds.length ? filters.tagIds.length + ' 标签' : '标签';
  $('tag-filter-trigger').dataset.active = String(filters.tagIds.length > 0);
  $('sort-select').value = filters.sort;
  const parts = [filters.categoryId === null ? '未分类' : state.categories.find(item => item.id === filters.categoryId)?.name,
    filters.tagIds.length ? filters.tagIds.length + ' 个标签' : null, filters.search ? '“' + filters.search + '”' : null, filters.taskIds ? '提醒中的任务' : null].filter(Boolean);
  $('active-filter').hidden = !parts.length;
  $('active-filter-label').textContent = parts.join(' · ');
  renderComposer();
  renderTagChoices('filter-tags-list', filters.tagIds, (id, checked) => {
    filters.tagIds = checked ? [...filters.tagIds, id] : filters.tagIds.filter(tag => tag !== id);
    inheritFilters(); renderLimit = 100; render();
  });
  renderTagChoices('composer-tags-list', composer.tagIds, (id, checked) => {
    composer.tagIds = checked ? [...composer.tagIds, id] : composer.tagIds.filter(tag => tag !== id);
    render();
  });
  renderTasks();
  renderSettings();
  editor.refreshReferences();
  if ($('taxonomy-dialog').open) manager.render();
  updateInteraction();
}

function openReminders(ids) {
  const open = () => {
    if (editor.isOpen) editor.close();
    const tasks = ids.map(getTask).filter(Boolean);
    if (tasks.length === 1) { editor.open(tasks[0]); return; }
    clearFilters();
    filters.taskIds = tasks.map(task => task.id);
    setView('all');
  };
  editor.isOpen ? editor.leave(open) : open();
}

function handleAction(action) {
  const type = typeof action === 'string' ? action : action.type;
  if (type === 'window-error') toast(action.message);
  if (type === 'settings') { message('settings-message', '更改会自动保存'); openDialog('settings-dialog'); }
  if (type === 'new-task') focusComposer();
  if (type === 'open-reminders') openReminders(action.taskIds);
  if (type === 'reminder-notice') {
    const title = action.missed ? '错过 ' + action.taskIds.length + ' 条提醒' : action.taskIds.length + ' 条任务到期';
    toast(title, () => openReminders(action.taskIds), '查看', 0);
  }
  if (type === 'notification-error') {
    toast(action.message, action.taskIds ? () => openReminders(action.taskIds) : null, '查看', 0);
  }
}

async function changeSettings(patch) {
  if (savingSettings) return;
  savingSettings = true;
  settingsDraft = patch;
  renderSettings();
  try { await mutate(() => api.setSettings(patch), 'settings-message'); message('settings-message', '已保存'); }
  catch { /* Restore controls from saved state. */ }
  finally { savingSettings = false; settingsDraft = null; renderSettings(); }
}

function checkDate() {
  const next = localDate();
  if (next === today) return;
  if (followToday) { selectedDate = next; anchorDate = next; }
  if (composer.dueDate === today && !$('task-title').value.trim() && !composerDateExplicit) composer.dueDate = next;
  today = next;
  render();
}

function bindEvents() {
  bindToasts(reportError);
  bindWindowGestures(api, reportError);
  $('brand').addEventListener('click', () => { followToday = true; selectedDate = anchorDate = today; clearFilters(); setView('day'); });
  $('collapse-button').addEventListener('click', () => api.collapse().catch(reportError));
  $('settings-open').addEventListener('click', () => { message('settings-message', '更改会自动保存'); openDialog('settings-dialog'); });
  $('taxonomy-open').addEventListener('click', () => { popovers.close(); manager.open(); });
  $('composer-manage-tags').addEventListener('click', () => { popovers.close(); manager.open('tags'); });
  $('tag-filter-trigger').addEventListener('click', () => popovers.open('tag-filter-popover', $('tag-filter-trigger')));
  $('composer-tags-trigger').addEventListener('click', () => popovers.open('composer-tags-popover', $('composer-tags-trigger')));
  $('filter-tags-clear').addEventListener('click', () => { filters.tagIds = []; inheritFilters(); render(); popovers.close(true); });
  $('filter-clear').addEventListener('click', clearFilters);
  $('category-filter').addEventListener('change', event => {
    filters.categoryId = event.target.value === 'all' ? undefined : event.target.value === 'none' ? null : event.target.value;
    inheritFilters(); renderLimit = 100; render();
  });
  $('sort-select').addEventListener('change', event => { filters.sort = event.target.value; render(); });
  $('composer-category').addEventListener('change', event => { composer.categoryId = event.target.value === 'none' ? null : event.target.value; });
  $('priority-trigger').addEventListener('click', () => { composer.priority = composer.priority === 'high' ? 'normal' : 'high'; renderComposer(); });
  $('due-trigger').addEventListener('click', () => openDate(null, $('due-trigger')));
  $$('[data-date]').forEach(button => button.addEventListener('click', () => {
    const kind = button.dataset.date;
    void chooseDate(kind === 'none' ? null : kind === 'tomorrow' ? addDays(today, 1) : kind === 'next-week' ? addDays(today, 7) : today);
  }));
  $('composer-date').addEventListener('change', () => {
    if ($('composer-date').validity.valid) void chooseDate($('composer-date').value || null);
  });
  $('composer-detail').addEventListener('click', () => editor.open(null, { ...composer, title: $('task-title').value }));
  $('task-title').addEventListener('input', () => { renderComposer(); updateInteraction(); });
  document.addEventListener('compositionstart', () => { composing = true; updateInteraction(); });
  document.addEventListener('compositionend', () => { composing = false; updateInteraction(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.isComposing || composing || event.keyCode === 229)) event.preventDefault();
  }, true);
  $('task-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (adding || composing || !$('task-title').value.trim()) return;
    adding = true; renderComposer();
    try {
      const response = await mutate(() => api.addTask({ ...composer, title: $('task-title').value }));
      $('task-title').value = '';
      resetComposer();
      popovers.close();
      ensureVisible(response.result);
    } catch { /* Keep the entire draft for retry. */ }
    finally { adding = false; renderComposer(); updateInteraction(); $('task-title').focus(); }
  });
  function showSearch() { $('search-box').hidden = false; $('search-options').hidden = false; $('search-toggle').setAttribute('aria-expanded', 'true'); $('search-input').focus(); }
  function closeSearch() { searchScope = 'view'; includeCompleted = false; $('search-scope').value = 'view'; $('search-completed').checked = false; $('search-box').hidden = true; $('search-options').hidden = true; $('search-toggle').setAttribute('aria-expanded', 'false'); filters.search = ''; $('search-input').value = ''; render(); }
  $('search-toggle').addEventListener('click', () => $('search-box').hidden ? showSearch() : closeSearch());
  $('search-close').addEventListener('click', () => { closeSearch(); $('search-toggle').focus(); });
  $('search-input').addEventListener('input', () => { filters.search = $('search-input').value; renderLimit = 100; render(); });
  $$('button[data-view]').forEach(tab => {
    tab.addEventListener('click', () => setView(tab.dataset.view));
    tab.addEventListener('keydown', event => {
      const tabs = $$('.view-tab[data-view]');
      let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault();
      setView(tabs[index].dataset.view);
      tabs[index].focus();
    });
  });
  $('empty-action').addEventListener('click', () => {
    if (filters.search && searchScope === 'view') { searchScope = 'all'; $('search-scope').value = 'all'; render(); }
    else if (!$('active-filter').hidden) clearFilters();
    else if (view === 'completed') setView('all');
    else focusComposer();
  });
  $$('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));
  $$('dialog').forEach(dialog => dialog.addEventListener('close', updateInteraction));
  for (const [id, key] of [['setting-pin', 'alwaysOnTop'], ['setting-collapse', 'autoCollapse'], ['setting-startup', 'launchAtLogin']]) $(id).addEventListener('change', event => { void changeSettings({ [key]: event.target.checked }); });
  $('setting-handle-transparency').addEventListener('input', event => {
    settingsDraft = { ...settingsDraft, collapsedHandleOpacity: (100 - Number(event.target.value)) / 100 };
    renderSettings();
  });
  $('setting-handle-transparency').addEventListener('change', event => {
    void changeSettings({ collapsedHandleOpacity: (100 - Number(event.target.value)) / 100 });
  });
  $('reset-placement').addEventListener('click', () => api.resetPlacement().catch(reportError));
  for (const [key, name] of Object.entries(THEME_NAMES)) {
    const choice = button(name, 'theme-choice theme-' + key, () => { void changeSettings({ themePreset: key }); });
    choice.dataset.themeChoice = key; choice.append(el('span', 'theme-swatch'));
    $('theme-presets').append(choice);
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(state.settings.themePreset));
  $('more-views-trigger').addEventListener('click', () => popovers.open('more-views', $('more-views-trigger')));
  $('backlog-overdue').addEventListener('click', () => setView('overdue'));
  $('backlog-unscheduled').addEventListener('click', () => setView('unscheduled'));
  for (const [id, direction] of [['period-prev', -1], ['period-next', 1]]) $(id).addEventListener('click', () => {
    followToday = false; anchorDate = shiftPeriod(view, anchorDate, direction);
    selectedDate = periodSelection(view, anchorDate, today); syncComposerDate(); columnLimits.clear(); renderLimit = 100; render();
  });
  $('period-today').addEventListener('click', () => { followToday = true; selectedDate = anchorDate = today; syncComposerDate(); render(); });
  $('period-label').addEventListener('click', () => { $('period-date').hidden = !$('period-date').hidden; if (!$('period-date').hidden) $('period-date').focus(); });
  $('period-date').addEventListener('change', event => { if (!event.target.value || !event.target.validity.valid) return; followToday = false; selectedDate = anchorDate = event.target.value; syncComposerDate(); render(); });
  $('search-scope').addEventListener('change', event => { searchScope = event.target.value; renderLimit = 100; render(); });
  $('search-completed').addEventListener('change', event => { includeCompleted = event.target.checked; render(); });
  $('day-dialog').addEventListener('close', () => $('day-tasks').replaceChildren());
  $('preview-edit').addEventListener('click', () => { $('preview-dialog').close(); const task = getTask(previewSource); if (task) editor.open(task); });
  for (const [id, method] of [['export-data', 'exportData'], ['import-data', 'importData']]) {
    $(id).addEventListener('click', async () => {
      if (transferring) return;
      transferring = true; renderSettings();
      message('settings-message', method === 'exportData' ? '正在导出…' : '请选择备份文件…');
      try {
        const response = await api[method]();
        if (response.state) { state = response.state; render(); saveStatus('saved'); }
        message('settings-message', response.canceled ? '已取消' : method === 'exportData' ? '备份已导出'
          : '已导入 ' + response.result.imported + ' 条，跳过 ' + response.result.skipped + ' 条已有任务');
      } catch (error) { message('settings-message', error.message, true); }
      finally { transferring = false; renderSettings(); }
    });
  }
  $('data-folder').addEventListener('click', () => api.openDataFolder().catch(error => message('settings-message', error.message, true)));
  $('reload-button').addEventListener('click', () => location.reload());
  document.addEventListener('keydown', event => {
    if (event.isComposing || composing) return;
    const command = event.ctrlKey || event.metaKey;
    if (command && event.shiftKey && event.code === 'Space' && info.runtime === 'browser') {
      event.preventDefault(); api.toggle().catch(reportError); return;
    }
    // Let the native select close its picker before handling the sidebar shortcut.
    if (event.key === 'Escape' && CSS.supports('selector(select:open)') && document.querySelector('select:open')) return;
    if ($$('dialog[open]').length) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (popovers.active) popovers.close(true);
      else if (editor.isOpen) editor.leave();
      else if (!$('search-box').hidden) { closeSearch(); $('search-toggle').focus(); }
      else api.collapse().catch(reportError);
    }
    if (command && event.key.toLowerCase() === 'n') { event.preventDefault(); focusComposer(); }
    if (command && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      const open = () => { if (editor.isOpen) editor.close(); showSearch(); };
      editor.isOpen ? editor.leave(open) : open();
    }
  });
  window.addEventListener('focus', checkDate);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDate(); });
  setInterval(checkDate, 30000);
}

async function boot() {
  api = window.__TAURI__ ? await createTauriBridge() : createBrowserBridge();
  window.sideTask = api;
  api.onStateChange(next => { if (!ready) pendingState = next; else { state = next; render(); } });
  api.onWindowChange(value => { if (!ready) pendingWindow = value; else renderWindow(value); });
  api.onAction(action => { if (!ready) earlyActions.push(action); else handleAction(action); });
  const initial = await api.getState();
  state = pendingState ?? initial.state;
  view = state.settings.calendarView;
  applyTheme(state.settings.themePreset);
  info = initial.info;
  document.body.dataset.runtime = info.runtime;
  popovers = new Popovers(updateInteraction);
  manager = new TaxonomyManager({ api, mutate, getState: () => state, onInteraction: updateInteraction });
  editor = new TaskEditor({
    api, mutate, getState: () => state, getInfo: () => info, onInteraction: updateInteraction,
    onOpen: () => { popovers.close(); hideToast(); $('day-dialog').close(); },
    onClose: id => {
      const target = id && $('task-list').querySelector('[data-task-id="' + CSS.escape(id) + '"][data-action="edit"]');
      (target ?? $('task-title')).focus({ preventScroll: true });
    },
    manageTags: () => manager.open('tags'),
    onSaved: (response, { created }) => {
      if (created) { $('task-title').value = ''; resetComposer(); renderComposer(); updateInteraction(); if (ensureVisible(response.result)) return; }
      if (response.undoToken) completionToast(response);
      else toast(created ? '任务已添加' : '修改已保存');
    },
    onDeleted: deletionToast,
  });
  motion = new SidebarMotion(api, { onSettled: value => {
    if (value.expanded && pendingFocus) { pendingFocus = false; $('task-title').focus(); }
    updateInteraction();
  } });
  projection = new CalendarProjection(() => { if (ready) renderTasks(); }, text => toast(text));
  ready = true;
  bindEvents();
  renderWindow(pendingWindow ?? initial.window);
  render();
  saveStatus('saved');
  document.body.dataset.ready = 'true';
  await api.frontendReady?.();
  if (initial.warning) toast(initial.warning, null, '', 12000);
  if (!info.shortcutRegistered) toast('全局快捷键已被占用，可通过边缘把手或托盘展开。', null, '', 12000);
  earlyActions.forEach(handleAction);
}

boot().catch(error => {
  api?.frontendReady?.().catch(() => {});
  document.body.dataset.ready = 'true';
  $('fatal-error').hidden = false;
  $('fatal-message').textContent = error.message || '请重新启动侧记。';
  $('task-form').hidden = true;
  $('empty-state').hidden = true;
  $('reload-button').onclick = () => location.reload();
  saveStatus('error');
});
