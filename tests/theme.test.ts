import { describe, expect, it } from 'vitest';

import { applyTheme, isDarkTheme } from '../src/services/theme';

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly classNames = new Set<string>();
  readonly classList = {
    add: (...names: string[]) => {
      for (const name of names) {
        this.classNames.add(name);
      }
    },
  };

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}

describe('theme helpers', () => {
  it('recognizes dark host theme names', () => {
    expect(isDarkTheme('dark')).toBe(true);
    expect(isDarkTheme('JupyterLab Dark')).toBe(true);
    expect(isDarkTheme('Dark High Contrast')).toBe(true);
    expect(isDarkTheme('light')).toBe(false);
    expect(isDarkTheme(undefined)).toBe(false);
  });

  it('marks the editor root with JupyterLab theme attributes', () => {
    const element = new FakeElement();

    applyTheme(element as unknown as HTMLElement, 'JupyterLab Dark');

    expect(element.classNames.has('jp-ThemedContainer')).toBe(true);
    expect(element.attributes.get('data-jp-theme-light')).toBe('false');
    expect(element.attributes.get('data-jp-theme-name')).toBe('Nimbalyst Dark');
  });
});
