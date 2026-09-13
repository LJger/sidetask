import { COLORS } from './domain.mjs';
import { $, $$, el, button, colorDot, options, message } from './ui.mjs';

export class TaxonomyManager {
  constructor({ api, mutate, getState, onInteraction }) {
    Object.assign(this, { api, mutate, getState, onInteraction });
    this.kind = 'categories';
    this.busy = false;
    const names = ['松绿', '湖蓝', '紫藤', '暖橙', '莓红', '灰蓝'];
    options($('taxonomy-color'), [], COLORS[0], COLORS.map((value, index) => ({ value, label: names[index] })));
    $$('[data-kind]').forEach(tab => {
      tab.addEventListener('click', () => this.switchKind(tab.dataset.kind));
      tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const kind = event.key === 'Home' ? 'categories' : event.key === 'End' ? 'tags' : this.kind === 'categories' ? 'tags' : 'categories';
        this.switchKind(kind);
        document.querySelector('[data-kind="' + kind + '"]').focus();
      });
    });
    $('taxonomy-form').addEventListener('submit', event => { event.preventDefault(); void this.save(); });
    $('taxonomy-cancel-edit').addEventListener('click', () => this.reset());
    $('taxonomy-cancel-delete').addEventListener('click', () => { $('taxonomy-confirm').hidden = true; });
    $('taxonomy-confirm-delete').addEventListener('click', () => { void this.remove(); });
  }

  open(kind = 'categories') {
    this.switchKind(kind);
    if (!$('taxonomy-dialog').open) $('taxonomy-dialog').showModal();
    this.onInteraction();
  }

  switchKind(kind) {
    this.kind = kind;
    this.reset();
    this.render();
  }

  reset() {
    $('taxonomy-id').value = '';
    $('taxonomy-name').value = '';
    $('taxonomy-color').value = COLORS[0];
    $('taxonomy-save').textContent = '添加';
    $('taxonomy-form-label').textContent = this.kind === 'categories' ? '新建分类' : '新建标签';
    $('taxonomy-name').placeholder = this.kind === 'categories' ? '例如：工作、生活' : '例如：写作、待沟通';
    $('taxonomy-cancel-edit').hidden = true;
    $('taxonomy-confirm').hidden = true;
    message('taxonomy-message');
  }

  render() {
    const state = this.getState();
    $$('[data-kind]').forEach(tab => {
      const selected = tab.dataset.kind === this.kind;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.disabled = this.busy;
    });
    $('taxonomy-help').textContent = this.kind === 'categories'
      ? '一个任务归属一个分类；删除分类后，任务保留在未分类中。'
      : '一个任务可以有多个标签；删除标签不会删除任务。';
    const fragment = document.createDocumentFragment();
    for (const item of state[this.kind]) {
      const row = el('div', 'taxonomy-row');
      row.append(colorDot(item.color), el('span', 'taxonomy-name', item.name));
      const count = state.tasks.filter(task => !task.completedAt && (this.kind === 'categories' ? task.categoryId === item.id : task.tagIds.includes(item.id))).length;
      row.append(el('span', 'taxonomy-count', count + ' 待办'));
      const edit = button('编辑' + item.name, 'icon-button small', () => {
        $('taxonomy-id').value = item.id;
        $('taxonomy-name').value = item.name;
        $('taxonomy-color').value = item.color;
        $('taxonomy-save').textContent = '保存';
        $('taxonomy-form-label').textContent = this.kind === 'categories' ? '编辑分类' : '编辑标签';
        $('taxonomy-cancel-edit').hidden = false;
        $('taxonomy-name').focus();
      }, 'edit');
      const remove = button('删除' + item.name, 'icon-button small', () => {
        this.removing = item.id;
        $('taxonomy-confirm-label').textContent = '删除「' + item.name + '」？关联任务会保留' + (this.kind === 'categories' ? '，并转为未分类。' : '。');
        $('taxonomy-confirm').hidden = false;
        $('taxonomy-confirm-delete').focus();
      }, 'trash');
      edit.disabled = this.busy;
      remove.disabled = this.busy;
      row.append(edit, remove);
      fragment.append(row);
    }
    if (!state[this.kind].length) fragment.append(el('p', 'field-help', this.kind === 'categories' ? '还没有分类，在下方创建第一个。' : '还没有标签，在下方创建第一个。'));
    $('taxonomy-list').replaceChildren(fragment);
    $('taxonomy-save').disabled = this.busy;
    $('taxonomy-form').inert = this.busy;
    $('taxonomy-confirm-delete').disabled = this.busy;
  }

  async save() {
    if (this.busy || !$('taxonomy-name').value.trim()) return;
    this.busy = true;
    this.render();
    try {
      await this.mutate(() => this.api.saveTaxonomy(this.kind, {
        ...($('taxonomy-id').value ? { id: $('taxonomy-id').value } : {}),
        name: $('taxonomy-name').value, color: $('taxonomy-color').value,
      }), 'taxonomy-message');
      this.reset();
      message('taxonomy-message', '已保存');
    } catch { /* Keep form values for retry. */ }
    finally { this.busy = false; this.render(); }
  }

  async remove() {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      await this.mutate(() => this.api.deleteTaxonomy(this.kind, this.removing), 'taxonomy-message');
      this.reset();
      message('taxonomy-message', '已删除，任务已保留');
    } catch { /* The mutation reports the failure. */ }
    finally { this.busy = false; this.render(); }
  }
}
