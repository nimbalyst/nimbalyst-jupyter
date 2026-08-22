/**
 * Apply JupyterLab's theme metadata to the editor root. The actual palette is
 * a scoped CSS bridge from the host's inherited --nim-* tokens to Jupyter's
 * --jp-* tokens, so extension-contributed themes update without per-theme JS.
 */

type ThemeName = 'light' | 'dark' | string | undefined;

export function applyTheme(container: HTMLElement, theme: ThemeName): void {
  const isDark = isDarkTheme(theme);
  container.classList.add('jp-ThemedContainer');
  container.setAttribute('data-jp-theme-light', isDark ? 'false' : 'true');
  container.setAttribute('data-jp-theme-name', `Nimbalyst ${isDark ? 'Dark' : 'Light'}`);
}

export function isDarkTheme(theme: ThemeName): boolean {
  return theme?.toLowerCase().includes('dark') ?? false;
}
