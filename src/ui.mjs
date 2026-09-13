export const $ = id => document.getElementById(id);
export const $$ = selector => [...document.querySelectorAll(selector)];
export function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function icon(name, className = '') {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('class', 'icon ' + className);
  node.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(node.namespaceURI, 'use');
  use.setAttribute('href', '#i-' + name);
  node.append(use);
  return node;
}
export function button(label, className = '', action, iconName) {
  const node = el('button', className);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  node.title = label;
  if (iconName) node.append(icon(iconName));
  else node.textContent = label;
  if (action) node.addEventListener('click', action);
  return node;
}
export function colorDot(color) {
  const dot = el('span', 'color-dot');
  dot.style.setProperty('--item-color', color);
  return dot;
}
export function options(select, items, selected, prefix = []) {
  const nodes = [...prefix, ...items.map(item => ({ value: item.id, label: item.name }))].map(item => {
    const option = el('option', '', item.label);
    option.value = item.value;
    return option;
  });
  if (CSS.supports('appearance', 'base-select')) {
    const value = select.querySelector('.select-value') ?? el('button', 'select-value');
    value.type = 'button';
    if (!value.firstChild) value.append(el('selectedcontent'));
    nodes.unshift(value);
  }
  select.replaceChildren(...nodes);
  select.value = selected;
  select.title = select.selectedOptions[0]?.textContent ?? '';
}
export function message(id, text = '', error = false) {
  $(id).textContent = text;
  $(id).classList.toggle('is-error', error);
}
let toastTimer;
let toastAction;
export function hideToast() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
  toastAction = null;
}
export function toast(text, action = null, label = '撤销', duration = 6000) {
  clearTimeout(toastTimer);
  $('toast-message').textContent = text;
  $('toast-action').hidden = !action;
  $('toast-action').textContent = label;
  toastAction = action;
  $('toast').hidden = false;
  if (duration > 0) toastTimer = setTimeout(hideToast, action && label === '撤销' ? 10000 : duration);
}
export function bindToasts(onError) {
  $('toast-close').addEventListener('click', hideToast);
  $('toast-action').addEventListener('click', async () => {
    const action = toastAction;
    hideToast();
    try { await action?.(); } catch (error) { onError(error); }
  });
}
export class Popovers {
  constructor(onChange) {
    this.onChange = onChange;
    this.active = null;
    this.trigger = null;
    document.addEventListener('pointerdown', event => {
      if (this.active && !this.active.contains(event.target) && !this.trigger?.contains(event.target)) this.close();
    });
  }
  open(id, trigger) {
    const node = $(id);
    if (this.active === node) { this.close(); return; }
    this.close();
    node.setAttribute('popover', 'manual');
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', node.querySelector('.popover-heading')?.textContent || '任务操作');
    node.hidden = false;
    node.showPopover();
    const rect = trigger.getBoundingClientRect();
    const size = node.getBoundingClientRect();
    const panel = $('panel').getBoundingClientRect();
    const left = Math.max(6, Math.min(rect.left, panel.right - size.width - 8, innerWidth - size.width - 6));
    const below = rect.bottom + 5;
    const top = below + size.height <= innerHeight - 8 ? below : Math.max(8, rect.top - size.height - 5);
    node.style.left = left + 'px';
    node.style.top = top + 'px';
    this.active = node;
    this.trigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    this.onChange();
    node.querySelector('input, button, select')?.focus({ preventScroll: true });
  }
  close(restoreFocus = false) {
    if (!this.active) return;
    this.active.hidePopover();
    this.active.hidden = true;
    this.trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.trigger?.focus({ preventScroll: true });
    this.active = null;
    this.trigger = null;
    this.onChange();
  }
}
