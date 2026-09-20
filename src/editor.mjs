import { REPEAT_LABELS } from './domain.mjs';
import { $, el, button, colorDot, options, message, toast, EASE, reducedMotion } from './ui.mjs';

export class TaskEditor {
  constructor({ api, mutate, getState, getInfo, onInteraction, onSaved, onDeleted, onOpen, onClose, manageTags }) {
    Object.assign(this, { api, mutate, getState, getInfo, onInteraction, onSaved, onDeleted, onOpen, onClose, manageTags });
    this.busy = false;
    this.tags = [];
    this.subtasks = [];
    $('edit-form').addEventListener('submit', event => { event.preventDefault(); void this.save(); });
    $('edit-form').addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        $('edit-form').requestSubmit();
      }
    });
    $('edit-form').addEventListener('input', () => this.updateStatus());
    $('edit-form').addEventListener('change', () => this.updateStatus());
    $('detail-back').addEventListener('click', () => this.leave());
    $('delete-task').addEventListener('click', () => { void this.remove(); });
    $('edit-manage-tags').addEventListener('click', () => this.manageTags());
    $('subtask-add').addEventListener('click', () => this.addSubtask());
    $('subtask-title').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); this.addSubtask(); }
    });
    $('discard-continue').addEventListener('click', () => { this.leaveAction = null; $('discard-dialog').close(); });
    $('discard-changes').addEventListener('click', () => {
      const action = this.leaveAction;
      this.leaveAction = null;
      $('discard-dialog').close();
      this.close();
      action?.();
    });
    $('discard-save').addEventListener('click', async () => {
      const action = this.leaveAction;
      this.leaveAction = null;
      $('discard-dialog').close();
      if (await this.save()) action?.();
    });
    $('reload-task').addEventListener('click', () => this.leave(() => {
      const task = this.getState().tasks.find(item => item.id === this.id);
      if (task) this.open(task);
      else this.close();
    }));
  }

  get isOpen() { return !$('task-detail').hidden && !this.closing; }

  setBusy(busy) {
    this.busy = busy;
    $('task-detail').querySelector('.detail-scroll').inert = busy;
    for (const id of ['save-edit', 'delete-task', 'detail-back', 'edit-completed']) $(id).disabled = busy;
    this.onInteraction();
  }

  read() {
    const date = $('edit-date').value || null;
    const frequency = $('edit-repeat').value;
    return {
      title: $('edit-title').value,
      notes: $('edit-notes').value,
      dueDate: date,
      dueTime: $('edit-time').value || null,
      categoryId: $('edit-category').value === 'none' ? null : $('edit-category').value,
      tagIds: [...this.tags],
      priority: $('edit-priority').checked ? 'high' : 'normal',
      subtasks: structuredClone(this.subtasks),
      recurrence: frequency === 'none' ? null : {
        frequency,
        anchorDate: this.original?.recurrence?.frequency === frequency ? this.original.recurrence.anchorDate : date,
        until: $('edit-until').value || null,
      },
      reminder: $('edit-reminder').value === 'none' ? null : { offsetMinutes: Number($('edit-reminder').value) },
      completed: $('edit-completed').checked,
    };
  }

  serialize() { return JSON.stringify([this.read(), $('subtask-title').value]); }
  get dirty() {
    if (!this.isOpen) return false;
    // updateStatus() serializes once and shares that answer with the
    // interaction callback it triggers, instead of reading the form twice.
    return this.dirtyCache ?? this.serialize() !== this.baseline;
  }

  open(task = null, defaults = {}) {
    this.onOpen();
    const reopening = this.closing;
    this.exit?.cancel();
    this.exit = null;
    this.closing = false;
    this.closed = null;
    this.id = task?.id ?? null;
    this.original = task ? structuredClone(task) : null;
    const draft = task ?? { title: '', notes: '', dueDate: null, dueTime: null, priority: 'normal', categoryId: null, tagIds: [], subtasks: [], recurrence: null, reminder: null, ...defaults };
    this.tags = [...draft.tagIds];
    this.subtasks = structuredClone(draft.subtasks);
    $('edit-title').value = draft.title;
    $('edit-notes').value = draft.notes;
    $('edit-date').value = draft.dueDate ?? '';
    $('edit-time').value = draft.dueTime ?? '';
    $('edit-priority').checked = draft.priority === 'high';
    $('edit-completed').checked = Boolean(draft.completedAt);
    $('edit-completed').closest('label').hidden = !task;
    $('edit-repeat').value = draft.recurrence?.frequency ?? 'none';
    $('edit-until').value = draft.recurrence?.until ?? '';
    $('edit-reminder').value = draft.reminder ? String(draft.reminder.offsetMinutes) : 'none';
    $('subtask-title').value = '';
    $('edit-heading').textContent = task ? '任务详情' : '添加任务';
    $('delete-task').hidden = !task;
    $('delete-label').textContent = task?.recurrence && !task.completedAt ? '删除并停止重复' : '删除任务';
    $('save-edit').textContent = task ? '保存' : '添加任务';
    $('reload-task').hidden = true;
    message('edit-message');
    options($('edit-category'), this.getState().categories, draft.categoryId ?? 'none', [{ value: 'none', label: '未分类' }]);
    $('tags-section').open = this.tags.length > 0;
    $('subtasks-section').open = this.subtasks.length > 0;
    $('schedule-section').open = Boolean(draft.recurrence || draft.reminder);
    $('notes-section').open = Boolean(draft.notes);
    $('list-view').hidden = document.body.dataset.wide !== 'true';
    const entering = $('task-detail').hidden || reopening;
    $('task-detail').hidden = false;
    this.renderTags();
    this.renderSubtasks();
    this.baseline = this.serialize();
    this.updateStatus();
    $('task-detail').querySelector('.detail-scroll').scrollTop = 0;
    this.onInteraction();
    $('edit-title').focus({ preventScroll: true });
    if (entering && !reducedMotion()) {
      const wide = document.body.dataset.wide === 'true';
      $('task-detail').animate([{ opacity: 0, transform: wide ? 'translateX(16px)' : 'translateX(8px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: EASE });
    }
  }

  close() {
    if (this.busy || this.closing) return this.closed ?? Promise.resolve();
    const id = this.id;
    let resolve;
    this.closed = new Promise(done => { resolve = done; });
    const finish = () => {
      this.closing = false;
      this.closed = null;
      $('task-detail').hidden = true;
      $('list-view').hidden = false;
      this.onInteraction();
      this.onClose(id);
      resolve();
    };
    if (reducedMotion() || $('task-detail').hidden) { finish(); return this.closed ?? Promise.resolve(); }
    // The panel slides away before the list takes its place; a reopen during
    // that moment simply cancels the exit.
    this.closing = true;
    this.onInteraction();
    const wide = document.body.dataset.wide === 'true';
    const animation = $('task-detail').animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: wide ? 'translateX(16px)' : 'none' }], { duration: wide ? 160 : 110, easing: EASE, fill: 'forwards' });
    this.exit = animation;
    const pending = this.closed;
    animation.finished.then(() => {
      if (this.exit !== animation) return;
      this.exit = null;
      animation.cancel();
      finish();
    }).catch(() => {});
    return pending;
  }

  leave(action = () => this.close()) {
    if (this.busy) return;
    if (!this.dirty) { action(); return; }
    this.leaveAction = action;
    if (!$('discard-dialog').open) $('discard-dialog').showModal();
    this.onInteraction();
  }

  refreshReferences() {
    if (!this.isOpen) return;
    const state = this.getState();
    const selected = $('edit-category').value;
    this.tags = this.tags.filter(id => state.tags.some(tag => tag.id === id));
    options($('edit-category'), state.categories, state.categories.some(item => item.id === selected) ? selected : 'none', [{ value: 'none', label: '未分类' }]);
    this.renderTags();
    this.updateStatus();
  }

  renderTags() {
    const fragment = document.createDocumentFragment();
    for (const tag of this.getState().tags) {
      const label = el('label', 'tag-choice');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = this.tags.includes(tag.id);
      input.addEventListener('change', () => {
        this.tags = input.checked ? [...this.tags, tag.id] : this.tags.filter(id => id !== tag.id);
        this.updateStatus();
      });
      label.append(input, colorDot(tag.color), document.createTextNode(tag.name));
      fragment.append(label);
    }
    if (!this.getState().tags.length) fragment.append(el('span', 'field-help', '创建标签后，可在这里选择。'));
    $('edit-tags-list').replaceChildren(fragment);
  }

  renderSubtasks() {
    const fragment = document.createDocumentFragment();
    this.subtasks.forEach((item, index) => {
      const row = el('div', 'subtask-edit-row');
      const completed = el('input');
      completed.type = 'checkbox';
      completed.checked = item.completed;
      completed.setAttribute('aria-label', '完成子任务：' + item.title);
      completed.addEventListener('change', () => { item.completed = completed.checked; this.updateStatus(); });
      const title = el('input');
      title.type = 'text';
      title.maxLength = 160;
      title.value = item.title;
      title.setAttribute('aria-label', '子任务名称 ' + (index + 1));
      title.addEventListener('input', () => { item.title = title.value; this.updateStatus(); });
      title.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
      const move = delta => {
        const target = index + delta;
        if (target < 0 || target >= this.subtasks.length) return;
        [this.subtasks[index], this.subtasks[target]] = [this.subtasks[target], this.subtasks[index]];
        this.renderSubtasks();
        this.updateStatus();
        $('subtask-editor').children[target]?.querySelector('input[type="text"]')?.focus();
      };
      const up = button('上移子任务：' + item.title, 'icon-button small', () => move(-1), 'down');
      up.querySelector('svg').classList.add('up-icon');
      up.disabled = index === 0;
      const down = button('下移子任务：' + item.title, 'icon-button small', () => move(1), 'down');
      down.disabled = index === this.subtasks.length - 1;
      const remove = button('删除子任务：' + item.title, 'icon-button small', () => {
        this.subtasks.splice(index, 1);
        this.renderSubtasks();
        this.updateStatus();
      }, 'close');
      row.append(completed, title, up, down, remove);
      fragment.append(row);
    });
    $('subtask-editor').replaceChildren(fragment);
  }

  addSubtask() {
    const title = $('subtask-title').value.trim();
    if (!title) return;
    if (this.subtasks.length >= 100) { message('edit-message', '每个任务最多支持 100 个子任务。', true); return; }
    this.subtasks.push({ id: crypto.randomUUID(), title, completed: false });
    $('subtask-title').value = '';
    this.renderSubtasks();
    this.updateStatus();
    $('subtask-title').focus();
  }

  updateStatus() {
    if (!this.isOpen) return;
    $('edit-title').style.height = 'auto';
    $('edit-title').style.height = $('edit-title').scrollHeight + 'px';
    this.dirtyCache = this.serialize() !== this.baseline;
    try {
      $('detail-dirty').hidden = !this.dirtyCache;
      this.renderSummaries();
      this.onInteraction();
    } finally { this.dirtyCache = null; }
  }

  renderSummaries() {
    if (this.id) $('save-edit').textContent = $('edit-completed').checked && !this.original.completedAt ? '保存并完成' : !$('edit-completed').checked && this.original.completedAt ? '保存并重新打开' : '保存';
    const finished = this.subtasks.filter(item => item.completed).length;
    $('subtask-summary').textContent = this.subtasks.length ? finished + ' / ' + this.subtasks.length : '0 项';
    const names = this.getState().tags.filter(tag => this.tags.includes(tag.id)).map(tag => tag.name);
    $('edit-tags-summary').textContent = names.join('、') || '未设置';
    const frequency = $('edit-repeat').value;
    $('repeat-until-field').hidden = frequency === 'none';
    $('edit-repeat').disabled = Boolean(this.original?.completedAt);
    $('edit-until').disabled = Boolean(this.original?.completedAt);
    const ready = Boolean($('edit-date').value && $('edit-time').value);
    // Existing configurations stay editable so missing prerequisites can be corrected explicitly.
    $('edit-reminder').disabled = Boolean(this.original?.completedAt) || (!ready && $('edit-reminder').value === 'none');
    $('reminder-help').textContent = !ready ? '开启提醒前，请先设置计划日期和具体时间。'
      : this.getInfo().runtime === 'browser' ? '网页预览显示页面提示；桌面版可发送系统通知。'
        : '按本地时间提醒；侧栏收起、驻留托盘时仍有效。';
    const summary = [REPEAT_LABELS[frequency], $('edit-reminder').value !== 'none' ? '已设提醒' : null].filter(Boolean);
    $('schedule-summary').textContent = summary.join(' · ') || '未设置';
    $('notes-summary').textContent = $('edit-notes').value.trim() ? '已填写' : '未填写';
  }

  async save() {
    if (this.busy || !$('edit-form').reportValidity()) return false;
    this.addSubtask();
    if ($('subtask-title').value.trim()) return false;
    const patch = this.read();
    const created = !this.id;
    this.setBusy(true);
    message('edit-message', '正在保存…');
    let response;
    try {
      response = await this.mutate(() => created ? this.api.addTask(patch) : this.api.updateTask(this.id, patch, this.original.updatedAt), 'edit-message');
      this.baseline = this.serialize();
    } catch (error) {
      if (/别处修改|不存在/.test(error.message)) $('reload-task').hidden = false;
      if (/重复|提醒|日期|时间/.test(error.message)) $('schedule-section').open = true;
    } finally {
      this.setBusy(false);
      this.updateStatus();
    }
    if (!response) return false;
    this.close();
    this.onSaved(response, { created });
    return true;
  }

  async remove() {
    if (this.busy || !this.id) return;
    this.setBusy(true);
    try {
      const response = await this.mutate(() => this.api.deleteTask(this.id), 'edit-message');
      this.setBusy(false);
      this.close();
      this.onDeleted(response);
    } catch { /* Keep all editor fields available for retry. */ }
    finally { this.setBusy(false); }
  }
}
