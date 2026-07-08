/**
 * Pure parse / serialize helpers for nbformat `.ipynb` content.
 * Importable from Node test environments because it touches no DOM.
 */

import type * as nbformat from '@jupyterlab/nbformat';

/**
 * Parse raw `.ipynb` text. Throws if the JSON is invalid or doesn't look
 * like a notebook (lets the editor surface a load error instead of
 * silently mounting an empty notebook).
 */
export function parseNotebook(raw: string): nbformat.INotebookContent {
  const trimmed = raw.trim();
  if (!trimmed) {
    return emptyNotebook();
  }
  const json = JSON.parse(trimmed);
  if (!json || typeof json !== 'object' || !Array.isArray(json.cells)) {
    throw new Error('Not a valid Jupyter notebook (missing cells array)');
  }
  return json as nbformat.INotebookContent;
}

/**
 * Serialize a notebook to the canonical on-disk shape: 1-space indent
 * plus a trailing newline. Matches `jupyter nbconvert` / JupyterLab's
 * default formatting so diffs against notebooks edited elsewhere stay
 * minimal.
 */
export function serializeNotebook(content: nbformat.INotebookContent): string {
  return JSON.stringify(content, null, 1) + '\n';
}

function emptyNotebook(): nbformat.INotebookContent {
  return {
    cells: [],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
}
