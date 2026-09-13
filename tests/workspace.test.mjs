import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { calendarRange, shiftPeriod, periodSelection, projectRecurrences } from '../src/calendar.mjs';
import { defaultPlacement, displayForBounds, nearestDock, windowLayout, floatingPlacement, validatePlacement } from '../src/window-layout.mjs';
import { WindowController, AutoDockController } from '../src/window-controller.mjs';
import { createTask, emptyState, validateState, validateSettings } from '../src/domain.mjs';
import { TaskStore } from './reference/node-store.mjs';

test('weeks start Monday and month grids include leap day and adjacent months', () => {
  assert.deepEqual(calendarRange('week', '2027-01-01').dates, ['2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03']);
  const feb = calendarRange('month', '2028-02-29');
  assert.equal(feb.dates.length, 42);
  assert.equal(feb.start, '2028-01-31');
  assert.ok(feb.dates.includes('2028-02-29'));
  assert.equal(shiftPeriod('month', '2028-01-31', 1), '2028-02-01');
  assert.equal(periodSelection('week', '2026-09-15', '2026-09-08'), '2026-09-14');
});

test('recurrence previews respect calendar rhythm, bounds and real instances without modifying state', () => {
  const task = createTask({ title: '月末', dueDate: '2028-01-31', recurrence: { frequency: 'monthly', until: '2028-03-31' } }, '2028-01-01T00:00:00Z', 'monthly');
  const before = JSON.stringify(task);
  assert.deepEqual(projectRecurrences([task], '2028-02-01', '2028-03-31', '2028-01-31').map(p => p.date), ['2028-02-29','2028-03-31']);
  assert.equal(JSON.stringify(task), before);
  const stored = { ...task, id: 'stored', dueDate: '2028-02-29', completedAt: '2028-01-31T01:00:00Z' };
  assert.deepEqual(projectRecurrences([task, stored], '2028-02-01', '2028-03-31', '2028-01-31').map(p => p.date), ['2028-03-31']);
  assert.equal(projectRecurrences([task], '2028-04-01', '2028-05-01', '2028-01-31').length, 0);
});

test('overdue repeat previews start after today and weekdays skip weekends', () => {
  const task = createTask({ title: '工作日', dueDate: '2026-09-01', recurrence: { frequency: 'weekdays' } }, '2026-08-01T00:00:00Z', 'weekly');
  const previews = projectRecurrences([task], '2026-09-07', '2026-09-14', '2026-09-11');
  assert.deepEqual(previews, [{ kind: 'recurrence-preview', sourceTaskId: 'weekly', date: '2026-09-14' }]);
});

const area = { x: 0, y: 0, width: 1600, height: 1200 };
test('monitor selection keeps DIP coordinates across scaled, negative and off-screen bounds', () => {
  const displays = [
    { id: 'primary', scaleFactor: 1.25, bounds: { x: 0, y: 0, width: 2048, height: 1152 } },
    { id: 'secondary', scaleFactor: 1.25, bounds: { x: 2047, y: -84, width: 2048, height: 1280 } },
    { id: 'left', scaleFactor: 1.5, bounds: { x: -1708, y: -100, width: 1708, height: 960 } },
  ];
  assert.equal(displayForBounds(displays, { x: 1618, y: 131, width: 421, height: 851 }, 'secondary').id, 'primary');
  assert.equal(displayForBounds(displays, { x: 2200, y: 50, width: 420, height: 850 }, 'primary').id, 'secondary');
  assert.equal(displayForBounds(displays, { x: -800, y: -40, width: 420, height: 850 }).id, 'left');
  assert.equal(displayForBounds(displays, { x: -4000, y: -2000, width: 420, height: 850 }).id, 'left');
  assert.equal(displayForBounds(displays, { x: -210, y: 100, width: 420, height: 600 }, 'left').id, 'left');
});

test('nearest docking projects along all four edges and preserves tie preference', () => {
  for (const [edge, x, y] of [['left',10,175],['right',1170,175],['top',590,10],['bottom',590,340]]) {
    const p = nearestDock(area, { x,y,width:420,height:850 });
    assert.equal(p.edge, edge);
    const layout = windowLayout(area,p);
    assert.equal(layout.handleBounds.width, 40);
    assert.equal(layout.handleBounds.height, 40);
  }
  assert.equal(nearestDock(area,{x:0,y:0,width:420,height:850},{...defaultPlacement(),edge:'top'}).edge,'top');
});

test('placement stays accessible across small work areas and negative monitor coordinates', () => {
  for (const work of [area,{x:-1920,y:-100,width:1920,height:1040},{x:48,y:40,width:375,height:580}]) {
    for (const edge of ['left','right','top','bottom']) for (const anchor of [0,0.2,1]) {
      const layout = windowLayout(work,{...defaultPlacement(),edge,anchor},'month');
      for (const box of [layout.fullBounds,layout.handleBounds]) {
        assert.ok(box.x >= work.x && box.y >= work.y);
        assert.ok(box.x + box.width <= work.x + work.width);
        assert.ok(box.y + box.height <= work.y + work.height);
      }
    }
  }
  assert.throws(()=>validatePlacement({...defaultPlacement(),anchor:Infinity}), /位置/);
});

test('floating resize keeps its center and collapse reopens on the selected edge', () => {
  const p = floatingPlacement(area,{x:590,y:175,width:420,height:850});
  let native;
  const controller = new WindowController({placement:p,getArea:()=>area,setBounds:b=>native=b,emit(){}});
  controller.setView('month');
  assert.equal(native.width,1120);
  assert.equal(native.x+native.width/2,800);
  controller.reducedMotion=true;
  controller.collapse();
  controller.finish(controller.snapshot().transitionId);
  assert.equal(controller.snapshot().phase,'collapsed');
  controller.expand();
  controller.ready(controller.snapshot().transitionId);
  controller.finish(controller.snapshot().transitionId);
  assert.equal(controller.snapshot().placementMode,'docked');
  assert.equal(native.width,1120);
  controller.dispose();
});

test('collapsed handle dragging keeps the surface docked and relocates its edge', () => {
  let native;
  const controller = new WindowController({ expanded: false, placement: { ...defaultPlacement(), edge: 'right' }, getArea: () => area, setBounds: bounds => { native = bounds; }, emit() {} });
  controller.move({ x: 590, y: 0, width: 40, height: 40 });
  controller.endMove();
  assert.equal(controller.snapshot().expanded, false);
  assert.equal(controller.snapshot().placementMode, 'docked');
  assert.equal(controller.snapshot().dockSide, 'top');
  assert.deepEqual(controller.snapshot().bounds, { x: 590, y: 0, width: 40, height: 40 });
  controller.dispose();
});

test('auto docking starts synchronously, protects drafts, and resumes immediately', () => {
  let collapsed=0, canceled=0;
  const controller = new AutoDockController(()=>collapsed++,()=>canceled++);
  controller.update({focused:false}); assert.equal(collapsed,1);
  controller.update({focused:false}); assert.equal(collapsed,1);
  controller.update({protected:true}); assert.equal(canceled,1);
  controller.update({protected:false}); assert.equal(collapsed,2);
  controller.update({focused:true}); assert.equal(canceled,2);
  controller.update({focused:false,enabled:false}); assert.equal(collapsed,2);
  controller.update({enabled:true}); assert.equal(collapsed,3);
  controller.dispose();
  controller.update({focused:true}); assert.equal(canceled,2);
});

test('v2 upgrade preserves originals and task fields while adding themes and placement', async t => {
  const dir=await mkdtemp(path.join(os.tmpdir(),'sidetask-v2-upgrade-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const source={...emptyState(),version:2,settings:{dockSide:'left',autoCollapse:false,alwaysOnTop:true,launchAtLogin:false},tasks:[createTask({title:'迁移内容',dueDate:'2026-09-08',subtasks:[{id:'child',title:'子任务',completed:true}]})]};
  const raw=JSON.stringify(source);
  await writeFile(path.join(dir,'tasks.json'),raw);
  const store=new TaskStore(dir); await store.load();
  assert.equal(store.snapshot().version,3);
  assert.deepEqual(store.snapshot().tasks,source.tasks);
  assert.equal(store.snapshot().settings.windowPlacement.edge,'left');
  assert.equal(store.snapshot().settings.themePreset,'pine');
  assert.equal(await readFile(path.join(dir,'tasks.v2-original.json'),'utf8'),raw);
  await store.setSettings({themePreset:'graphite',calendarView:'month'});
  const again=new TaskStore(dir); await again.load();
  assert.equal(again.snapshot().settings.themePreset,'graphite');
  assert.equal(await readFile(path.join(dir,'tasks.v2-original.json'),'utf8'),raw);
  assert.throws(()=>validateState({...source,version:4}),/数据版本/);
  assert.throws(()=>validateSettings({themePreset:'unknown'}),/主题/);
});
