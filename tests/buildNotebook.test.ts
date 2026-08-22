// @vitest-environment jsdom
// jsdom (plus the global stubs below) is only needed by the
// NotebookCollabBinding suite at the bottom: importing @jupyterlab/notebook
// pulls in Lumino modules that touch `document` and `DragEvent` at module
// scope, so that import is deferred. The other suites here are DOM-free.
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type * as nbformat from '@jupyterlab/nbformat';
import type { NotebookModel } from '@jupyterlab/notebook';

import { parseNotebook, serializeNotebook } from '../src/services/notebookSerializer';
import {
  getYNotebookCellSource,
  getYNotebookCells,
  NotebookCollabCodec,
  readNotebookFromYDoc,
  syncNotebookToYDoc,
} from '../src/services/notebookCollaboration';
import * as Y from 'yjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, 'fixtures', 'notebook-with-large-outputs.ipynb');

describe('parseNotebook / serializeNotebook', () => {
  it('round-trips a real notebook byte-for-byte at the structural level', () => {
    const raw = readFileSync(fixturePath, 'utf-8');
    const parsed = parseNotebook(raw);
    const reserialized = serializeNotebook(parsed);

    // The byte-for-byte guarantee we care about is structural: every cell,
    // metadata key, output, and execution_count survives. We can't compare
    // raw strings directly because indent style or trailing whitespace in
    // the fixture may differ. Re-parsing the serialized output and
    // comparing the JSON gives us the round-trip invariant.
    expect(JSON.parse(reserialized)).toEqual(parsed);
  });

  it('produces 1-space indent with a trailing newline (matches `jupyter nbconvert`)', () => {
    const raw = readFileSync(fixturePath, 'utf-8');
    const parsed = parseNotebook(raw);
    const reserialized = serializeNotebook(parsed);

    expect(reserialized.endsWith('\n')).toBe(true);
    // Pretty-printed JSON with 1-space indent uses ' "' for inner keys
    // (one space then the open quote). 2-space indent would produce '  "'.
    expect(reserialized).toMatch(/\n "cells"/);
    expect(reserialized).not.toMatch(/\n  "cells"/);
  });

  it('preserves cell IDs and metadata on round-trip', () => {
    const raw = readFileSync(fixturePath, 'utf-8');
    const parsed = parseNotebook(raw);
    const reserialized = serializeNotebook(parsed);
    const reparsed = parseNotebook(reserialized);

    const originalIds = parsed.cells.map((c) => (c as { id?: string }).id);
    const reparsedIds = reparsed.cells.map((c) => (c as { id?: string }).id);
    expect(reparsedIds).toEqual(originalIds);

    expect(reparsed.metadata).toEqual(parsed.metadata);
    expect(reparsed.nbformat).toEqual(parsed.nbformat);
    expect(reparsed.nbformat_minor).toEqual(parsed.nbformat_minor);
  });

  it('treats empty or whitespace input as an empty nbformat 4.5 notebook', () => {
    const empty = parseNotebook('');
    expect(empty.cells).toEqual([]);
    expect(empty.nbformat).toBe(4);
    expect(empty.nbformat_minor).toBe(5);
  });

  it('rejects non-notebook JSON (no `cells` array)', () => {
    expect(() => parseNotebook('{"hello": "world"}')).toThrow(
      /valid Jupyter notebook/,
    );
  });
});

describe('NotebookCollabCodec', () => {
  const notebook = {
    cells: [
      {
        id: 'imports',
        cell_type: 'code',
        metadata: { tags: ['setup'] },
        source: ['import pandas as pd\n', 'from pathlib import Path'],
        execution_count: 3,
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['ready\n'] }],
      },
      {
        id: 'summary',
        cell_type: 'markdown',
        metadata: {},
        source: '# Results\n\nInitial summary.',
      },
    ],
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
    nbformat: 4,
    nbformat_minor: 5,
  };

  it('round-trips ordered cells, sources, metadata, and per-cell outputs', () => {
    const yDoc = new Y.Doc();
    const seedFromFile = NotebookCollabCodec.seedFromFile;
    seedFromFile(yDoc, JSON.stringify(notebook));

    const exported = JSON.parse(String(NotebookCollabCodec.exportToFile(yDoc)));
    expect(exported.cells.map((cell: { id: string }) => cell.id)).toEqual(['imports', 'summary']);
    expect(exported.cells.map((cell: { source: string }) => cell.source)).toEqual([
      'import pandas as pd\nfrom pathlib import Path',
      '# Results\n\nInitial summary.',
    ]);
    expect(exported.cells[0].outputs).toEqual(notebook.cells[0].outputs);
    expect(exported.metadata).toEqual(notebook.metadata);
  });

  it('converges concurrent edits to different cell sources without replacing either cell', () => {
    const left = new Y.Doc();
    NotebookCollabCodec.seedFromFile(left, JSON.stringify(notebook));
    const right = new Y.Doc();
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));

    getYNotebookCellSource(left, 'imports').insert(
      getYNotebookCellSource(left, 'imports').length,
      '\nprint(pd.__version__)',
    );
    getYNotebookCellSource(right, 'summary').insert(
      getYNotebookCellSource(right, 'summary').length,
      '\n\nUpdated remotely.',
    );

    const leftUpdate = Y.encodeStateAsUpdate(left);
    const rightUpdate = Y.encodeStateAsUpdate(right);
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);

    const leftExport = JSON.parse(String(NotebookCollabCodec.exportToFile(left)));
    const rightExport = JSON.parse(String(NotebookCollabCodec.exportToFile(right)));
    expect(rightExport).toEqual(leftExport);
    expect(leftExport.cells.map((cell: { id: string }) => cell.id)).toEqual(['imports', 'summary']);
    expect(leftExport.cells[0].source).toContain('print(pd.__version__)');
    expect(leftExport.cells[1].source).toContain('Updated remotely.');
  });

  // The editor never edits a Y.Text directly: NotebookCollabBinding re-sends the
  // WHOLE notebook through syncNotebookToYDoc on every content change. A cell
  // with no `id` on disk (nbformat < 4.5) therefore has to be re-identified on
  // every keystroke, and a content-derived fallback id renames it each time --
  // dropping the entry, its Y.Text, and any concurrent edit to it.
  it('keeps an id-less cell identity across edits so concurrent work is not lost', () => {
    const legacy = {
      cells: [
        { cell_type: 'code', metadata: {}, source: 'x = 1', execution_count: null, outputs: [] },
        { cell_type: 'markdown', metadata: {}, source: 'Notes.' },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 4,
    } as unknown as nbformat.INotebookContent;
    const edited = (source: string): nbformat.INotebookContent => ({
      ...legacy,
      cells: [{ ...legacy.cells[0], source }, legacy.cells[1]],
    });

    const left = new Y.Doc();
    NotebookCollabCodec.seedFromFile(left, JSON.stringify(legacy));
    const right = new Y.Doc();
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    const seededKeys = Array.from(getYNotebookCells(left).keys()).sort();

    syncNotebookToYDoc(left, edited('x = 1\nprint(x)'));
    syncNotebookToYDoc(right, edited('import os\nx = 1'));

    expect(Array.from(getYNotebookCells(left).keys()).sort()).toEqual(seededKeys);

    const leftUpdate = Y.encodeStateAsUpdate(left);
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, leftUpdate);

    const leftExport = JSON.parse(String(NotebookCollabCodec.exportToFile(left)));
    expect(JSON.parse(String(NotebookCollabCodec.exportToFile(right)))).toEqual(leftExport);
    expect(leftExport.cells[0].source).toContain('print(x)');
    expect(leftExport.cells[0].source).toContain('import os');
    // The synthetic keys are internal: a 4.4 notebook still saves without ids.
    expect(leftExport.cells.every((cell: { id?: string }) => cell.id === undefined)).toBe(true);
  });

  it('keeps both cells when two peers insert at the same index, without disturbing the rest', () => {
    const left = new Y.Doc();
    NotebookCollabCodec.seedFromFile(left, JSON.stringify(notebook));
    const right = new Y.Doc();
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    const seeded = new Map(getYNotebookCells(left).entries());

    const inserted = (id: string): nbformat.INotebookContent => ({
      ...notebook,
      cells: [{ id, cell_type: 'markdown', metadata: {}, source: `# ${id}` }, ...notebook.cells],
    } as unknown as nbformat.INotebookContent);
    syncNotebookToYDoc(left, inserted('intro'));
    syncNotebookToYDoc(right, inserted('preface'));

    const leftUpdate = Y.encodeStateAsUpdate(left);
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, leftUpdate);

    const order = readNotebookFromYDoc(left).cells.map((cell) => cell.id);
    expect(readNotebookFromYDoc(right).cells.map((cell) => cell.id)).toEqual(order);
    expect(order.slice(2)).toEqual(['imports', 'summary']);
    expect(order.slice(0, 2).sort()).toEqual(['intro', 'preface']);
    // Identity, not just order: shifting the existing cells down must not
    // recreate their entries, which would drop their text history.
    expect(getYNotebookCells(left).get('imports')).toBe(seeded.get('imports'));
    expect(getYNotebookCells(left).get('summary')).toBe(seeded.get('summary'));
  });
});

describe('NotebookCollabBinding', () => {
  let createModel: () => NotebookModel;
  let NotebookCollabBinding: typeof import('../src/services/notebookCollabBinding').NotebookCollabBinding;

  beforeAll(async () => {
    vi.stubGlobal('DragEvent', class extends Event {});
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal('IntersectionObserver', class {
      readonly root = null;
      readonly rootMargin = '0px';
      readonly thresholds = [0];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    const notebookModule = await import('@jupyterlab/notebook');
    createModel = () => new notebookModule.NotebookModel();
    ({ NotebookCollabBinding } = await import('../src/services/notebookCollabBinding'));
  });

  const notebook = {
    cells: [
      { id: 'first', cell_type: 'code', metadata: {}, source: 'x = 1', execution_count: null, outputs: [] },
      { id: 'second', cell_type: 'markdown', metadata: {}, source: 'Notes.' },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };

  const cellIds = (model: NotebookModel): string[] =>
    Array.from({ length: model.cells.length }, (_, i) => model.cells.get(i).sharedModel.getId());

  const sources = (model: NotebookModel): string[] =>
    Array.from({ length: model.cells.length }, (_, i) => model.cells.get(i).sharedModel.getSource());

  it('round-trips a model edit to a peer model with cell identity preserved', () => {
    // Mirrors the editor: in a collaborative session the model is NOT loaded
    // from the file, the Y.Doc seeds it through the binding.
    const docA = new Y.Doc();
    NotebookCollabCodec.seedFromFile(docA, JSON.stringify(notebook));
    const modelA = createModel();
    const bindingA = new NotebookCollabBinding(docA, modelA);

    // JupyterLab's shared model must adopt the ids the binding hands to
    // insertCell. If it minted its own, applying a remote change would rename
    // every cell, the rename would be pushed back to the Y.Doc, and the two
    // clients would rewrite each other's ids without end.
    expect(cellIds(modelA)).toEqual(['first', 'second']);
    expect(sources(modelA)).toEqual(['x = 1', 'Notes.']);

    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const modelB = createModel();
    const bindingB = new NotebookCollabBinding(docB, modelB);
    expect(cellIds(modelB)).toEqual(['first', 'second']);

    modelA.cells.get(0).sharedModel.setSource('x = 1\nprint(x)');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    expect(sources(modelB)).toEqual(['x = 1\nprint(x)', 'Notes.']);
    expect(cellIds(modelB)).toEqual(['first', 'second']);
    // No id churn anywhere: the shared keys are still exactly the file's ids.
    expect(Array.from(getYNotebookCells(docB).keys()).sort()).toEqual(['first', 'second']);
    expect(Array.from(getYNotebookCells(docA).keys()).sort()).toEqual(['first', 'second']);

    bindingA.destroy();
    bindingB.destroy();
  });

  // A move changes only the order array -- no cell's content, metadata or
  // outputs are touched -- so a binding that observes the cells map alone sees
  // nothing at all. Everything below hangs off that: the local model stays on
  // the pre-move order, and the next local edit re-serializes it.
  describe('a remote move that changed no cell content', () => {
    const moved = {
      ...notebook,
      cells: [notebook.cells[1], notebook.cells[0]],
    } as unknown as nbformat.INotebookContent;

    /** A peer doc with no binding (the mover) and a bound model (the observer). */
    const peers = () => {
      const mover = new Y.Doc();
      NotebookCollabCodec.seedFromFile(mover, JSON.stringify(notebook));
      const observer = new Y.Doc();
      Y.applyUpdate(observer, Y.encodeStateAsUpdate(mover));
      const model = createModel();
      const binding = new NotebookCollabBinding(observer, model);
      expect(cellIds(model)).toEqual(['first', 'second']);
      return { mover, observer, model, binding };
    };

    it('reaches the observing model', () => {
      const { mover, observer, model, binding } = peers();

      syncNotebookToYDoc(mover, moved);
      Y.applyUpdate(observer, Y.encodeStateAsUpdate(mover));

      expect(cellIds(model)).toEqual(['second', 'first']);
      expect(sources(model)).toEqual(['Notes.', 'x = 1']);

      binding.destroy();
    });

    it('survives the observer editing a cell afterwards', () => {
      const { mover, observer, model, binding } = peers();

      syncNotebookToYDoc(mover, moved);
      Y.applyUpdate(observer, Y.encodeStateAsUpdate(mover));

      // The whole model -- order included -- is re-serialized on every content
      // change, so an unobserved move is written back as a move in reverse.
      model.cells.get(1).sharedModel.setSource('x = 1\nprint(x)');

      expect(readNotebookFromYDoc(observer).cells.map((cell) => cell.id)).toEqual(['second', 'first']);
      Y.applyUpdate(mover, Y.encodeStateAsUpdate(observer));
      const exported = readNotebookFromYDoc(mover);
      expect(exported.cells.map((cell) => cell.id)).toEqual(['second', 'first']);
      expect(exported.cells[1].source).toBe('x = 1\nprint(x)');

      binding.destroy();
    });
  });
});
