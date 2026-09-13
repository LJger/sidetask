import test from 'node:test';
import assert from 'node:assert/strict';
import { HANDLE_HEIGHT, HANDLE_WIDTH, PANEL_WIDTH, windowBounds } from '../src/window-layout.mjs';

test('docks the expanded panel inside the Windows taskbar work area', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const bounds = windowBounds(area, true);
  assert.equal(bounds.width, PANEL_WIDTH);
  assert.equal(bounds.x + bounds.width, 1920);
  assert.ok(bounds.y >= 0);
  assert.ok(bounds.y + bounds.height < area.height);
});

test('collapse leaves only a small handle centered at the edge', () => {
  assert.deepEqual(windowBounds({ x: 0, y: 0, width: 1920, height: 1040 }, false), { x: 1920 - HANDLE_WIDTH, y: (1040 - HANDLE_HEIGHT) / 2, width: HANDLE_WIDTH, height: HANDLE_HEIGHT });
});

test('supports left docking and negative coordinates on secondary monitors', () => {
  const area = { x: -1920, y: -100, width: 1920, height: 1040 };
  assert.equal(windowBounds(area, true, 'left').x, -1920);
  assert.equal(windowBounds(area, false, 'right').x, -HANDLE_WIDTH);
  assert.ok(windowBounds(area, true, 'left').y >= area.y);
});

test('fits smaller work areas and honors non-zero taskbar offsets', () => {
  const area = { x: 48, y: 40, width: 375, height: 580 };
  const bounds = windowBounds(area, true, 'right');
  assert.equal(bounds.x, 48);
  assert.equal(bounds.width, 375);
  assert.equal(bounds.height, 548);
  assert.ok(bounds.y >= 40);
  assert.ok(bounds.y + bounds.height <= 620);
});
