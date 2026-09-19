import { remote } from 'webdriverio';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { emptyState, createTask, localDate } from '../src/domain.mjs';

if (process.platform !== 'win32') throw new Error('原生桌面测试需在 Windows 运行；浏览器测试请使用 npm run test:ui。');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const executable = path.resolve(process.env.SIDETASK_TEST_EXECUTABLE || path.join(root, 'src-tauri/target/x86_64-pc-windows-msvc/release/SideTask.exe'));
const edgeDriver = process.env.SIDETASK_EDGE_DRIVER || 'msedgedriver.exe';
const directory = await mkdtemp(path.join(os.tmpdir(), 'sidetask-native-'));
console.log('Native test data: ' + directory);
const scale = process.env.SIDETASK_TEST_SCALE ? Number(process.env.SIDETASK_TEST_SCALE) : null;
if (scale !== null && ![1,1.25,1.5,2].includes(scale)) throw new Error('Unsupported scale');
const seed = emptyState();
seed.settings.autoCollapse = false;
await writeFile(path.join(directory, 'tasks.json'), JSON.stringify(seed));
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const port = await freePort();
const child = spawn(edgeDriver, ['--port=' + port, '--verbose', '--log-path=' + path.join(directory, 'edgedriver.log')], { windowsHide: true });
let logs = '', spawnError;
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
child.on('error', error => { spawnError = error; });
let driver, appProcess, appClosed;
const waitPhase = async phase => driver.waitUntil(async () => (await driver.execute(() => document.body.dataset.phase)) === phase, { timeout: 10000, timeoutMsg: 'Window did not settle to ' + phase });
const state = () => driver.execute(() => window.sideTask.getState());
const invoke = (command, args = {}) => driver.execute((command, args) => window.__TAURI__.core.invoke('request', { command, args }), command, args);
const click = async selector => (await driver.$(selector)).click();
const powershell = (script, args) => new Promise((resolve,reject)=>{
  const process = spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts',script),...args],{windowsHide:true});
  let stdout='',stderr=''; process.stdout.on('data',data=>stdout+=data); process.stderr.on('data',data=>stderr+=data);
  process.on('error',reject); process.on('close',code=>code===0?resolve(stdout):reject(new Error(stderr||stdout)));
});
const windowInfo = async(action='Info')=>{
  const output=await powershell('native-window.ps1',['-Executable',executable,'-Action',action]);
  const prefix='SIDETASK_PROBE:';
  const result=output.split(/\r?\n/).find(line=>line.startsWith(prefix));
  if(!result) throw new Error('Missing native window diagnostics: '+output);
  return JSON.parse(result.slice(prefix.length));
};
async function nativeDragTo(x,y,collapsed=true) {
  const native=await windowInfo('Focus');
  const origin=collapsed?native.visibleBounds:native.bounds;
  const offset=await driver.execute(collapsed=>{
    const target=document.querySelector(collapsed?'#edge-handle':'.app-header').getBoundingClientRect();
    return {x:target.x+target.width/2,y:target.y+(collapsed?target.height/2:12),width:innerWidth,height:innerHeight};
  },collapsed);
  await powershell('native-drag.ps1',['-WindowHandle',native.handle,'-OffsetX',String(offset.x),'-OffsetY',String(offset.y),
    '-ViewportWidth',String(offset.width),'-ViewportHeight',String(offset.height),'-DeltaX',String(x-origin.x),'-DeltaY',String(y-origin.y),
    '-LogicalWidth',String(native.bounds.width),'-LogicalHeight',String(native.bounds.height)]);
  await driver.waitUntil(async()=>(await state()).window.dragging===false,{timeout:5000});
}
const visibleHandle = async () => {
  const result = await driver.execute(() => {
    const handle = document.getElementById('edge-handle'), box = handle.getBoundingClientRect();
    const point = {x:box.left+box.width/2,y:box.top+box.height/2};
    return {width:box.width,height:box.height,x:box.x,y:box.y,innerWidth,innerHeight,point,
      hit:handle.contains(document.elementFromPoint(point.x,point.y))};
  });
  assert.ok(result.x >= -0.5 && result.y >= -0.5 && result.x+result.width <= result.innerWidth+0.5 && result.y+result.height <= result.innerHeight+0.5, JSON.stringify(result));
  assert.ok(result.hit, JSON.stringify(result));
  return result.point;
};
async function clickHandle() {
  const point = await visibleHandle();
  await driver.performActions([{type:'pointer',id:'mouse',parameters:{pointerType:'mouse'},actions:[
    {type:'pointerMove',duration:0,x:Math.round(point.x),y:Math.round(point.y),origin:'viewport'},
    {type:'pointerDown',button:0},{type:'pointerUp',button:0},
  ]}]);
  await driver.releaseActions();
}
async function connect(args = []) {
  // Attach to our explicit port: the app owns its WebView2 data directory, so
  // EdgeDriver's launch mode looks for DevToolsActivePort in the wrong profile.
  // https://learn.microsoft.com/microsoft-edge/webview2/how-to/webdriver
  const debugPort = await freePort();
  const browserArgs = ['--remote-debugging-port=' + debugPort, '--remote-debugging-address=127.0.0.1'];
  if (scale) browserArgs.push('--force-device-scale-factor=' + scale);
  let appError;
  appProcess = spawn(executable, args, { windowsHide: true,
    env: { ...process.env, SIDETASK_USER_DATA: directory, SIDETASK_TEST_MODE: '1', SIDETASK_DIAGNOSTICS: '1',
      SIDETASK_TEST_BROWSER_ARGS: browserArgs.join(' ') } });
  appClosed = new Promise(resolve => {
    appProcess.once('exit', resolve);
    appProcess.once('error', error => { appError = error; resolve(); });
  });
  appProcess.stdout.on('data', chunk => { logs += chunk; });
  appProcess.stderr.on('data', chunk => { logs += chunk; });
  const deadline = Date.now() + 60000;
  while (true) {
    if (appError) throw appError;
    if (appProcess.exitCode !== null) throw new Error('Application exited before WebView2 was ready: ' + appProcess.exitCode);
    try { if ((await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch {}
    if (Date.now() >= deadline) throw new Error('WebView2 debugging endpoint did not become ready');
    await delay(100);
  }
  // Let EdgeDriver report its own startup failure, including on a cold CI host.
  driver = await remote({ hostname:'127.0.0.1',port,path:'/',logLevel:'warn',connectionRetryCount:0,connectionRetryTimeout:120000,
    capabilities:{ browserName:'webview2', 'ms:edgeOptions': { debuggerAddress:`127.0.0.1:${debugPort}` } } });
  await driver.waitUntil(() => driver.execute(() => document.body.dataset.ready === 'true'), { timeout:15000 });
  const fatal = await driver.execute(() => document.getElementById('fatal-error').hidden ? null : document.getElementById('fatal-message').textContent);
  assert.equal(fatal,null);
  await driver.execute(() => { window.__testErrors=[]; addEventListener('error',event=>window.__testErrors.push(event.message)); });
}
async function stopApp() {
  try { await invoke('app:quit'); } catch { /* The response may race normal process exit. */ }
  try { await driver.deleteSession(); } catch { /* Already stopped. */ }
  driver = null;
  await Promise.race([appClosed, delay(5000)]);
  if (appProcess.exitCode === null) { appProcess.kill(); await appClosed; }
  appProcess = null;
}

try {
  for (let attempt=0;attempt<100;attempt++) {
    if (spawnError) throw spawnError;
    try { if ((await fetch(`http://127.0.0.1:${port}/status`)).ok) break; } catch {}
    if (attempt===99) throw new Error('WebDriver did not start: '+logs);
    await delay(100);
  }
  await connect();
  const initial = await state();
  assert.equal(initial.info.runtime,'tauri');
  assert.equal(initial.info.version,version);
  assert.equal(path.resolve(initial.info.dataPath),path.resolve(directory));
  assert.equal(initial.state.tasks.length,0);
  assert.equal(await driver.execute(()=>typeof window.require),'undefined');
  console.log('Native startup',JSON.stringify(initial.window.monitor));
  await waitPhase('expanded');
  await (await driver.$('#task-title')).setValue('原生后台保存检查');
  await click('#add-task');
  await driver.waitUntil(async()=> (await state()).state.tasks.length===1,{timeout:5000});
  const saved = (await state()).state.tasks[0];
  assert.equal(saved.title,'原生后台保存检查');
  assert.equal(JSON.parse(await readFile(path.join(directory,'tasks.json'),'utf8')).tasks[0].id,saved.id);
  console.log('Native save passed');
  for (const view of process.env.SIDETASK_TEST_QUICK==='1'?[]:['day','week','month']) {
    await click('#tab-'+view);
    for (const edge of ['left','right','top','bottom']) {
      for (const reduced of [false,true]) {
        await driver.execute(async(edge,reduced)=>{
          const current=await window.sideTask.getState();
          await window.sideTask.setReducedMotion(reduced);
          await window.sideTask.setSettings({windowPlacement:{...current.state.settings.windowPlacement,mode:'docked',edge,anchor:0.35}});
        },edge,reduced);
        await click('#collapse-button');
        await waitPhase('collapsed');
        await visibleHandle();
        assert.equal((await state()).window.dockSide,edge);
        await clickHandle();
        await waitPhase('expanded');
      }
    }
  }
  if (process.env.SIDETASK_TEST_QUICK!=='1') console.log('24 native handle combinations passed');
  await click('#tab-day');
  if (process.env.SIDETASK_TEST_NATIVE_DRAG !== '0') {
    // Real cross-process input, not just the shape of our own clipped region.
    for (const edge of ['left', 'right', 'top', 'bottom']) {
      await driver.execute(async edge => {
        const current = await window.sideTask.getState();
        await window.sideTask.setSettings({ windowPlacement: { ...current.state.settings.windowPlacement, mode: 'docked', edge, anchor: 0.5 } });
        await window.sideTask.collapse();
      }, edge);
      await waitPhase('collapsed');
      const native = await windowInfo();
      await powershell('native-input.ps1', ['-WindowHandle', native.handle,
        '-X', String(Math.round(native.bounds.x + native.bounds.width / 2)),
        '-Y', String(Math.round(native.bounds.y + native.bounds.height / 2))]);
      await clickHandle(); await waitPhase('expanded');
    }
    const full = (await state()).window;
    const native = await windowInfo();
    const probeArea = full.monitor.workArea;
    const x = full.hostBounds.x + full.hostBounds.width / 2 > probeArea.x + probeArea.width / 2 ? probeArea.x + 150 : probeArea.x + probeArea.width - 150;
    await powershell('native-input.ps1', ['-WindowHandle', native.handle, '-X', String(Math.round(x)), '-Y', String(Math.round(probeArea.y + 200))]);
    console.log('Underlying window click, wheel, menu and focus checks passed');
    const displays=(await windowInfo()).displays;
    const targets=scale?displays.filter(display=>display.primary):displays;
    for (const display of targets) {
      await driver.execute(async id=>{
        const current=await window.sideTask.getState();
        await window.sideTask.setSettings({windowPlacement:{...current.state.settings.windowPlacement,displayId:id,edge:'right',mode:'docked',anchor:0.4}});
      },display.id);
      await click('#collapse-button'); await waitPhase('collapsed');
      const {workArea:area,scale:nativeScale}= (await state()).window.monitor;
      for (const [edge,x,y] of [['left',area.x+8,area.y+200],['top',area.x+area.width/2,area.y+8],
        ['right',area.x+area.width-40*nativeScale-8,area.y+300],['bottom',area.x+area.width/2,area.y+area.height-40*nativeScale-8]]) {
        await nativeDragTo(x,y);
        await waitPhase('collapsed');
        const current=(await state()).window;
        assert.equal(current.monitor.id,display.id);
        assert.equal(current.dockSide,edge);
        await visibleHandle();
        const measured=(await windowInfo()).visibleBounds;
        const boundary=edge==='left'?measured.x-area.x:edge==='right'?measured.x+measured.width-area.x-area.width:
          edge==='top'?measured.y-area.y:measured.y+measured.height-area.y-area.height;
        assert.ok(Math.abs(boundary)<=1,JSON.stringify({edge,measured,area}));
      }
      await clickHandle(); await waitPhase('expanded');
      console.log('Real mouse drag passed',display.id,nativeScale);
    }
    if (!scale && displays.length>1) {
      const current=(await state()).window.monitor.id;
      const target=displays.find(display=>display.id!==current);
      await click('#collapse-button'); await waitPhase('collapsed');
      await nativeDragTo(target.workArea.x+target.workArea.width/2,target.workArea.y+8);
      assert.equal((await state()).window.monitor.id,target.id);
      await visibleHandle(); await clickHandle(); await waitPhase('expanded');
      console.log('Real cross-monitor handle drag passed');
    }
    await windowInfo('Focus');
    const area=(await state()).window.monitor.workArea;
    await nativeDragTo(area.x+50,area.y+100,false);
    assert.equal((await state()).window.placementMode,'floating');
  }
  await driver.execute(()=>window.sideTask.setSettings({autoCollapse:true}));
  await windowInfo('Focus');
  await windowInfo('Other');
  await waitPhase('collapsed'); await visibleHandle();
  await clickHandle(); await waitPhase('expanded');
  await (await driver.$('#task-title')).setValue('失焦时保留草稿');
  await windowInfo('Other');
  assert.equal((await state()).window.phase,'expanded');
  assert.equal(await (await driver.$('#task-title')).getValue(),'失焦时保留草稿');
  await (await driver.$('#task-title')).clearValue();
  await windowInfo('Focus');
  await driver.execute(()=>window.sideTask.setSettings({autoCollapse:false}));
  console.log('Native focus collapse and draft protection passed');
  const results=await driver.execute(async()=>Promise.all(Array.from({length:25},(_,index)=>window.sideTask.addTask({title:'并发 '+index}))));
  assert.equal(new Set(results.map(result=>result.result.id)).size,25);
  assert.equal((await state()).state.tasks.length,26);
  await mkdir(path.join(directory,'tasks.json.tmp'));
  await (await driver.$('#task-title')).setValue('写入失败后的草稿');
  await click('#add-task');
  await driver.waitUntil(async()=>await driver.execute(()=>document.getElementById('save-indicator').dataset.status==='error'),{timeout:5000});
  assert.equal(await (await driver.$('#task-title')).getValue(),'写入失败后的草稿');
  assert.equal((await state()).state.tasks.length,26);
  await rm(path.join(directory,'tasks.json.tmp'),{recursive:true});
  await click('#add-task');
  await driver.waitUntil(async()=>(await state()).state.tasks.length===27,{timeout:5000});
  const recurrence=await driver.execute(async()=>{
    const category=await window.sideTask.saveTaxonomy('categories',{name:'原生分类'});
    const tag=await window.sideTask.saveTaxonomy('tags',{name:'原生标签'});
    const task=await window.sideTask.addTask({title:'重复安排',dueDate:'2027-01-31',categoryId:category.result.id,tagIds:[tag.result.id],
      recurrence:{frequency:'monthly'},subtasks:[{id:'native-child',title:'核对',completed:false}]});
    const completion=await window.sideTask.updateTask(task.result.id,{completed:true},task.result.updatedAt);
    const next=completion.state.tasks.find(item=>item.previousId===task.result.id);
    const undone=await window.sideTask.undoCompletion(completion.undoToken);
    return {before:task.result,next,restored:undone.state.tasks.find(item=>item.id===task.result.id),count:undone.state.tasks.length};
  });
  assert.equal(recurrence.next.dueDate,'2027-02-28');
  assert.deepEqual(recurrence.restored,recurrence.before);
  assert.equal(recurrence.count,28);
  console.log('Native concurrent transactions, failed-save recovery and recurrence undo passed');
  if (process.env.SIDETASK_TEST_FILE_DIALOGS==='1') {
    const file=path.join(directory,'exported-backup.json');
    await click('#settings-open');
    await click('#export-data');
    await powershell('native-file-dialog.ps1',['-Executable',executable,'-DialogTitle','导出侧记备份','-FilePath',file]);
    await driver.waitUntil(async()=> (await (await driver.$('#settings-message')).getText()).includes('备份已导出'),{timeout:10000});
    const exported=JSON.parse(await readFile(file,'utf8'));
    assert.equal(exported.version,3); assert.equal(exported.tasks.length,28);
    exported.tasks.push(createTask({title:'通过原生对话框导入'},new Date().toISOString(),'native-file-import'));
    exported.settings.themePreset='sand';
    await writeFile(file,JSON.stringify(exported));
    await click('#import-data');
    await powershell('native-file-dialog.ps1',['-Executable',executable,'-DialogTitle','导入侧记备份','-FilePath',file]);
    await powershell('native-file-dialog.ps1',['-Executable',executable,'-DialogTitle','导入任务','-ButtonName','导入']);
    await driver.waitUntil(async()=> (await state()).state.tasks.some(task=>task.id==='native-file-import'),{timeout:10000});
    assert.equal((await state()).state.settings.themePreset,'pine');
    await click('[data-close="settings-dialog"]');
    console.log('Native export, import confirmation and settings preservation passed');
  }
  assert.deepEqual(await driver.execute(()=>window.__testErrors),[]);
  await stopApp();
  const beforeRestart=JSON.parse(await readFile(path.join(directory,'tasks.json'),'utf8'));
  const due=new Date(Date.now()-120000);
  const missed=createTask({title:'启动补提醒',dueDate:localDate(due),dueTime:due.toTimeString().slice(0,5),reminder:{offsetMinutes:0}},
    new Date(due.getTime()-3600000).toISOString(),'missed-native');
  beforeRestart.tasks.push(missed);
  await writeFile(path.join(directory,'tasks.json'),JSON.stringify(beforeRestart));
  await connect(['--hidden']);
  await waitPhase('collapsed');
  await visibleHandle();
  assert.equal((await state()).state.tasks[0].id,saved.id);
  assert.ok((await state()).state.tasks.find(task=>task.id==='missed-native').reminderSentKey);
  await clickHandle(); await waitPhase('expanded');
  await stopApp();
  await connect(['--hidden']);
  await waitPhase('collapsed');
  const notices=(await readFile(path.join(directory,'test-notifications.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(notices.filter(notice=>notice.taskIds.includes('missed-native')).length,1);
  await stopApp();
  console.log('Hidden startup and restart persistence passed');
  console.log('Native desktop checks passed. Test data: '+directory);
} catch (error) {
  try { console.error('Native window probe', JSON.stringify(await windowInfo())); }
  catch (probeError) { console.error('Native window probe failed', probeError.message); }
  if (driver) {
    try {
      const current=await state();
      console.error('Window diagnostics',JSON.stringify({info:current.info,window:current.window}));
      await mkdir(path.join(root,'test-results'),{recursive:true});
      await driver.saveScreenshot(path.join(root,'test-results','native-failure.png'));
    } catch {}
  }
  console.error(logs.slice(-7000));
  throw error;
} finally {
  if (driver) await stopApp();
  if (appProcess && appProcess.exitCode === null) { appProcess.kill(); await appClosed; }
  child.kill();
  const artifacts = path.join(root, 'test-results', 'native');
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, 'driver.log'), logs);
  for (const name of ['window-diagnostics.jsonl', 'test-notifications.jsonl', 'edgedriver.log']) {
    try { await cp(path.join(directory, name), path.join(artifacts, name)); }
    catch (error) { if (error.code !== 'ENOENT') console.error('Could not collect ' + name, error.message); }
  }
}
