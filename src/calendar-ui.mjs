import { el, button } from './ui.mjs';

export class CalendarProjection {
  constructor(update, failed) {
    this.update = update; this.failed = failed; this.id = 0; this.key = ''; this.previews = []; this.loading = false;
    this.worker = new Worker(new URL('./calendar-worker.mjs', import.meta.url), { type: 'module' });
    this.busy = false; this.pending = null;
    this.worker.onmessage = ({ data }) => {
      this.busy = false;
      if (this.pending) { const pending = this.pending; this.pending = null; this.dispatch(pending); }
      if (data.id !== this.id) return;
      this.loading = false;
      this.previews = data.previews ?? [];
      if (data.error) this.failed(data.error);
      this.update();
    };
    this.worker.onerror = () => { this.busy = false; this.pending = null; this.loading = false; this.key = ''; this.failed('重复计划预览暂不可用，已保存任务仍可正常使用。'); };
    window.addEventListener('pagehide', () => this.worker.terminate(), { once: true });
  }
  schedule(tasks, range, today) {
    const minimal = tasks.filter(task => task.seriesId || task.recurrence).map(({ id, dueDate, recurrence, seriesId, completedAt }) => ({ id, dueDate, recurrence, seriesId, completedAt }));
    const key = JSON.stringify([minimal, range.start, range.end, today]);
    if (key === this.key) return;
    this.key = key; this.previews = []; this.loading = true;
    const request = { id: ++this.id, tasks: minimal, start: range.start, end: range.end, today };
    if (this.busy) this.pending = request;
    else this.dispatch(request);
  }
  dispatch(request) { this.busy = true; this.worker.postMessage(request); }
}

export function groupByDate(items, dateKey) {
  const groups = new Map();
  for (const item of items) {
    const date = item[dateKey];
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(item);
  }
  return groups;
}

export function calendarGrid({ view, range, anchor, selected, today, tasks, previews, getTask, selectDate, edit, toggle, preview, openDay, addAt, limits, loadMore }) {
  const grid = el('div', 'calendar-grid ' + view + '-grid');
  const taskDays = groupByDate(tasks, 'dueDate');
  const previewDays = groupByDate(previews, 'date');
  grid.setAttribute('aria-label', view === 'month' ? '月日历' : '周日历');
  if (view === 'month') for (const name of ['一', '二', '三', '四', '五', '六', '日']) grid.append(el('div', 'weekday-heading', '周' + name));
  for (const date of range.dates) {
    const section = el('section', 'calendar-day' + (date === today ? ' is-today' : '') + (date === selected ? ' is-selected' : '') + (view === 'month' && date.slice(0, 7) !== anchor.slice(0, 7) ? ' outside-month' : ''));
    section.dataset.date = date;
    section.addEventListener('click', event => {
      if (event.target.closest('button, input, select, textarea, a, [role="checkbox"], .calendar-entry')) return;
      selectDate(date);
    });
    const heading = el('div', 'calendar-day-heading');
    const title = view === 'week' ? new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(new Date(date + 'T12:00:00')) + ' ' + Number(date.slice(5, 7)) + '/' + Number(date.slice(8)) : String(Number(date.slice(8)));
    const choose = button(date + '，选择日期', 'calendar-date', () => selectDate(date));
    choose.textContent = title;
    choose.setAttribute('aria-pressed', String(date === selected));
    if (date === today) choose.setAttribute('aria-current', 'date');
    const add = button('在 ' + date + ' 添加任务', 'icon-button small calendar-add', () => addAt(date), 'plus');
    heading.append(choose, add); section.append(heading);
    const actual = taskDays.get(date) ?? [];
    const planned = previewDays.get(date) ?? [];
    const entries = [...actual.map(task => ({ kind: 'task', task })), ...planned];
    const limit = view === 'month' ? 3 : (limits.get(date) ?? 50);
    for (const entry of entries.slice(0, limit)) {
      const isPreview = entry.kind !== 'task';
      const task = isPreview ? getTask(entry.sourceTaskId) : entry.task;
      if (!task) continue;
      const row = el('div', 'calendar-entry' + (task.priority === 'high' ? ' is-important' : '') + (isPreview ? ' is-preview' : '') + (task.completedAt && !isPreview ? ' is-completed' : ''));
      if (!isPreview) {
        row.dataset.taskId = task.id;
        const check = button((task.completedAt ? '重新打开：' : '完成：') + task.title, 'task-checkbox', () => toggle(task), 'check');
        check.setAttribute('role', 'checkbox'); check.setAttribute('aria-checked', String(Boolean(task.completedAt)));
        row.append(check);
      }
      const name = button((isPreview ? '预览：' : '编辑：') + task.title + (isPreview ? '，' + date : ''), 'calendar-task', () => isPreview ? preview(entry) : edit(task));
      name.title = task.title + (task.dueTime ? ' ' + task.dueTime : '');
      name.replaceChildren(el('span', 'calendar-task-title', task.title));
      if (isPreview || task.dueTime || task.priority === 'high') name.append(el('span', 'calendar-task-caption', [isPreview ? '预计' : '', task.dueTime, task.priority === 'high' ? '重要' : ''].filter(Boolean).join(' ')));
      row.append(name); section.append(row);
    }
    if (entries.length > limit) section.append(button('还有 ' + (entries.length - limit) + ' 项', 'text-button calendar-more', () => view === 'month' ? openDay(date) : loadMore(date)));
    section.setAttribute('aria-label', date + '，' + actual.length + ' 项任务，' + planned.length + ' 项预计');
    const count = el('span', 'calendar-day-count', actual.length + ' 项' + (planned.length ? '，' + planned.length + ' 项预计' : ''));
    section.append(count); grid.append(section);
  }
  return grid;
}
