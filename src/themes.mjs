export const THEME_NAMES = { pine: '松绿', mist: '雾蓝', sand: '暖沙', graphite: '石墨', system: '跟随系统' };
export const MOTION_NAMES = { slide: '滑入', fade: '淡入', pop: '弹出', reveal: '展帘' };
export function applyTheme(preference = 'pine') {
  const theme = preference === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'graphite' : 'pine') : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'graphite' ? 'dark' : 'light';
}
