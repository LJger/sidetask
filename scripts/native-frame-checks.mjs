import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

function probe(root, script, args, readyLine) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', script), ...args], { windowsHide: true });
  let output = '', errors = '', readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => { readyReject(new Error('Probe startup timed out: '+errors)); child.kill(); }, 15000);
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(readyLine)) { clearTimeout(timer); readyResolve(); }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      readyReject(new Error('Probe exited before readiness: '+errors));
      code === 0 ? resolve(output) : reject(new Error(errors || output || 'Probe exited with '+code));
    });
  });
  // A probe can fail while the test is still awaiting a WebDriver command.
  done.catch(() => {});
  return { child, ready, done };
}

function result(output, prefix) {
  const line = output.split(/\r?\n/).find(line => line.startsWith(prefix));
  assert.ok(line, 'Missing probe result: '+output);
  return JSON.parse(line.slice(prefix.length));
}

export async function checkNativeFrames({root, directory, executable, driver, state, invoke, waitPhase, clickHandle, windowInfo, click}) {
  const cycleCount = Number(process.env.SIDETASK_TEST_FRAME_CYCLES || 200);
  assert.ok(Number.isInteger(cycleCount) && cycleCount >= 2 && cycleCount <= 1000, 'Frame cycles must be an integer from 2 to 1000');
  const original = (await state()).state.settings;
  await invoke('settings:set', {patch: {autoCollapse:false,
    windowPlacement:{...original.windowPlacement, mode:'docked', edge:'left', anchor:0.5}}});
  await invoke('window:set-expanded', {expanded:true});
  await waitPhase('expanded');
  const native = await windowInfo();
  const artifacts = path.join(root, 'test-results', 'native-frames-'+Date.now());
  await mkdir(artifacts, {recursive:true});
  const stopFile = path.join(directory, 'frame-watch.stop');
  const watcher = probe(root, 'native-window.ps1', ['-Executable', executable, '-Action', 'WatchFrame',
    '-WatchMilliseconds', '900000', '-StopFile', stopFile], 'SIDETASK_FRAME_WATCH_READY');
  let recorder, activeFocusProbe;
  const report = {cycles:[], focus:[], focusReversals:0, altF4:0, recording:null};
  try {
    await watcher.ready;
    if (process.env.SIDETASK_TEST_FRAME_FFMPEG) {
      recorder = probe(root, 'native-record.ps1', ['-Ffmpeg', process.env.SIDETASK_TEST_FRAME_FFMPEG,
        '-Output', path.join(artifacts,'desktop.webm'), '-StopFile', stopFile,
        '-X', String(native.bounds.x), '-Y', String(native.bounds.y),
        '-Width', String(native.bounds.width), '-Height', String(native.bounds.height)], 'SIDETASK_RECORD_READY');
      await recorder.ready;
    }
    for (const alwaysOnTop of [false, true]) {
      await invoke('settings:set', {patch:{autoCollapse:false, alwaysOnTop}});
      await invoke('window:set-expanded', {expanded:true});
      await waitPhase('expanded');
      assert.equal(Boolean((await windowInfo()).frame.exStyle & 8), alwaysOnTop);
      await invoke('window:collapse');
      await waitPhase('collapsed');
      for (let cycle = 0; cycle < cycleCount; cycle++) {
        if (cycle % 2 === 0) {
          await clickHandle();
          await waitPhase('expanded');
          await click('#collapse-button');
        } else {
          await driver.execute(async cycle => {
            const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
            const api = window.sideTask;
            await api.setExpanded(true);
            await pause([10, 60, 120][cycle % 3]);
            await api.setExpanded(false);
            await pause(20);
            await api.setExpanded(true);
            await pause(30);
            await api.setExpanded(false);
          }, cycle);
        }
        await waitPhase('collapsed');
        if ((cycle + 1) % 25 === 0) {
          await windowInfo();
          console.log('Native frame cycles', JSON.stringify({alwaysOnTop, completed:cycle+1}));
        }
      }
      report.cycles.push({alwaysOnTop, normal:Math.ceil(cycleCount/2), reversed:Math.floor(cycleCount/2)});

      await invoke('settings:set', {patch:{autoCollapse:true}});
      for (let attempt = 0; attempt < 2; attempt++) {
        await invoke('window:collapse');
        await waitPhase('collapsed');
        const startFile = path.join(directory, `focus-${alwaysOnTop}-${attempt}.start`);
        activeFocusProbe = probe(root, 'native-window.ps1', ['-Executable', executable,
          '-Action', 'FocusCycle', '-StartFile', startFile], 'SIDETASK_FOCUS_READY');
        await activeFocusProbe.ready;
        await driver.execute(() => {
          window.__nativeFocusStates = [];
          window.__stopNativeFocusStates = window.sideTask.onWindowChange(state => {
            window.__nativeFocusStates.push({phase:state.phase, stage:state.stage, focusRestored:state.focusRestored});
          });
        });
        await invoke('window:set-expanded', {expanded:true});
        await driver.waitUntil(async () => (await state()).window.stage === 'animate', {timeout:3000, interval:5});
        await delay(50);
        await writeFile(startFile, 'start');
        const focus = {alwaysOnTop, attempt, native:result(await activeFocusProbe.done, 'SIDETASK_PROBE:')};
        report.focus.push(focus);
        activeFocusProbe = null;
        try { await waitPhase('expanded'); }
        finally {
          focus.states = await driver.execute(() => { window.__stopNativeFocusStates(); return window.__nativeFocusStates; });
          console.log('Native focus cycle', JSON.stringify({alwaysOnTop, attempt,
            activation:focus.native.focusCycle, states:focus.states}));
        }
        const states = focus.states;
        const closing = states.findIndex(state => state.phase === 'collapsing');
        assert.ok(closing >= 0, 'Native focus loss did not start collapse: '+JSON.stringify(states));
        assert.ok(!states.slice(0,closing).some(state => state.phase === 'expanded'), 'Focus test missed the opening animation');
        assert.ok(states.some(state => state.focusRestored), 'Native focus restoration did not reverse collapse: '+JSON.stringify(states));
        await windowInfo();
        report.focusReversals++;
      }
      await invoke('settings:set', {patch:{autoCollapse:false}});
      await windowInfo('AltF4');
      await waitPhase('collapsed');
      await clickHandle();
      await waitPhase('expanded');
      report.altF4++;
    }
  } finally {
    activeFocusProbe?.child.kill();
    await writeFile(stopFile, 'stop');
    try {
      report.watch = result(await watcher.done, 'SIDETASK_FRAME_WATCH:');
      if (recorder) report.recording = result(await recorder.done, 'SIDETASK_RECORD:');
    } finally {
      watcher.child.kill();
      recorder?.child.kill();
      await writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2)+'\n');
      await invoke('settings:set', {patch:{autoCollapse:false, alwaysOnTop:original.alwaysOnTop, windowPlacement:original.windowPlacement}});
    }
  }
  assert.ok(report.watch.samples > cycleCount*2, 'Too few native frame samples');
  assert.equal(report.watch.violations, 0, JSON.stringify(report.watch));
  console.log('Native frame regression passed', JSON.stringify({cycles:report.cycles,
    focusReversals:report.focusReversals, altF4:report.altF4, watch:report.watch, recording:report.recording, artifacts}));
}
