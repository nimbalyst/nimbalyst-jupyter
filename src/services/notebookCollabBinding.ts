/** Bidirectional bridge between JupyterLab's local NotebookModel and the host Y.Doc. */

import type * as nbformat from '@jupyterlab/nbformat';
import type { NotebookModel } from '@jupyterlab/notebook';
import { applyTextDiff, COLLAB_INIT_ORIGIN } from '@nimbalyst/extension-sdk';
import * as Y from 'yjs';

import {
  getYNotebookCellOrder,
  getYNotebookCells,
  readNotebookFromYDoc,
  syncNotebookToYDoc,
  Y_NOTEBOOK_META,
} from './notebookCollaboration';

type JsonObject = Record<string, unknown>;

interface MutableSharedNotebook {
  nbformat: number;
  nbformat_minor: number;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceText(source: nbformat.MultilineString | undefined): string {
  return Array.isArray(source) ? source.join('') : String(source ?? '');
}

function syncMetadata(
  current: JsonObject,
  next: JsonObject,
  remove: (key: string) => void,
  set: (key: string, value: unknown) => void,
): void {
  for (const key of Object.keys(current)) {
    if (!(key in next)) remove(key);
  }
  for (const [key, value] of Object.entries(next)) {
    if (!jsonEqual(current[key], value)) set(key, cloneJson(value));
  }
}

function contentFromModel(model: NotebookModel): nbformat.INotebookContent {
  const notebook = model.toJSON();
  return {
    ...notebook,
    cells: Array.from({ length: model.cells.length }, (_, index) => {
      const sharedCell = model.cells.get(index).sharedModel;
      return {
        ...sharedCell.toJSON(),
        id: sharedCell.getId(),
      } as nbformat.ICell;
    }),
  };
}

function applyNotebookToModel(model: NotebookModel, notebook: nbformat.INotebookContent): void {
  const shared = model.sharedModel;
  const mutable = shared as typeof shared & MutableSharedNotebook;
  if (shared.nbformat !== notebook.nbformat) mutable.nbformat = notebook.nbformat;
  if (shared.nbformat_minor !== notebook.nbformat_minor) mutable.nbformat_minor = notebook.nbformat_minor;
  syncMetadata(
    shared.getMetadata() as JsonObject,
    (notebook.metadata ?? {}) as JsonObject,
    (key) => shared.deleteMetadata(key),
    (key, value) => shared.setMetadata(key, value as never),
  );

  const desiredIds = notebook.cells.map((cell) => String(cell.id));
  for (let index = shared.cells.length - 1; index >= 0; index -= 1) {
    if (!desiredIds.includes(shared.cells[index].getId())) shared.deleteCell(index);
  }

  for (let index = 0; index < notebook.cells.length; index += 1) {
    const desired = notebook.cells[index];
    const desiredId = String(desired.id);
    let currentIndex = shared.cells.findIndex((cell) => cell.getId() === desiredId);
    if (currentIndex < 0) {
      shared.insertCell(index, desired as never);
      currentIndex = index;
    } else if (currentIndex !== index) {
      shared.moveCell(currentIndex, index);
      currentIndex = index;
    }

    let current = shared.cells[currentIndex];
    if (current.cell_type !== desired.cell_type) {
      shared.deleteCell(currentIndex);
      current = shared.insertCell(currentIndex, desired as never);
    }

    const nextSource = sourceText(desired.source);
    applyTextDiff(current.getSource(), nextSource, (start, end, inserted) => {
      current.updateSource(start, end, inserted);
    });
    syncMetadata(
      current.getMetadata() as JsonObject,
      (desired.metadata ?? {}) as JsonObject,
      (key) => current.deleteMetadata(key),
      (key, value) => current.setMetadata(key, value as never),
    );

    if (desired.cell_type === 'code' && current.cell_type === 'code' && 'getOutputs' in current) {
      const desiredCode = desired as nbformat.ICodeCell;
      if (!jsonEqual(current.getOutputs(), desiredCode.outputs ?? [])) {
        current.setOutputs(cloneJson(desiredCode.outputs ?? []));
      }
      if (current.execution_count !== (desiredCode.execution_count ?? null)) {
        current.execution_count = desiredCode.execution_count ?? null;
      }
    }

    if ('setAttachments' in current) {
      const desiredAttachments = 'attachments' in desired ? desired.attachments : undefined;
      const currentAttachments = current.getAttachments();
      if (!jsonEqual(currentAttachments, desiredAttachments)) {
        current.setAttachments(cloneJson(desiredAttachments) as nbformat.IAttachments | undefined);
      }
    }
  }
}

export class NotebookCollabBinding {
  private readonly localOrigin = Symbol('jupyter-local-collab');
  private applyingRemote = false;
  private destroyed = false;
  private lastRemoteTransaction: Y.Transaction | null = null;

  constructor(
    private readonly yDoc: Y.Doc,
    private readonly model: NotebookModel,
  ) {
    this.applyRemoteState();
    this.model.contentChanged.connect(this.onLocalContentChanged);
    getYNotebookCells(this.yDoc).observeDeep(this.onRemoteCellsChanged);
    // Order is a sibling array, not part of the cells map: a move touches it
    // and nothing else, so without this the local model never learns about a
    // remote reorder -- and re-sends its stale order on the next local edit,
    // undoing the move.
    getYNotebookCellOrder(this.yDoc).observe(this.onRemoteOrderChanged);
    this.yDoc.getMap(Y_NOTEBOOK_META).observeDeep(this.onRemoteMetaChanged);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.model.contentChanged.disconnect(this.onLocalContentChanged);
    getYNotebookCells(this.yDoc).unobserveDeep(this.onRemoteCellsChanged);
    getYNotebookCellOrder(this.yDoc).unobserve(this.onRemoteOrderChanged);
    this.yDoc.getMap(Y_NOTEBOOK_META).unobserveDeep(this.onRemoteMetaChanged);
  }

  private readonly onLocalContentChanged = (): void => {
    if (this.destroyed || this.applyingRemote) return;
    syncNotebookToYDoc(this.yDoc, contentFromModel(this.model), this.localOrigin);
  };

  private readonly onRemoteCellsChanged = (
    _events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
    transaction: Y.Transaction,
  ): void => this.onRemoteTransaction(transaction);

  private readonly onRemoteOrderChanged = (
    _event: Y.YArrayEvent<string>,
    transaction: Y.Transaction,
  ): void => this.onRemoteTransaction(transaction);

  private readonly onRemoteMetaChanged = (
    _events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
    transaction: Y.Transaction,
  ): void => this.onRemoteTransaction(transaction);

  private onRemoteTransaction(transaction: Y.Transaction): void {
    if (
      this.destroyed
      || transaction.origin === this.localOrigin
      || transaction.origin === COLLAB_INIT_ORIGIN
      || transaction === this.lastRemoteTransaction
    ) {
      return;
    }
    this.lastRemoteTransaction = transaction;
    this.applyRemoteState();
  }

  private applyRemoteState(): void {
    this.applyingRemote = true;
    try {
      applyNotebookToModel(
        this.model,
        readNotebookFromYDoc(this.yDoc, { includeInternalCellIds: true }),
      );
    } finally {
      this.applyingRemote = false;
    }
  }
}
