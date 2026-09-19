import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createTask, emptyState } from '../../src/domain.mjs';

const fixed = '2026-09-07T10:00:00+08:00';
const makeTask = (id, title, extra = {}) => ({
  ...createTask({ title, dueDate: '2026-09-07' }, '2026-09-07T01:00:00.000Z', id), ...extra,
});

test.beforeEach(async ({ page }) => {
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.stack));
  await page.clock.setFixedTime(new Date(fixed));
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
});
test.afterEach(async ({ page }) => { expect(page.errors).toEqual([]); });

async function add(page, title) {
  await page.locator('#task-title').fill(title);
  await page.locator('#task-title').press('Enter');
  await expect(page.locator('#task-title')).toHaveValue('');
}
async function seed(page, data) {
  await page.evaluate(value => {
    localStorage.clear();
    localStorage.setItem('sidetask.preview.v3', JSON.stringify(value));
  }, data);
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
}
async function saved(page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('sidetask.preview.v3')));
}
async function section(page, id) {
  if (!await page.locator(id).evaluate(node => node.open)) await page.locator(id + ' > summary').click();
}
async function createTaxonomy(page, name, kind = 'categories') {
  await page.locator('[data-kind="' + kind + '"]').click();
  await page.locator('#taxonomy-name').fill(name);
  await page.locator('#taxonomy-save').click();
  await expect(page.locator('#taxonomy-name')).toHaveValue('');
  await expect(page.locator('.taxonomy-name').filter({ hasText: name })).toBeVisible();
}

test('add, complete, undo, reopen, and reload tasks', async ({ page }) => {
  await expect(page.locator('#empty-title')).toHaveText('还没有任务');
  await add(page, '整理今天的计划');
  await expect(page.locator('.task-title')).toHaveText('整理今天的计划');
  await expect(page.locator('#count-day')).toHaveText('1');
  await page.getByRole('checkbox', { name: '完成：整理今天的计划', exact: true }).click();
  await expect(page.locator('#count-completed')).toHaveText('1');
  await page.locator('#toast-action').click();
  await expect(page.locator('#count-day')).toHaveText('1');
  await page.getByRole('checkbox', { name: '完成：整理今天的计划', exact: true }).click();
  await page.locator('#more-views-trigger').click();
  await page.locator('#tab-completed').click();
  await page.getByRole('checkbox', { name: '重新打开：整理今天的计划', exact: true }).click();
  await page.locator('#tab-day').click();
  await page.reload();
  await expect(page.locator('.task-title')).toHaveText('整理今天的计划');
  await expect(page.locator('#count-completed')).toHaveText('0');
});

test('future scheduling, quick rescheduling, importance, notes and search work together', async ({ page }) => {
  await page.locator('#due-trigger').click();
  await page.locator('[data-date="tomorrow"]').click();
  await page.locator('#priority-trigger').click();
  await add(page, '准备项目讨论');
  await page.locator('#toast-action').click();
  await expect(page.locator('#tab-day')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.task-date')).toHaveText('明天');
  await expect(page.locator('.priority-label')).toHaveText('重要');
  await page.getByRole('button', { name: '编辑：准备项目讨论', exact: true }).click();
  await page.locator('#edit-title').fill('准备周一项目讨论');
  await section(page, '#notes-section');
  await page.locator('#edit-notes').fill('整理 PDF 材料和预算清单');
  await page.locator('#edit-date').fill('2026-09-06');
  await page.locator('#save-edit').click();
  await expect(page.locator('#task-detail')).toBeHidden();
  await page.locator('#backlog-overdue').click();
  await expect(page.locator('.task-date')).toHaveText('逾期 1 天');
  await page.locator('.task-date').click();
  await page.locator('[data-date="today"]').click();
  await page.locator('#brand').click();
  await expect(page.locator('.task-date')).toHaveText('今天');
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('pdf');
  await expect(page.locator('.task-title')).toHaveText('准备周一项目讨论');
  await page.locator('#search-input').fill('不存在的关键词');
  await expect(page.locator('#empty-title')).toHaveText('没有匹配的任务');
  await page.locator('#empty-action').click();
  await expect(page.locator('#search-scope')).toHaveValue('all');
  await page.locator('#empty-action').click();
  await expect(page.locator('.task-row')).toHaveCount(1);
});

test('delete from the task menu can be undone without losing saved details', async ({ page }) => {
  await add(page, '暂时移走的任务');
  await page.getByRole('button', { name: '编辑：暂时移走的任务', exact: true }).click();
  await section(page, '#notes-section');
  await page.locator('#edit-notes').fill('保留原来的细节');
  await page.locator('#edit-priority').check();
  await page.locator('#save-edit').click();
  await page.getByRole('button', { name: '更多操作：暂时移走的任务', exact: true }).click();
  await page.locator('#task-menu').getByRole('button', { name: '删除任务', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(0);
  await page.locator('#toast-action').click();
  await expect(page.locator('.task-row')).toHaveCount(1);
  await page.getByRole('button', { name: '编辑：暂时移走的任务', exact: true }).click();
  await expect(page.locator('#edit-notes')).toHaveValue('保留原来的细节');
  await expect(page.locator('#edit-priority')).toBeChecked();
});

test('user text is safe and failed persistence preserves the composer and editor drafts', async ({ page }) => {
  const unsafe = '<img src=x onerror="window.__injected=true">';
  await add(page, unsafe);
  await expect(page.locator('.task-title')).toHaveText(unsafe);
  await expect(page.locator('#task-list img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__injected)).toBeUndefined();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Storage full', 'QuotaExceededError'); }; });
  await page.locator('#task-title').fill('失败时保留草稿');
  await page.locator('#task-title').press('Enter');
  await expect(page.locator('#save-indicator')).toHaveAttribute('data-status', 'error');
  await expect(page.locator('#task-title')).toHaveValue('失败时保留草稿');
  await page.getByRole('button', { name: '编辑：' + unsafe, exact: true }).click();
  await section(page, '#notes-section');
  await page.locator('#edit-notes').fill('写入失败也不能消失');
  await page.locator('#save-edit').click();
  await expect(page.locator('#edit-message')).toContainText('存储');
  await expect(page.locator('#edit-notes')).toHaveValue('写入失败也不能消失');
});

test('settings, mirrored docking and reversible motion preserve tasks', async ({ page }) => {
  await add(page, '侧栏里的任务');
  await page.locator('#settings-open').click();
  await expect(page.locator('#setting-startup')).toBeDisabled();
  await page.locator('#setting-pin').uncheck();
  await expect.poll(async () => (await saved(page)).settings.alwaysOnTop).toBe(false);
  await page.evaluate(() => { const data=JSON.parse(localStorage.getItem('sidetask.preview.v3')); data.settings.windowPlacement.edge='left'; localStorage.setItem('sidetask.preview.v3',JSON.stringify(data)); });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-dock', 'left');
  await page.locator('#collapse-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
  await expect(page.locator('#panel')).toBeHidden();
  await expect(page.locator('#handle-count')).toHaveText('1');
  expect((await page.locator('#shell').boundingBox()).width).toBe(40);
  await page.locator('#edge-handle').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-dock', 'left');
  await page.locator('#settings-open').click();
  await expect(page.locator('#setting-pin')).not.toBeChecked();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  for (let index = 0; index < 20; index++) await page.keyboard.press('Control+Shift+Space');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');
  await expect(page.locator('.task-title')).toHaveText('侧栏里的任务');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#collapse-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
  await page.locator('#edge-handle').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');
});

test('export and import preserve local content, settings and schema compatibility', async ({ page }) => {
  await add(page, '已经存在的任务');
  await page.locator('#settings-open').click();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-data').click();
  const download = await downloadEvent;
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(backup.version).toBe(3);
  backup.tasks[0].title = '旧的内容不应该覆盖现有任务';
  backup.tasks.push(makeTask('import-new-id', '从备份带来的任务'));
  backup.settings.dockSide = 'left';
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#import-data').click();
  await (await chooser).setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator('#settings-message')).toContainText('已导入 1 条，跳过 1 条');
  await expect(page.locator('body')).toHaveAttribute('data-dock', 'right');
  const invalid = page.waitForEvent('filechooser');
  await page.locator('#import-data').click();
  await (await invalid).setFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{ bad') });
  await expect(page.locator('#settings-message')).toContainText('有效的 JSON');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.locator('.task-row')).toHaveCount(2);
  await expect(page.locator('.task-title').last()).toHaveText('已经存在的任务');
});

test('the list occupies most of both regular and small windows and remains keyboard accessible', async ({ page }) => {
  for (const [width, height, ratio] of [[420, 850, 0.65], [375, 580, 0.5]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      list: document.getElementById('task-scroll').clientHeight,
      panel: document.getElementById('panel').clientHeight,
    }));
    expect(layout.width).toBeLessThanOrEqual(width);
    expect(layout.list / layout.panel).toBeGreaterThanOrEqual(ratio);
  }
  await add(page, '小屏幕也能查看完整的任务名称，不会撑出横向滚动条');
  await page.locator('#tab-day').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#tab-week')).toBeFocused();
  await page.keyboard.press('Control+f');
  await expect(page.locator('#search-input')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#search-box')).toBeHidden();
  await page.locator('#settings-open').click();
  await page.locator('#export-data').scrollIntoViewIfNeeded();
  await expect(page.locator('#export-data')).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).toBeHidden();
  await page.screenshot({ path: test.info().outputPath('small-screen.png'), animations: 'disabled' });
});

test('select menus support keyboard dismissal without closing the sidebar or editor draft', async ({ page }) => {
  await page.locator('#category-filter').click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveAttribute('data-expanded', 'true');
  await expect(page.locator('#category-filter')).toHaveValue('all');

  await page.locator('#sort-select').click();
  await page.getByRole('option', { name: '时间优先', exact: true }).click();
  await expect(page.locator('#sort-select')).toHaveValue('time');

  await page.locator('#composer-detail').click();
  await page.locator('#edit-title').fill('保留正在编辑的任务');
  await section(page, '#schedule-section');
  await page.locator('#edit-repeat').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#task-detail')).toBeVisible();
  await expect(page.locator('#discard-dialog')).toBeHidden();
  await expect(page.locator('#edit-title')).toHaveValue('保留正在编辑的任务');
  await expect(page.locator('#edit-repeat')).toHaveValue('none');
});

test('date views advance at midnight using local dates', async ({ page }) => {
  await page.locator('#due-trigger').click();
  await page.locator('[data-date="tomorrow"]').click();
  await add(page, '明天要做的事');
  await page.locator('#tab-day').click();
  await expect(page.locator('.task-row')).toHaveCount(0);
  await page.clock.setFixedTime(new Date('2026-09-08T00:01:00+08:00'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#current-date')).toHaveText('2026.09.08');
  await expect(page.locator('.task-title')).toHaveText('明天要做的事');
});

test('create classifications and multiple tags, inheriting both when adding from a filtered view', async ({ page }) => {
  await page.locator('#taxonomy-open').click();
  await createTaxonomy(page, '工作');
  await createTaxonomy(page, '生活');
  await createTaxonomy(page, '客户', 'tags');
  await createTaxonomy(page, '沟通', 'tags');
  await page.getByRole('button', { name: '关闭分类与标签', exact: true }).click();
  await page.locator('#category-filter').selectOption({ label: '工作' });
  await page.locator('#tag-filter-trigger').click();
  await page.locator('#filter-tags-list').getByLabel('客户', { exact: true }).check();
  await page.locator('#filter-tags-list').getByLabel('沟通', { exact: true }).check();
  await page.keyboard.press('Escape');
  await add(page, '准备客户会议');
  const data = await saved(page);
  expect(data.tasks[0].categoryId).toBe(data.categories.find(item => item.name === '工作').id);
  expect(data.tasks[0].tagIds).toHaveLength(2);
  await expect(page.locator('.task-category')).toHaveText('工作');
  await expect(page.locator('#count-day')).toHaveText('1');
  await page.locator('#category-filter').selectOption({ label: '生活' });
  await expect(page.locator('.task-row')).toHaveCount(0);
  await page.locator('#filter-clear').click();
  await expect(page.locator('.task-row')).toHaveCount(1);
});

test('rename and delete taxonomy entries retain tasks and remove stale references', async ({ page }) => {
  const category = { id: 'work', name: '工作', color: '#32654d' };
  await seed(page, { ...emptyState(), categories: [category], tasks: [makeTask('a', '保留任务', { categoryId: 'work' })] });
  await page.locator('#category-filter').selectOption('work');
  await page.locator('#taxonomy-open').click();
  await page.getByRole('button', { name: '编辑工作', exact: true }).click();
  await page.locator('#taxonomy-name').fill('项目');
  await page.locator('#taxonomy-save').click();
  await expect(page.locator('.taxonomy-name')).toHaveText('项目');
  await page.getByRole('button', { name: '删除项目', exact: true }).click();
  await page.locator('#taxonomy-confirm-delete').click();
  await expect(page.locator('.taxonomy-name')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭分类与标签', exact: true }).click();
  await expect(page.locator('.task-title')).toHaveText('保留任务');
  expect((await saved(page)).tasks[0].categoryId).toBeNull();
  await expect(page.locator('#category-filter')).toHaveValue('all');
});

test('subtasks, recurrence, time and reminders save together and completion undo restores the series', async ({ page }) => {
  await page.locator('#composer-detail').click();
  await page.locator('#edit-title').fill('每日整理');
  await page.locator('#edit-date').fill('2026-09-08');
  await page.locator('#edit-time').fill('09:00');
  await section(page, '#subtasks-section');
  await page.locator('#subtask-title').fill('收集资料');
  await page.locator('#subtask-title').press('Enter');
  await page.locator('#subtask-title').fill('写下结论');
  await page.locator('#subtask-add').click();
  await section(page, '#schedule-section');
  await page.locator('#edit-repeat').selectOption('daily');
  await page.locator('#edit-reminder').selectOption('15');
  await page.locator('#save-edit').click();
  await expect(page.locator('#task-detail')).toBeHidden();
  await page.locator('#toast-action').click();
  const original = (await saved(page)).tasks[0];
  await page.locator('.subtask-toggle').click();
  await page.getByRole('checkbox', { name: '子任务：收集资料', exact: true }).check();
  await expect(page.locator('.subtask-toggle')).toHaveText('1/2');
  await page.getByRole('checkbox', { name: '完成：每日整理', exact: true }).click();
  await expect(page.locator('#count-completed')).toHaveText('1');
  await expect(page.locator('.task-row.is-completed')).toHaveCount(1);
  let data = await saved(page);
  expect(data.tasks).toHaveLength(2);
  const next = data.tasks.find(task => !task.completedAt);
  expect(next.dueDate).toBe('2026-09-09');
  expect(next.subtasks.every(item => !item.completed)).toBe(true);
  expect(next.reminder.offsetMinutes).toBe(15);
  await page.locator('#toast-action').click();
  await expect(page.locator('#toast-message')).toHaveText('已撤销完成');
  data = await saved(page);
  expect(data.tasks).toHaveLength(1);
  expect(data.tasks[0].id).toBe(original.id);
  expect(data.tasks[0].subtasks.map(item => item.completed)).toEqual([true, false]);
  await page.reload();
  await page.locator('#tab-week').click();
  await page.getByRole('button', { name: '编辑：每日整理', exact: true }).click();
  await expect(page.locator('#edit-repeat')).toHaveValue('daily');
  await expect(page.locator('#edit-reminder')).toHaveValue('15');
  await expect(page.locator('#edit-time')).toHaveValue('09:00');
});

test('unsaved detail drafts survive collapse, and leaving offers continue, discard or save', async ({ page }) => {
  await add(page, '原来的任务');
  await page.getByRole('button', { name: '编辑：原来的任务', exact: true }).click();
  await page.locator('#edit-title').fill('未保存的修改');
  await page.locator('#edge-handle').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
  await page.locator('#edge-handle').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');
  await expect(page.locator('#edit-title')).toHaveValue('未保存的修改');
  await page.locator('#detail-back').click();
  await expect(page.locator('#discard-dialog')).toBeVisible();
  await page.locator('#discard-continue').click();
  await expect(page.locator('#edit-title')).toHaveValue('未保存的修改');
  await page.locator('#detail-back').click();
  await page.locator('#discard-save').click();
  await expect(page.locator('#task-detail')).toBeHidden();
  await expect(page.locator('.task-title')).toHaveText('未保存的修改');
});

test('multiple tabs reject stale editor saves without overwriting newer task content', async ({ page, context }) => {
  await add(page, '同一条任务');
  await page.getByRole('button', { name: '编辑：同一条任务', exact: true }).click();
  await page.locator('#edit-title').fill('此处的草稿');
  const other = await context.newPage();
  await other.clock.setFixedTime(new Date(fixed));
  await other.goto('/');
  await other.getByRole('button', { name: '编辑：同一条任务', exact: true }).click();
  await other.locator('#edit-title').fill('另一个窗口先保存');
  await other.locator('#save-edit').click();
  await expect(other.locator('.task-title')).toHaveText('另一个窗口先保存');
  await page.locator('#save-edit').click();
  await expect(page.locator('#edit-message')).toContainText('别处修改');
  await expect(page.locator('#edit-title')).toHaveValue('此处的草稿');
  expect((await saved(page)).tasks[0].title).toBe('另一个窗口先保存');
  await other.close();
});

test('large lists render in batches and retain scroll position when returning from details', async ({ page }) => {
  await seed(page, { ...emptyState(), tasks: Array.from({ length: 250 }, (_, index) => makeTask('task-' + String(index).padStart(3, '0'), '任务 ' + index)) });
  await expect(page.locator('.task-row')).toHaveCount(100);
  await expect(page.locator('.group-heading > span')).toHaveText('250');
  await page.locator('.load-more').click();
  await expect(page.locator('.task-row')).toHaveCount(200);
  await page.getByRole('button', { name: '编辑：任务 130', exact: true }).scrollIntoViewIfNeeded();
  const scroll = await page.locator('#task-scroll').evaluate(node => node.scrollTop);
  await page.getByRole('button', { name: '编辑：任务 130', exact: true }).click();
  await page.locator('#detail-back').click();
  expect(Math.abs(await page.locator('#task-scroll').evaluate(node => node.scrollTop) - scroll)).toBeLessThan(3);
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('任务 249');
  await expect(page.locator('.task-row')).toHaveCount(1);
  await expect(page.locator('.task-title')).toHaveText('任务 249');
  await expect(page.locator('#handle-count')).toHaveText('99+');
});

test('missed reminders are summarized once on startup and clicking the summary locates tasks', async ({ page }) => {
  await seed(page, { ...emptyState(), tasks: [
    makeTask('alarm-a', '早上会议', { dueTime: '09:00', reminder: { offsetMinutes: 0 } }),
    makeTask('alarm-b', '准备材料', { dueTime: '09:30', reminder: { offsetMinutes: 15 } }),
  ] });
  await expect(page.locator('#toast-message')).toHaveText('错过 2 条提醒');
  await page.locator('#toast-action').click();
  await expect(page.locator('#active-filter-label')).toContainText('提醒中的任务');
  expect((await saved(page)).tasks.every(task => task.reminderSentKey)).toBe(true);
  await page.reload();
  await expect(page.locator('#toast')).toBeHidden();
});

test('legacy browser data migrates once and preserves the original backup', async ({ page }) => {
  const legacy = { version: 1, tasks: [makeTask('legacy', '旧版任务')], settings: { dockSide: 'left' } };
  await page.evaluate(value => { localStorage.clear(); localStorage.setItem('sidetask.preview.v1', JSON.stringify(value)); }, legacy);
  await page.reload();
  await expect(page.locator('.task-title')).toHaveText('旧版任务');
  await expect(page.locator('body')).toHaveAttribute('data-dock', 'left');
  const data = await saved(page);
  expect(data.version).toBe(3);
  expect(data.tasks[0].categoryId).toBeNull();
  expect(data.tasks[0].recurrence).toBeNull();
  const original = await page.evaluate(() => JSON.parse(localStorage.getItem('sidetask.preview.v1.original')));
  expect(original).toEqual(legacy);
});

test('captures a representative task list, details and classification manager', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 900 });
  await seed(page, {
    ...emptyState(),
    categories: [{ id: 'work', name: '工作', color: '#32654d' }, { id: 'life', name: '生活', color: '#b9784a' }, { id: 'study', name: '学习', color: '#4676a9' }],
    tags: [{ id: 'writing', name: '写作', color: '#8262ad' }, { id: 'project', name: '新项目', color: '#32654d' }],
    tasks: [
      makeTask('preview-1', '整理新项目的灵感与参考', { categoryId: 'work', priority: 'high', notes: '整理参考资料，确定下一步的方向。', tagIds: ['project'], subtasks: [{ id: 's1', title: '收集参考', completed: true }, { id: 's2', title: '整理方向', completed: false }, { id: 's3', title: '补充草图', completed: false }] }),
      makeTask('preview-2', '和团队确认本周的交付计划', { categoryId: 'work', dueTime: '14:30', reminder: { offsetMinutes: 15 } }),
      makeTask('preview-3', '读完《设计心理学》第二章', { categoryId: 'study' }),
      makeTask('preview-4', '给家里的绿植浇水', { categoryId: 'life', dueDate: '2026-09-06' }),
      makeTask('preview-5', '写下今天的三点收获', { categoryId: 'study', tagIds: ['writing'], recurrence: { frequency: 'daily', anchorDate: '2026-09-07', until: null }, seriesId: 'preview-5' }),
      makeTask('preview-6', '傍晚出门走走，买一束花', { categoryId: 'life', dueTime: '18:00' }),
      makeTask('preview-7', '准备周三的产品分享', { categoryId: 'work', dueDate: '2026-09-09' }),
      makeTask('preview-8', '整理书桌', { completedAt: '2026-09-07T01:30:00.000Z', categoryId: 'life' }),
    ],
  });
  await expect(page.locator('.task-row')).toHaveCount(6);
  await page.locator('#shell').screenshot({ path: test.info().outputPath('preview.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '编辑：整理新项目的灵感与参考', exact: true }).click();
  await page.locator('#shell').screenshot({ path: test.info().outputPath('details.png'), animations: 'disabled' });
  await page.locator('#detail-back').click();
  await page.locator('#taxonomy-open').click();
  await page.screenshot({ path: test.info().outputPath('categories.png'), animations: 'disabled' });
});
