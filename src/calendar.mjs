import { addDays, isDateOnly, localDate, nextRepeatDate } from './domain.mjs';

export const CALENDAR_VIEWS = ['day', 'week', 'month'];
export function calendarRange(view, anchor) {
  if (!isDateOnly(anchor)) throw new Error('日历日期无效。');
  let start = anchor;
  let days = 1;
  if (view === 'week') { start = addDays(anchor, -((new Date(anchor + 'T12:00:00').getDay() + 6) % 7)); days = 7; }
  if (view === 'month') { const first = anchor.slice(0, 7) + '-01'; start = addDays(first, -((new Date(first + 'T12:00:00').getDay() + 6) % 7)); days = 42; }
  const dates = Array.from({ length: days }, (_, index) => addDays(start, index)).filter(isDateOnly);
  return { start, end: dates.at(-1), dates };
}
export function shiftPeriod(view, anchor, direction) {
  let candidate;
  if (view === 'month') {
    const [year, month] = anchor.split('-').map(Number);
    candidate = localDate(new Date(year, month - 1 + direction, 1, 12));
  } else candidate = addDays(anchor, direction * (view === 'week' ? 7 : 1));
  return isDateOnly(candidate) ? candidate : anchor;
}
export function periodSelection(view, anchor, today) {
  if (view === 'month') return today.slice(0, 7) === anchor.slice(0, 7) ? today : anchor.slice(0, 7) + '-01';
  const range = calendarRange(view, anchor);
  return today >= range.start && today <= range.end ? today : range.start;
}
export function projectRecurrences(tasks, start, end, today) {
  const previews = [];
  const existing = new Set(tasks.filter(task => task.seriesId).map(task => task.seriesId + ':' + task.dueDate));
  const after = start > today ? addDays(start, -1) : today;
  for (const task of tasks) {
    if (task.completedAt || !task.recurrence || !task.dueDate) continue;
    let cursor = task;
    for (let index = 0; index < 43; index++) {
      const date = nextRepeatDate(cursor, after + 'T12:00:00');
      if (!date || date > end) break;
      if (date >= start && !existing.has(task.seriesId + ':' + date)) previews.push({ kind: 'recurrence-preview', sourceTaskId: task.id, date });
      cursor = { ...task, dueDate: date };
    }
  }
  return previews;
}
