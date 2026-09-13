import { expect } from '@playwright/test';

export async function assertVisibleHandle(page) {
  // A locator click can scroll an offscreen handle into view and hide a rendering bug.
  const result = await page.evaluate(() => {
    const handle = document.getElementById('edge-handle');
    const rect = handle.getBoundingClientRect();
    const shell = document.getElementById('shell').getBoundingClientRect();
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    return {
      point,
      runtime: document.body.dataset.runtime,
      view: document.body.dataset.view,
      dock: document.body.dataset.dock,
      pixelRatio: devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
      inside: rect.left >= shell.left - 0.5 && rect.top >= shell.top - 0.5 && rect.right <= shell.right + 0.5 && rect.bottom <= shell.bottom + 0.5,
      hittable: handle.contains(document.elementFromPoint(point.x, point.y)),
      handle: rect.toJSON(), shell: shell.toJSON(),
    };
  });
  // Windows can clip a fraction of a CSS pixel when converting native bounds
  // at mixed display scales; the bounds and hit tests below remain mandatory.
  await expect(page.locator('#edge-handle'), JSON.stringify(result)).toBeInViewport({ ratio: result.runtime === 'tauri' ? 0.99 : 1 });
  expect(result.inside, JSON.stringify(result)).toBe(true);
  expect(result.hittable, JSON.stringify(result)).toBe(true);
  return result.point;
}

export async function clickVisibleHandle(page) {
  const point = await assertVisibleHandle(page);
  await page.mouse.click(point.x, point.y);
}
