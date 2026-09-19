import { test, expect } from '@playwright/test';
import { emptyState, createTask } from '../../src/domain.mjs';

const fixed = '2026-09-08T10:00:00+08:00';
const make = (id, extra = {}) => ({ ...createTask({ title: id, dueDate: '2026-09-08' }, '2026-09-08T00:00:00Z', 'task-' + Buffer.from(id).toString('hex')), ...extra });
async function seed(page, tasks) {
  await page.evaluate(data => localStorage.setItem('sidetask.preview.v3', JSON.stringify(data)), { ...emptyState(), tasks });
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
}
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(fixed));
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
});

for (const view of ['week', 'month']) {
  test(view + ' blank cells select dates without hijacking task controls or drafts', async ({ page }) => {
    await seed(page, [make('保留任务')]);
    await page.locator('#tab-' + view).click();
    const cell = page.locator('.calendar-day[data-date="2026-09-09"]');
    await cell.click({ position: { x: 100, y: view === 'week' ? 120 : 60 } });
    await expect(cell).toHaveClass(/is-selected/);
    await expect(page.locator('#composer-date-label')).toHaveText('明天');
    await page.locator('#task-title').fill('保留草稿');
    await page.locator('.calendar-day[data-date="2026-09-10"] .calendar-date').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.calendar-day[data-date="2026-09-10"] .calendar-date')).toBeFocused();
    await expect(page.locator('#composer-date-label')).toHaveText('明天');
    await page.getByRole('checkbox', { name: '完成：保留任务', exact: true }).click();
    await expect(page.locator('.calendar-day.is-selected')).toHaveAttribute('data-date', '2026-09-10');
    await expect(page.getByRole('checkbox', { name: '重新打开：保留任务', exact: true })).toBeChecked();
    await page.getByRole('button', { name: '编辑：保留任务', exact: true }).click();
    await expect(page.locator('#task-detail')).toBeVisible();
    await expect(page.locator('.calendar-day.is-selected')).toHaveAttribute('data-date', '2026-09-10');
    await page.locator('#detail-back').click();
    await expect(page.locator('#task-title')).toHaveValue('保留草稿');
  });
}

test('mixed status is persistent and shared by calendar, agenda, search and lists', async ({ page }) => {
  await seed(page, [make('待办任务'), make('已完成任务', { completedAt: '2026-09-09T00:00:00Z' }),
    make('其他待办'), make('更多待办'), make('已完成逾期', { dueDate: '2026-09-07', completedAt: fixed }),
    make('未安排完成', { dueDate: null, completedAt: fixed })]);
  await expect(page.locator('#show-completed')).toBeChecked();
  await expect(page.locator('.task-title').last()).toHaveText('已完成任务');
  await expect(page.locator('#count-day')).toHaveText('4');
  await expect(page.locator('#handle-count')).toHaveText('3');
  await page.locator('#tab-month').click();
  await page.locator('.calendar-day[data-date="2026-09-08"] .calendar-more').click();
  await expect(page.locator('#day-tasks .task-row')).toHaveCount(4);
  await page.locator('[data-close="day-dialog"]').click();
  await page.locator('#show-completed').uncheck();
  await expect(page.locator('#count-day')).toHaveText('3');
  await page.reload();
  await expect(page.locator('#show-completed')).not.toBeChecked();
  await page.locator('#tab-day').click();
  await expect(page.locator('.is-completed')).toHaveCount(0);
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('已完成');
  await page.locator('#show-completed').check();
  await expect(page.locator('.task-title')).toHaveText('已完成任务');
  await page.locator('#search-close').click();
  await expect(page.locator('#show-completed')).toBeChecked();
  await page.locator('#backlog-overdue').click();
  await expect(page.locator('.task-row')).toHaveCount(0);
  await expect(page.locator('#show-completed')).toBeDisabled();
  await page.locator('#backlog-unscheduled').click();
  await expect(page.locator('.task-title')).toHaveText('未安排完成');
  await page.locator('#more-views-trigger').click();
  await page.locator('#tab-all').click();
  await expect(page.locator('.task-row')).toHaveCount(6);
  await expect(page.locator('.task-group').last().locator('h2')).toContainText('已完成');
});

test('panel opacity previews, survives animation and restores saved value on failure', async ({ page }) => {
  await page.locator('#settings-open').click();
  const slider = page.locator('#setting-panel-transparency');
  await slider.fill('60');
  await slider.dispatchEvent('change');
  await expect(page.locator('#drawer')).toHaveCSS('opacity', '0.4');
  await expect(page.locator('#settings-dialog')).toHaveCSS('opacity', '0.4');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('sidetask.preview.v3')).settings.panelOpacity)).toBe(0.4);
  await page.locator('[data-close="settings-dialog"]').click();
  for (let i = 0; i < 3; i++) {
    await page.locator('#collapse-button').click();
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
    await page.locator('#edge-handle').click();
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');
    await expect(page.locator('#drawer')).toHaveCSS('opacity', '0.4');
    await expect(page.locator('#panel')).toHaveCSS('opacity', '1');
  }
  await page.reload();
  await expect(page.locator('#drawer')).toHaveCSS('opacity', '0.4');
  await page.locator('#settings-open').click();
  await page.evaluate(() => { window.sideTask.setSettings = async () => { throw new Error('模拟保存失败'); }; });
  await slider.fill('80');
  await slider.dispatchEvent('change');
  await expect(page.locator('#settings-message')).toContainText('模拟保存失败');
  await expect(slider).toHaveValue('60');
  await expect(page.locator('#drawer')).toHaveCSS('opacity', '0.4');
});

test('appearance and placement saves preserve existing task nodes', async ({ page }) => {
  await seed(page, [make('原有任务')]);
  await page.evaluate(() => { window.savedTaskNode = document.querySelector('.task-row'); });
  await page.evaluate(() => window.sideTask.setSettings({ panelOpacity: 0.7, themePreset: 'mist' }));
  expect(await page.evaluate(() => window.savedTaskNode === document.querySelector('.task-row'))).toBe(true);
  await page.evaluate(() => window.sideTask.setSettings({ windowPlacement: { mode: 'floating', edge: 'right', anchor: 0.5, displayId: null, floatCenter: { x: 0.5, y: 0.5 } } }));
  expect(await page.evaluate(() => window.savedTaskNode === document.querySelector('.task-row'))).toBe(true);
});
