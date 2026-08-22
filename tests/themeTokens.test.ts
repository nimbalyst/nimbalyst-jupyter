/**
 * Guards the two ways this extension's stylesheets have silently gone
 * off-theme.
 *
 * 1. An invented `--nim-*` name. The host defines a fixed vocabulary (see
 *    docs/CSS_VARIABLES.md in the Nimbalyst repo); a name outside it is not a
 *    graceful degradation, it is a guaranteed fallback, so the literal is what
 *    ships on every theme. That is how the cell-type popover came to render a
 *    white surface under white text on the dark theme.
 * 2. A `--jp-*` fallback in a stylesheet whose element is portaled to
 *    `document.body`. The `--nim-*` -> `--jp-*` bridge is scoped to
 *    `.jupyter-notebook-editor-root`; outside it the only `--jp-*` values in
 *    scope are JupyterLab's own `:root` LIGHT defaults.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every `--nim-*` the host defines, from
 * `packages/runtime/src/editor/themes/palette.ts` (per-theme values) and
 * `NimbalystTheme.css` (`:root` defaults). Add here only after confirming the
 * host actually ships the token.
 */
const HOST_TOKENS = new Set([
  'bg', 'bg-secondary', 'bg-tertiary', 'bg-hover', 'bg-selected', 'bg-active',
  'text', 'text-muted', 'text-faint', 'text-disabled',
  'border', 'border-focus',
  'primary', 'primary-hover', 'on-primary',
  'link', 'link-hover',
  'success', 'warning', 'error', 'info', 'purple',
  'accent-subtle', 'comment-mark', 'highlight-bg', 'highlight-border',
  'code-bg', 'code-text', 'code-border', 'code-gutter', 'code-comment',
  'code-attr', 'code-function', 'code-operator', 'code-property',
  'code-punctuation', 'code-selector', 'code-variable',
  'table-border', 'table-header', 'table-cell', 'table-stripe',
  'toolbar-bg', 'toolbar-border', 'toolbar-active', 'toolbar-hover',
  'quote-border', 'quote-text',
  'diff-add-bg', 'diff-add-border', 'diff-remove-bg', 'diff-remove-border',
  'file-committed', 'file-deleted', 'file-edited', 'file-new',
  'scrollbar-thumb', 'scrollbar-thumb-hover', 'scrollbar-track',
]);

/** Stylesheets whose element is rendered through a portal to `document.body`. */
const PORTALED_TO_BODY = ['Menu.css'];

const dir = resolve(process.cwd(), 'src/components');
const sheets = readdirSync(dir)
  .filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, css: readFileSync(resolve(dir, name), 'utf8') }));

describe('theme tokens', () => {
  it('references only --nim-* variables the host defines', () => {
    const unknown = sheets.flatMap(({ name, css }) => (
      [...css.matchAll(/var\(\s*--nim-([a-z0-9-]+)/g)]
        .map(([, token]) => token)
        .filter((token) => !HOST_TOKENS.has(token))
        .map((token) => `${name}: --nim-${token}`)
    ));

    expect([...new Set(unknown)]).toEqual([]);
  });

  it('keeps --jp-* colour fallbacks out of body-portaled surfaces', () => {
    const leaked = sheets
      .filter(({ name }) => PORTALED_TO_BODY.includes(name))
      .flatMap(({ name, css }) => (
        css
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('*') && line.includes('--jp-'))
          .map((line) => `${name}: ${line.trim()}`)
      ));

    expect(leaked).toEqual([]);
  });
});
