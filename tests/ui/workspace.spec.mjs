import { test, expect } from '@playwright/test';
import { createTask, emptyState } from '../../src/domain.mjs';
import { assertVisibleHandle, clickVisibleHandle } from '../../scripts/window-checks.mjs';
const fixed = '2026-09-08T10:00:00+08:00';
const make = (id, extra = {}) => ({ ...createTask({ title: id, dueDate: '2026-09-08' }, '2026-09-08T01:00:00Z', id), ...extra });
async function seed(page, data) {
  await page.evaluate(value => { localStorage.clear(); localStorage.setItem('sidetask.preview.v3', JSON.stringify(value)); }, data);
  await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-ready','true');
}
test.beforeEach(async ({ page }) => {
  page.errors=[]; page.on('pageerror',error=>page.errors.push(error.message));
  await page.clock.setFixedTime(new Date(fixed)); await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready','true');
});
test.afterEach(async ({page}) => { expect(page.errors).toEqual([]); });

test('four themes persist without changing window position or unsaved input', async ({page}) => {
  await page.locator('#task-title').fill('保留草稿');
  const before=await page.locator('#shell').boundingBox();
  await page.locator('#settings-open').click();
  for (const theme of ['mist','sand','graphite','pine','system']) {
    await page.locator('[data-theme-choice="'+theme+'"]').click();
    await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('sidetask.preview.v3'))?.settings.themePreset)).toBe(theme);
    expect(await page.locator('#shell').boundingBox()).toEqual(before);
  }
  await page.locator('[data-theme-choice="graphite"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','graphite');
  await page.locator('[data-close="settings-dialog"]').click();
  await expect(page.locator('#task-title')).toHaveValue('保留草稿');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme','graphite');
});

for (const reducedMotion of ['no-preference', 'reduce']) {
  test('every opening style persists and settles the panel fully visible: ' + reducedMotion, async ({page}) => {
    await page.emulateMedia({ reducedMotion });
    await seed(page, { ...emptyState(), tasks: [make('kept', { title: '保留任务' })] });
    await page.locator('#settings-open').click();
    await expect(page.locator('[data-motion-choice="slide"]')).toHaveAttribute('aria-pressed', 'true');
    for (const style of ['fade', 'pop', 'reveal', 'slide']) {
      await page.locator('[data-motion-choice="' + style + '"]').click();
      await expect(page.locator('[data-motion-choice="' + style + '"]')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('sidetask.preview.v3'))?.settings.motionStyle)).toBe(style);
    }
    await page.locator('[data-close="settings-dialog"]').click();
    for (const style of ['fade', 'pop', 'reveal', 'slide']) {
      await page.evaluate(value => window.sideTask.setSettings({ motionStyle: value }), style);
      await expect(page.locator('body')).toHaveAttribute('data-motion', style);
      for (const dock of ['right', 'top']) {
        await page.evaluate(edge => window.sideTask.setSettings({ windowPlacement: { mode: 'docked', edge, anchor: 0.5, displayId: null, floatCenter: { x: 0.5, y: 0.5 } } }), dock);
        await expect(page.locator('body')).toHaveAttribute('data-dock', dock);
        await page.locator('#collapse-button').click();
        await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
        await assertVisibleHandle(page);
        await clickVisibleHandle(page);
        await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');
        const settled = await page.locator('#panel').evaluate(panel => {
          const identity = value => value === 'none' || value === 'matrix(1, 0, 0, 1, 0, 0)';
          const computed = getComputedStyle(panel);
          return { opacity: computed.opacity, transform: identity(computed.transform), clip: computed.clipPath, animations: panel.getAnimations().length,
            drawer: identity(getComputedStyle(document.getElementById('drawer')).transform) };
        });
        expect(settled).toEqual({ opacity: '1', transform: true, clip: 'inset(0px)', animations: 0, drawer: true });
        await expect(page.locator('.task-title')).toHaveText('保留任务');
      }
    }
  });
}

test('day week month share selected dates, and repeat previews stay outside storage and counts', async ({page}) => {
  await seed(page,{...emptyState(),tasks:[make('daily',{title:'每日回顾',recurrence:{frequency:'daily',anchorDate:'2026-09-08',until:'2026-09-20'},seriesId:'daily'})]});
  await page.locator('#tab-week').click();
  await expect(page.locator('.calendar-day')).toHaveCount(7);
  await expect(page.locator('.is-preview')).toHaveCount(5);
  await expect(page.locator('#handle-count')).toHaveText('1');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('sidetask.preview.v3')).tasks.length)).toBe(1);
  await page.locator('.is-preview .calendar-task').first().click();
  await expect(page.locator('#preview-dialog')).toBeVisible();
  await expect(page.locator('#preview-date')).toContainText('2026-09-09');
  await page.locator('[data-close="preview-dialog"]').click();
  await page.locator('#tab-month').click();
  await expect(page.locator('.calendar-day')).toHaveCount(42);
  await page.locator('[data-date="2026-09-15"] .calendar-date').click();
  await page.locator('#tab-day').click();
  await expect(page.locator('#period-label')).toHaveText('9月15日 周二');
  await expect(page.locator('.preview-row')).toHaveCount(1);
  await expect(page.locator('#composer-date-label')).toContainText('9月15日');
  await page.locator('#task-title').fill('选中日期新增');
  await page.locator('#task-title').press('Enter');
  await expect(page.locator('.task-title')).toHaveText('选中日期新增');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('sidetask.preview.v3')).tasks.find(task=>task.title==='选中日期新增').dueDate)).toBe('2026-09-15');
});

test('future-only empty state and cross-period search explain where tasks are', async ({page}) => {
  await seed(page,{...emptyState(),tasks:[make('future',{title:'未来分享',dueDate:'2026-10-02'})]});
  await expect(page.locator('#empty-title')).toHaveText('今天还没有安排');
  await page.locator('#search-toggle').click();
  await page.locator('#search-input').fill('未来分享');
  await expect(page.locator('#empty-title')).toHaveText('没有匹配的任务');
  await page.locator('#empty-action').click();
  await expect(page.locator('.task-title')).toHaveText('未来分享');
  await expect(page.locator('#search-scope')).toHaveValue('all');
});

test('browser dragging docks to each nearest edge and reopens beside its handle', async ({page}) => {
  await page.setViewportSize({width:1600,height:1200});
  for (const [edge,x,y] of [['left',10,175],['right',1170,175],['top',590,10],['bottom',590,340]]) {
    await expect(page.locator('body')).toHaveAttribute('data-phase','expanded');
    const header=await page.locator('.app-header').boundingBox();
    const shell=await page.locator('#shell').boundingBox();
    const sx=header.x+header.width/2, sy=header.y+15;
    await page.mouse.move(sx,sy); await page.mouse.down();
    await page.mouse.move(sx+x-shell.x,sy+y-shell.y,{steps:8}); await page.mouse.up();
    await expect(page.locator('body')).toHaveAttribute('data-placement','floating');
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    await expect(page.locator('body')).toHaveAttribute('data-phase','collapsed',{timeout:6000});
    await expect(page.locator('body')).toHaveAttribute('data-dock',edge);
    const handle=await page.locator('#shell').boundingBox();
    expect(handle.width).toBe(40);
    expect(handle.height).toBe(40);
    await clickVisibleHandle(page);
    await expect(page.locator('body')).toHaveAttribute('data-phase','expanded');
    const open=await page.locator('#shell').boundingBox();
    if(edge==='left') expect(open.x).toBe(0);
    if(edge==='right') expect(open.x+open.width).toBe(1600);
    if(edge==='top') expect(open.y).toBe(0);
    if(edge==='bottom') expect(open.y+open.height).toBe(1200);
  }
});

test('draft protects against automatic docking and release starts it immediately', async ({page}) => {
  await page.locator('#task-title').fill('未保存的草稿');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await page.waitForTimeout(1500);
  await expect(page.locator('body')).toHaveAttribute('data-phase','expanded');
  await page.locator('#task-title').fill('');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await expect(page.locator('body')).toHaveAttribute('data-phase','collapsed');
  await assertVisibleHandle(page);
});

test('the number itself can be dragged to every edge without opening the panel', async ({page}) => {
  await page.setViewportSize({width:1600,height:1200});
  const state = emptyState();
  state.settings.autoCollapse = false;
  state.tasks = [make('counted-parent', {subtasks:[{id:'child',title:'child',completed:false}]})];
  await seed(page, state);
  await page.locator('#collapse-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase','collapsed');
  for (const [edge,x,y] of [['left',0,320],['top',500,0],['right',1560,400],['bottom',600,1160]]) {
    const handle = await page.locator('#edge-handle').boundingBox();
    const start = {x:handle.x+handle.width/2,y:handle.y+handle.height/2};
    await page.mouse.move(start.x,start.y); await page.mouse.down();
    await page.mouse.move(x+20,y+20,{steps:12}); await page.mouse.up();
    await expect(page.locator('body')).toHaveAttribute('data-phase','collapsed');
    await expect(page.locator('body')).toHaveAttribute('data-dragging','false');
    await expect(page.locator('body')).toHaveAttribute('data-dock',edge);
    await expect(page.locator('#handle-count')).toHaveText('1');
    await assertVisibleHandle(page);
  }
  const placement = await page.evaluate(()=>JSON.parse(localStorage.getItem('sidetask.preview.v3')).settings.windowPlacement);
  expect(placement.edge).toBe('bottom');
  await clickVisibleHandle(page);
  await expect(page.locator('body')).toHaveAttribute('data-phase','expanded');
  await page.locator('#collapse-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase','collapsed');
  const handle = await page.locator('#edge-handle').boundingBox();
  await page.mouse.move(handle.x+20,handle.y+20); await page.mouse.down();
  await page.mouse.move(handle.x+23,handle.y+20); await page.mouse.up();
  await expect(page.locator('body')).toHaveAttribute('data-phase','expanded');
});

test('blur begins collapse before any delay and quick focus cancels automatic motion', async ({page}) => {
  const phase = await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    return document.body.dataset.phase;
  });
  expect(phase).toBe('collapsing');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.locator('body')).toHaveAttribute('data-phase','expanded');
});

for (const reducedMotion of ['no-preference', 'reduce']) {
  test('collapsed handles stay visible and clickable in all calendar views: ' + reducedMotion, async ({page}) => {
    await page.emulateMedia({ reducedMotion });
    for (const calendarView of ['day', 'week', 'month']) {
      for (const [edge, anchor] of [['right', 0.15], ['left', 0.85], ['top', 0.3], ['bottom', 0.7]]) {
        const state = emptyState();
        state.settings = { ...state.settings, calendarView, autoCollapse: false,
          windowPlacement: { ...state.settings.windowPlacement, edge, anchor } };
        await seed(page, state);
        await expect(page.locator('body')).toHaveAttribute('data-view', calendarView);
        await page.locator('#collapse-button').click();
        await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
        await expect(page.locator('body')).toHaveAttribute('data-dock', edge);
        await clickVisibleHandle(page);
        await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');
        await expect(page.locator('#task-title')).toBeInViewport();
      }
    }
  });
}

test('month overflow opens a day agenda and narrow calendar stays navigable', async ({page}) => {
  await seed(page,{...emptyState(),tasks:Array.from({length:9},(_,index)=>make('task-'+index))});
  await page.locator('#tab-month').click();
  await expect(page.locator('.calendar-day')).toHaveCount(42);
  await page.locator('[data-date="2026-09-08"] .calendar-more').click();
  await expect(page.locator('#day-tasks .task-row')).toHaveCount(9);
  await page.locator('[data-close="day-dialog"]').click();
  await page.setViewportSize({width:375,height:580});
  await expect(page.locator('#tab-day')).toBeInViewport();
  await expect(page.locator('#tab-month')).toBeInViewport();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(375);
  await page.locator('#tab-day').click();
  await expect(page.locator('.task-row')).toHaveCount(9);
});
