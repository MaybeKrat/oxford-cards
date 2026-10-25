import type { ThemePreference } from './types.ts';

export const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)';

export function applyTheme(preference: ThemePreference, systemDark = window.matchMedia(SYSTEM_THEME_QUERY).matches): void {
  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#141c19' : '#f8f9f6');
}
