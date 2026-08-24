/**
 * Builds fresh `.ipynb` content for `jupyter.create_notebook`.
 *
 * Kept pure and DOM-free (like `notebookSerializer`) so it is importable
 * from Node tests and from the tool handler without touching the editor.
 * An agent starting an analysis from nothing has no live model to write
 * through, so this is the one write path that legitimately builds
 * nbformat by hand rather than going through `NotebookModel`.
 */

import type * as nbformat from '@jupyterlab/nbformat';
import type { CellType } from '../editorApi';

export interface NewNotebookCell {
  cellType: CellType;
  source: string;
}

export interface NewNotebookOptions {
  cells?: NewNotebookCell[];
  /** kernelspec name written to metadata. Default `python3`. */
  kernelName?: string;
  /** kernelspec display name. Defaults to a label derived from kernelName. */
  kernelDisplayName?: string;
  /** kernelspec/language_info language. Default `python`. */
  language?: string;
  /** Injected for deterministic tests; defaults to random hex. */
  makeId?: () => string;
}

const DEFAULT_KERNEL_NAME = 'python3';
const DEFAULT_KERNEL_DISPLAY_NAME = 'Python 3 (ipykernel)';
const DEFAULT_LANGUAGE = 'python';

export function buildNewNotebook(
  options: NewNotebookOptions = {},
): nbformat.INotebookContent {
  const makeId = options.makeId ?? randomCellId;
  const kernelName = options.kernelName?.trim() || DEFAULT_KERNEL_NAME;
  const language = options.language?.trim() || DEFAULT_LANGUAGE;
  const displayName =
    options.kernelDisplayName?.trim() ||
    (kernelName === DEFAULT_KERNEL_NAME ? DEFAULT_KERNEL_DISPLAY_NAME : kernelName);

  // A zero-cell notebook opens as a blank editor with nothing to click, so an
  // empty request still gets one code cell to type into.
  const requested = options.cells?.length ? options.cells : [{ cellType: 'code' as const, source: '' }];

  return {
    cells: requested.map((cell) => buildCell(cell, makeId())),
    metadata: {
      kernelspec: {
        display_name: displayName,
        language,
        name: kernelName,
      },
      language_info: {
        name: language,
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function buildCell(cell: NewNotebookCell, id: string): nbformat.ICell {
  const source = toMultilineSource(cell.source);
  if (cell.cellType === 'code') {
    return {
      cell_type: 'code',
      id,
      metadata: {},
      execution_count: null,
      outputs: [],
      source,
    } as nbformat.ICodeCell;
  }
  return {
    cell_type: cell.cellType,
    id,
    metadata: {},
    source,
  } as nbformat.ICell;
}

/**
 * nbformat stores source as a list of lines, each keeping its trailing
 * newline except the last. Matching that keeps diffs against notebooks
 * saved by JupyterLab or nbconvert minimal.
 */
export function toMultilineSource(source: string): string[] {
  if (source.length === 0) return [];
  const lines = source.split('\n');
  return lines.map((line, index) => (index === lines.length - 1 ? line : `${line}\n`)).filter(
    (line, index, all) => !(index === all.length - 1 && line === ''),
  );
}

/** 8 hex chars, matching the shape JupyterLab writes for nbformat 4.5 IDs. */
function randomCellId(): string {
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return id;
}
