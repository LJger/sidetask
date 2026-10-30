export const $ = id => document.getElementById(id);
export const $$ = selector => [...document.querySelectorAll(selector)];
export const EASE = 'cubic-bezier(.22,1,.36,1)';
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// A tab list draws its selection as one plate that slides between tabs. Size
// changes, including the list first becoming visible, place the plate without
// animating; only a change of selection makes it travel.
let indicatorObserver;
const observedIndicators = new WeakSet();
function placeIndicator(list, animate) {
  const selected = list.querySelector('[aria-selected="true"]');
  if (!list.offsetWidth) return;
  if (!animate) list.dataset.indicator = 'static';
  list.style.setProperty('--indicator-opacity', selected ? '1' : '0');
  if (selected) {
    list.style.setProperty('--indicator-x', selected.offsetLeft + 'px');
    list.style.setProperty('--indicator-width', selected.offsetWidth + 'px');
  }
  if (!animate) requestAnimationFrame(() => requestAnimationFrame(() => { list.dataset.indicator = 'ready'; }));
}
export function syncIndicator(list) {
  indicatorObserver ??= new ResizeObserver(entries => entries.forEach(entry => placeIndicator(entry.target, false)));
  if (!observedIndicators.has(list)) { observedIndicators.add(list); indicatorObserver.observe(list); }
  placeIndicator(list, list.dataset.indicator === 'ready');
}
// Content that replaces content glides in from the side it logically comes from.
export function slideIn(nodes, direction, distance = 14) {
  if (!direction || reducedMotion()) return;
  for (const node of nodes) {
    if (!node || node.hidden) continue;
    node.animate([{ opacity: 0, transform: `translateX(${direction * distance}px)` }, { opacity: 1, transform: 'none' }], { duration: 280, easing: EASE });
  }
}
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
  // Only icon-only buttons need a tooltip; visible text already says it.
  if (iconName) { node.title = label; node.append(icon(iconName)); }
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
    if (node.matches(':popover-open')) node.hidePopover();
    node.showPopover();
    const rect = trigger.getBoundingClientRect();
    const size = node.getBoundingClientRect();
    const panel = $('panel').getBoundingClientRect();
    const left = Math.max(6, Math.min(rect.left, panel.right - size.width - 8, innerWidth - size.width - 6));
    const below = rect.bottom + 5;
    const top = below + size.height <= innerHeight - 8 ? below : Math.max(8, rect.top - size.height - 5);
    node.style.left = left + 'px';
    node.style.top = top + 'px';
    // Grow out of the trigger, whichever side of it the menu ended up on.
    node.style.transformOrigin = Math.round(rect.left + rect.width / 2 - left) + 'px ' + (top === below ? '0' : '100%');
    this.active = node;
    this.trigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    this.onChange();
    node.querySelector('input, button, select')?.focus({ preventScroll: true });
  }
  close(restoreFocus = false) {
    if (!this.active) return;
    const node = this.active;
    node.hidePopover();
    // Keep the element rendered until its exit transition has played; the
    // hidden attribute still records the closed state for the next open.
    const finish = () => { if (!node.matches(':popover-open')) node.hidden = true; };
    if (reducedMotion()) finish();
    else { node.addEventListener('transitionend', finish, { once: true }); setTimeout(finish, 220); }
    this.trigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) this.trigger?.focus({ preventScroll: true });
    this.active = null;
    this.trigger = null;
    this.onChange();
  }
}
