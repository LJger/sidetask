import test from 'node:test';
import assert from 'node:assert/strict';
import { createTauriBridge } from '../src/tauri-bridge.mjs';

test('late IPC replies and events cannot replace a newer committed state', async t => {
  const events=new Map(); let resolve;
  globalThis.window={__TAURI__:{core:{invoke:()=>new Promise(done=>{resolve=done;})},event:{listen:async(name,callback)=>{events.set(name,callback);}}}};
  t.after(()=>delete globalThis.window);
  const api=await createTauriBridge();
  const changes=[]; api.onStateChange(state=>changes.push(state));
  const operation=api.addTask({title:'first'});
  events.get('state:changed')({payload:{revision:2,state:{tasks:['first','second']}}});
  resolve({revision:1,state:{tasks:['first']},result:{id:'first'}});
  const result=await operation;
  assert.deepEqual(result.state.tasks,['first','second']);
  assert.equal(result.result.id,'first');
  events.get('state:changed')({payload:{revision:1,state:{tasks:['first']}}});
  assert.equal(changes.length,1);
});

test('early tray actions survive bridge setup and backend errors stay usable', async t => {
  globalThis.window={__TAURI__:{core:{invoke:async()=>{throw '保存失败，请重试。';}},event:{listen:async(name,callback)=>{
    if(name==='app:action') callback({payload:'new-task'});
  }}}};
  t.after(()=>delete globalThis.window);
  const api=await createTauriBridge();
  const actions=[]; api.onAction(action=>actions.push(action));
  assert.deepEqual(actions,['new-task']);
  await assert.rejects(api.addTask({title:'x'}),/保存失败/);
});
