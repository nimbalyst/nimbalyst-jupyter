/**
 * Apply the host theme to a JupyterLab mount point by toggling a body
 * data-attribute that the JupyterLab light/dark theme CSS keys off.
 *
 * NOTE: this is a minimal reconstruction; the original implementation
 * was lost in the Datalayer pivot. If theming regresses, restore from
 * git history of an earlier checkout or rewrite based on
 * @jupyterlab/theme-{light,dark}-extension's CSS variable map.
 */

type ThemeName = 'light' | 'dark' | string | undefined;

export function applyTheme(container: HTMLElement, theme: ThemeName): void {
  const isDark = theme === 'dark';
  container.setAttribute('data-jp-theme-light', isDark ? 'false' : 'true');
  container.setAttribute('data-jp-theme-name', isDark ? 'JupyterLab Dark' : 'JupyterLab Light');
}
