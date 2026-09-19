export async function createTauriBridge() {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const listeners = Object.fromEntries(['state:changed', 'window:changed', 'app:action'].map(name => [name, new Set()]));
  const early = [];
  let revision = -1, latestState;
  const remember = (state, nextRevision) => {
    if (nextRevision <= revision) return false;
    revision = nextRevision;
    latestState = state;
    return true;
  };
  // Subscribe before requesting the first snapshot, so an early reminder or
  // tray action cannot fall into the gap between page load and app binding.
  await Promise.all(Object.keys(listeners).map(name => listen(name, ({ payload }) => {
    if (name === 'state:changed') {
      if (remember(payload.state, payload.revision)) listeners[name].forEach(callback => callback(payload.state));
    }
    else if (name === 'app:action' && !listeners[name].size) early.push(payload);
    else listeners[name].forEach(callback => callback(payload));
  })));
  const request = async (command, args = {}) => {
    try {
      const response = await invoke('request', { command, args });
      if (response?.state) {
        if (remember(response.state, response.revision)) listeners['state:changed'].forEach(callback => callback(latestState));
        response.state = latestState;
      }
      return response;
    }
    catch (error) { throw new Error(typeof error === 'string' ? error : error?.message || '操作失败，请重试。'); }
  };
  const subscribe = (name, callback) => {
    listeners[name].add(callback);
    if (name === 'app:action') early.splice(0).forEach(callback);
    return () => listeners[name].delete(callback);
  };
  return {
    getState: () => request('state:get'),
    frontendReady: () => request('app:ready'),
    addTask: input => request('task:add', { input }),
    updateTask: (id, patch, expectedUpdatedAt) => request('task:update', { id, patch, expectedUpdatedAt }),
    deleteTask: id => request('task:delete', { id }),
    restoreTask: task => request('task:restore', { task }),
    undoCompletion: token => request('task:undo', { token }),
    saveTaxonomy: (kind, input) => request('taxonomy:save', { kind, input }),
    deleteTaxonomy: (kind, id) => request('taxonomy:delete', { kind, id }),
    setSettings: patch => request('settings:set', { patch }),
    exportData: () => request('data:export'),
    importData: () => request('data:import'),
    openDataFolder: () => request('data:open-folder'),
    toggle: () => request('window:toggle'),
    setExpanded: expanded => request('window:set-expanded', { expanded }),
    collapse: () => request('window:collapse'),
    startDrag: () => request('window:start-drag'),
    setLayout: layout => request('window:set-layout', { layout }),
    resetPlacement: () => request('window:reset-placement'),
    setReducedMotion: reduced => request('window:motion', { reduced }),
    transitionReady: id => request('window:ready', { id }),
    transitionFinished: id => request('window:finished', { id }),
    setInteractionActive: active => request('window:interaction', { active }),
    onStateChange: callback => subscribe('state:changed', callback),
    onWindowChange: callback => subscribe('window:changed', callback),
    onAction: callback => subscribe('app:action', callback),
  };
}
