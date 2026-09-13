import { test, expect } from '@playwright/test';
import { assertVisibleHandle, clickVisibleHandle } from '../../scripts/window-checks.mjs';

test.beforeEach(async ({ page }) => {
  page.errors = [];
  page.on('pageerror', error => page.errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => window.sideTask.setSettings({ autoCollapse: false }));
});
test.afterEach(async ({ page }) => { expect(page.errors).toEqual([]); });

test('handle transparency persists, responds to interaction, and rolls back a failed save', async ({ page }) => {
  const handle = page.locator('#edge-handle');
  const slider = page.getByRole('slider', { name: '收起图标透明度' });
  await page.locator('#settings-open').click();
  await expect(slider).toHaveValue('20');
  await slider.press('End');
  await expect(page.locator('#settings-message')).toHaveText('已保存');
  await expect(slider).toHaveValue('80');
  await expect(page.locator('#handle-transparency-value')).toHaveText('80%');
  await page.locator('[data-close="settings-dialog"]').click();
  await expect(handle).toHaveCSS('opacity', '1');
  await page.locator('#collapse-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
  await page.mouse.move(0, 0);
  await expect(handle).toHaveCSS('opacity', '0.2');
  await handle.hover();
  await expect(handle).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await expect(handle).toHaveCSS('opacity', '0.2');
  await page.keyboard.press('Tab');
  await handle.focus();
  await expect(handle).toBeFocused();
  await expect(handle).toHaveCSS('opacity', '1');
  await handle.evaluate(element => element.blur());
  await expect(handle).toHaveCSS('opacity', '0.2');

  const box = await handle.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x - 30, box.y + 35, { steps: 5 });
  await expect(page.locator('body')).toHaveAttribute('data-dragging', 'true');
  await expect(handle).toHaveCSS('opacity', '1');
  await page.mouse.up();
  await expect(page.locator('body')).toHaveAttribute('data-dragging', 'false');
  await page.mouse.move(0, 0);
  await expect(handle).toHaveCSS('opacity', '0.2');
  await clickVisibleHandle(page);
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');

  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-open').click();
  await expect(slider).toHaveValue('80');
  await page.evaluate(() => {
    window.__savedSetSettings = window.sideTask.setSettings;
    window.sideTask.setSettings = async () => { throw new Error('模拟设置保存失败'); };
  });
  await slider.press('Home');
  await expect(page.locator('#settings-message')).toHaveText('模拟设置保存失败');
  await expect(slider).toHaveValue('80');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sidetask.preview.v3')).settings.collapsedHandleOpacity)).toBe(0.2);
  await page.evaluate(() => { window.sideTask.setSettings = window.__savedSetSettings; });
  await slider.press('Home');
  await expect(page.locator('#settings-message')).toHaveText('已保存');
  await expect(slider).toHaveValue('0');
});

test('a native-sized viewport keeps the handle visible before the collapse event arrives', async ({ page }) => {
  await page.evaluate(() => {
    const api = window.sideTask, finish = api.transitionFinished;
    window.__resizeFrames = [];
    api.transitionFinished = async id => {
      const { window: state } = await api.getState();
      if (state.expanded) return finish(id);
      const shell = document.getElementById('shell'), handle = document.getElementById('edge-handle');
      const before = handle.getBoundingClientRect().toJSON();
      // Model SetWindowPos taking effect before window:changed reaches the DOM.
      for (const [key, value] of Object.entries({ left: state.handleBounds.x, top: state.handleBounds.y,
        width: state.handleBounds.width, height: state.handleBounds.height })) shell.style[key] = value + 'px';
      for (let frame = 0; frame < 2; frame++) {
        await new Promise(requestAnimationFrame);
        const rect = handle.getBoundingClientRect(), bounds = shell.getBoundingClientRect();
        window.__resizeFrames.push({ edge: state.dockSide, phase: document.body.dataset.phase,
          inside: rect.left >= bounds.left - 0.5 && rect.top >= bounds.top - 0.5 && rect.right <= bounds.right + 0.5 && rect.bottom <= bounds.bottom + 0.5,
          hit: handle.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
          offset: Math.hypot(rect.x - before.x, rect.y - before.y), opacity: Number(getComputedStyle(handle).opacity) });
      }
      await finish(id);
      for (const key of ['left', 'top', 'width', 'height']) shell.style.removeProperty(key);
    };
  });
  for (const edge of ['right', 'left', 'top', 'bottom']) {
    await page.evaluate(async edge => {
      const { state } = await window.sideTask.getState();
      await window.sideTask.setSettings({ windowPlacement: { ...state.settings.windowPlacement, edge, mode: 'docked' } });
    }, edge);
    await page.locator('#collapse-button').click();
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
    await clickVisibleHandle(page);
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');
  }
  const frames = await page.evaluate(() => window.__resizeFrames);
  expect(frames).toHaveLength(8);
  for (const frame of frames) {
    expect(frame.phase).toBe('collapsing');
    expect(frame.inside, JSON.stringify(frame)).toBe(true);
    expect(frame.hit, JSON.stringify(frame)).toBe(true);
    expect(frame.offset, JSON.stringify(frame)).toBeLessThan(1);
    expect(frame.opacity).toBeGreaterThan(0);
  }
});

test('rapid pointer clicks leave a visible handle and settle to the last accepted toggle', async ({ page }) => {
  await page.locator('#collapse-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
  await page.evaluate(() => {
    window.__handleClicks = 0;
    document.getElementById('edge-handle').addEventListener('click', () => window.__handleClicks++);
  });
  for (let click = 0; click < 21; click++) {
    const box = await page.locator('#edge-handle').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    if (click % 3 === 0) await page.waitForTimeout(25);
  }
  const count = await page.evaluate(() => window.__handleClicks);
  expect(count).toBeGreaterThan(10);
  await expect(page.locator('body')).toHaveAttribute('data-phase', count % 2 ? 'expanded' : 'collapsed');
  await assertVisibleHandle(page);
  await page.evaluate(() => window.sideTask.collapse());
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
  await clickVisibleHandle(page);
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');
});

for (const focusBeforePointer of [false, true]) {
test('an outside click during opening leaves the handle reusable: focus ' + (focusBeforePointer ? 'before pointer' : 'on pointer'), async ({ page }) => {
  await page.locator('#collapse-button').click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
  await page.evaluate(async () => {
    const api = window.sideTask;
    await api.setSettings({ autoCollapse: true });
    // Hold the opening at a visible intermediate frame, then model a closing
    // acknowledgement delayed while the desktop window is unfocused.
    window.__openingPaused = false;
    const unsubscribe = api.onWindowChange(state => {
      if (!state.expanded || state.stage !== 'animate') return;
      for (const id of ['drawer', 'panel', 'edge-handle']) {
        for (const animation of document.getElementById(id).getAnimations()) {
          if (!(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)) {
            animation.pause();
            animation.currentTime = 80;
          }
        }
      }
      window.__openingPaused = true;
      unsubscribe();
    });
    const finish = api.transitionFinished;
    api.transitionFinished = async id => {
      const { window: state } = await api.getState();
      if (!state.expanded && !window.__delayedClose) {
        window.__delayedClose = id;
        api.transitionFinished = finish;
        return;
      }
      return finish(id);
    };
  });
  await clickVisibleHandle(page);
  await page.waitForFunction(() => window.__openingPaused);
  await page.mouse.click(10, 10);
  await page.waitForFunction(() => window.__delayedClose);
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsing');
  if (focusBeforePointer) {
    await page.evaluate(() => {
      // Windows can deliver focus before WebView2 delivers pointerdown. Hold
      // this reversal still just long enough to click its visible handle.
      window.dispatchEvent(new Event('focus'));
      const animations = ['drawer', 'panel', 'edge-handle'].flatMap(id => document.getElementById(id).getAnimations());
      animations.forEach(animation => animation.pause());
      document.getElementById('edge-handle').addEventListener('click', () => {
        animations.forEach(animation => animation.play());
      }, { once: true });
    });
    await expect(page.locator('body')).toHaveAttribute('data-focus-restored', 'true');
  }
  await clickVisibleHandle(page);
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');
  await page.evaluate(() => window.sideTask.transitionFinished(window.__delayedClose));
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');

  await page.mouse.click(10, 10);
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'collapsed');
  const point = await assertVisibleHandle(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x, point.y + 70, { steps: 4 });
  await expect(page.locator('body')).toHaveAttribute('data-dragging', 'true');
  await page.mouse.up();
  await expect(page.locator('body')).toHaveAttribute('data-dragging', 'false');
  await clickVisibleHandle(page);
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'expanded');
});
}

test('duplicate and older window events do not postpone or rewind an animation', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { SidebarMotion } = await import('/src/motion.mjs');
    const { window: base } = await window.sideTask.getState();
    const ready = [], finished = [];
    const motion = new SidebarMotion({ transitionReady: async id => { ready.push(id); }, transitionFinished: async id => { finished.push(id); } });
    const prepare = { ...base, transitionId: 100, expanded: true, surfaceExpanded: false, stage: 'prepare', phase: 'expanding' };
    for (let frame = 0; frame < 5; frame++) {
      motion.render({ ...prepare });
      await new Promise(requestAnimationFrame);
    }
    const animate = { ...prepare, surfaceExpanded: true, stage: 'animate' };
    motion.render(animate);
    motion.render(prepare);
    const stage = motion.previous.stage;
    for (let frame = 0; frame < 25; frame++) {
      motion.render({ ...animate });
      await new Promise(requestAnimationFrame);
    }
    motion.render({ ...animate, stage: 'settled', phase: 'expanded' });
    motion.render({ ...prepare, transitionId: 99 });
    return { ready, finished, stage, phase: document.body.dataset.phase };
  });
  expect(result).toEqual({ ready: [100], finished: [100], stage: 'animate', phase: 'expanded' });
});
