import { emptyState, validateState, localDate } from './domain.mjs';
import { applyCommand, UndoHistory } from './model.mjs';
import { WindowController, AutoDockController } from './window-controller.mjs';
import { defaultPlacement, clamp } from './window-layout.mjs';
import { ReminderScheduler } from './reminders.mjs';

const STORAGE_KEY = 'sidetask.preview.v3';
const PREVIOUS_KEY = 'sidetask.preview.v2';
const LEGACY_KEY = 'sidetask.preview.v1';

export function createBrowserBridge() {
  let state = emptyState();
  let warning = null;
  let queue = Promise.resolve();
  const undoHistory = new UndoHistory();
  const stateListeners = new Set();
  const windowListeners = new Set();
  const actionListeners = new Set();
  const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(PREVIOUS_KEY) ?? localStorage.getItem(LEGACY_KEY);
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
      state = validateState(parsed);
    } catch (error) {
      if (error.code === 'UNSUPPORTED_VERSION') throw error;
      localStorage.setItem(STORAGE_KEY + '.corrupt.' + Date.now(), raw);
      warning = '浏览器中的数据无法读取，已保留原始副本。可在设置中导入备份。';
    }
    if (parsed && parsed.version < 3) {
      const backup = 'sidetask.preview.v' + parsed.version + '.original';
      if (!localStorage.getItem(backup)) localStorage.setItem(backup, raw);
      warning = '旧任务已升级，原始浏览器数据已保留。';
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
  const snapshot = () => structuredClone(state);
  const emitAction = action => actionListeners.forEach(callback => callback(action));
  const windows = new WindowController({
    placement: state.settings.windowPlacement, view: state.settings.calendarView,
    getArea: () => ({ x: 0, y: 0, width: innerWidth, height: innerHeight }),
    setBounds() {},
    emit: value => windowListeners.forEach(callback => callback(value)),
    persist: async placement => {
      if (JSON.stringify(placement) !== JSON.stringify(state.settings.windowPlacement)) await commit('settings:set', { patch: { windowPlacement: placement } });
    },
  });
  const idle = new AutoDockController(() => windows.collapse(), () => {
    if (windows.docking || windows.transitions.phase === 'collapsing') windows.expand({ focusRestore: true });
  });
  let protectedInteraction = false;
  let drag = null;
  const updateProtection = () => idle.update({ protected: protectedInteraction || Boolean(drag), enabled: state.settings.autoCollapse });
  document.addEventListener('pointerdown', event => {
    const inside = event.target.closest('#shell, dialog, [popover]');
    idle.update({ focused: Boolean(inside) });
  });
  const endDrag = () => { if (!drag) return; drag = null; windows.endMove(); updateProtection(); };
  window.addEventListener('blur', () => idle.update({ focused: false }));
  window.addEventListener('focus', () => idle.update({ focused: true }));
  let scheduler;
  const commit = (type, args) => {
    const perform = async () => {
      const latest = localStorage.getItem(STORAGE_KEY);
      const next = latest ? validateState(JSON.parse(latest)) : snapshot();
      const actual = type === 'task:undo' ? { undo: undoHistory.get(args.token) } : args;
      const { result, undo } = applyCommand(next, type, actual);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
      catch { throw new Error('浏览器存储已满或不可用，请导出备份并检查浏览器存储权限。'); }
      state = next;
      if (type === 'task:undo') undoHistory.forget(args.token);
      const undoToken = undoHistory.remember(undo);
      stateListeners.forEach(callback => callback(snapshot()));
      if (type !== 'reminders:claim') void scheduler?.refresh(type === 'data:import');
      return { state: snapshot(), result: structuredClone(result), ...(undoToken ? { undoToken } : {}) };
    };
    const operation = queue.then(() => navigator.locks ? navigator.locks.request(STORAGE_KEY, perform) : perform());
    queue = operation.catch(() => {});
    return operation;
  };

  scheduler = new ReminderScheduler({
    read: snapshot,
    claim: entries => commit('reminders:claim', { entries }),
    notify: (tasks, { missed }) => emitAction({ type: 'reminder-notice', taskIds: tasks.map(task => task.id), missed }),
    onError: error => emitAction({ type: 'notification-error', message: error.message }),
  });
  void scheduler.start();
  window.addEventListener('pagehide', () => { idle.dispose(); scheduler.stop(); });
  window.addEventListener('pageshow', event => { if (event.persisted) void scheduler.start(); });
  window.addEventListener('resize', () => { endDrag(); windows.refresh(); });
  window.addEventListener('focus', () => { void scheduler.refresh(); });
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return;
    try {
      state = event.newValue ? validateState(JSON.parse(event.newValue)) : emptyState();
      stateListeners.forEach(callback => callback(snapshot()));
      updateProtection();
      void scheduler.refresh(true);
    } catch { /* Preserve the current valid state when another tab writes invalid data. */ }
  });

  return {
    async getState() {
      return { state: snapshot(), window: windows.snapshot(), warning,
        info: { version: '1.3.3', platform: 'browser', runtime: 'browser', canLaunchAtLogin: false, canOpenDataFolder: false,
          canNotify: false, shortcut: 'Ctrl + Shift + Space', shortcutRegistered: true } };
    },
    addTask: input => commit('task:add', { input }),
    updateTask: (id, patch, expectedUpdatedAt) => commit('task:update', { id, patch, expectedUpdatedAt }),
    deleteTask: id => commit('task:delete', { id }),
    restoreTask: task => commit('task:restore', { task }),
    undoCompletion: token => commit('task:undo', { token }),
    saveTaxonomy: (kind, input) => commit('taxonomy:save', { kind, input }),
    deleteTaxonomy: (kind, id) => commit('taxonomy:delete', { kind, id }),
    async setSettings(patch) {
      if (patch.launchAtLogin) throw new Error('开机启动请使用 Windows 桌面版本。');
      const response = await commit('settings:set', { patch });
      if (patch.windowPlacement || patch.dockSide) windows.relocate(response.state.settings.windowPlacement);
      updateProtection();
      return response;
    },
    async toggle() { windows.toggle(); },
    async setExpanded(expanded) { expanded ? windows.expand() : windows.collapse(); },
    async collapse() { windows.collapse(); },
    async startDrag(origin) {
      if (windows.transitions.stage !== 'settled') throw new Error('请稍候，窗口正在展开或收起。');
      drag = { ...origin, bounds: { ...windows.nativeBounds } };
      updateProtection();
    },
    async moveDrag(point) {
      if (!drag) return;
      windows.move({ ...drag.bounds,
        x: clamp(drag.bounds.x + point.x - drag.x, 0, innerWidth - drag.bounds.width),
        y: clamp(drag.bounds.y + point.y - drag.y, 0, innerHeight - drag.bounds.height) });
    },
    async endDrag() { endDrag(); },
    async setLayout(view) { windows.setView(view); },
    async resetPlacement() { windows.relocate(defaultPlacement()); windows.expand(); },
    async setReducedMotion(reduced) { windows.reducedMotion = reduced === true; },
    async transitionReady(id) { windows.ready(id); },
    async transitionFinished(id) { windows.finish(id); },
    async setInteractionActive(active) { protectedInteraction = active === true; updateProtection(); },
    async openDataFolder() { throw new Error('网页版数据保存在浏览器中，可通过导出备份保存到文件。'); },
    async exportData() {
      await queue;
      const blob = new Blob([JSON.stringify(snapshot(), null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'SideTask-' + localDate() + '.json';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { canceled: false };
    },
    async importData() {
      const file = await new Promise(resolve => {
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = '.json,application/json';
        picker.hidden = true;
        const finish = value => { picker.remove(); resolve(value); };
        picker.addEventListener('change', () => finish(picker.files[0] || null), { once: true });
        picker.addEventListener('cancel', () => finish(null), { once: true });
        (document.querySelector('dialog[open]') ?? document.body).append(picker);
        picker.click();
      });
      if (!file) return { canceled: true };
      if (file.size > 10 * 1024 * 1024) throw new Error('备份文件不能超过 10 MB。');
      let parsed;
      try { parsed = JSON.parse(await file.text()); }
      catch { throw new Error('无法读取备份，请选择有效的 JSON 文件。'); }
      const imported = validateState(parsed);
      return { canceled: false, ...await commit('data:import', { raw: imported }) };
    },
    onStateChange(callback) { stateListeners.add(callback); return () => stateListeners.delete(callback); },
    onWindowChange(callback) { windowListeners.add(callback); return () => windowListeners.delete(callback); },
    onAction(callback) { actionListeners.add(callback); return () => actionListeners.delete(callback); },
  };
}
