import { describe, expect, it } from 'vitest';
import {
  buildNotebookOutputPreview,
  buildNotebookSelectionContextItems,
  MAX_NOTEBOOK_CONTEXT_CELLS,
  type NotebookCellContextSnapshot,
} from '../src/services/selectionContext';

function cell(overrides: Partial<NotebookCellContextSnapshot> = {}): NotebookCellContextSnapshot {
  return {
    id: 'cell-a',
    index: 0,
    type: 'code',
    source: 'print("hello")',
    executionCount: 3,
    outputCount: 1,
    ...overrides,
  };
}

describe('notebook selection context', () => {
  it('reports one removable item per selected cell with stable ids and current source', () => {
    const before = buildNotebookSelectionContextItems([cell()], '/project/analysis.ipynb')[0];
    const after = buildNotebookSelectionContextItems([
      cell({ source: 'print("updated")', executionCount: 4, outputCount: 2 }),
    ], '/project/analysis.ipynb')[0];

    expect(before.id).toBe('cell:cell-a');
    expect(before.includeData).toBe(true);
    expect(before.groupLabel).toBe('analysis.ipynb');
    expect(before.label).toBe('Code cell 1');
    expect(after.id).toBe(before.id);
    expect(after.description).toContain('print("updated")');
    expect(after.description).toContain('outputs: 2');
  });

  it('bounds source and large multi-cell selections', () => {
    const cells = Array.from({ length: MAX_NOTEBOOK_CONTEXT_CELLS + 7 }, (_, index) => cell({
      id: `cell-${index}`,
      index,
      source: `value = ${index}\n${'x'.repeat(4_000)}`,
    }));
    const items = buildNotebookSelectionContextItems(cells, '/project/analysis.ipynb');

    expect(items).toHaveLength(MAX_NOTEBOOK_CONTEXT_CELLS + 1);
    expect(items.at(-1)?.id).toBe('cells:omitted:7');
    expect(items[0].description).toContain('[truncated]');
    expect(JSON.stringify(items[0].data).length).toBeLessThan(4 * 1024);
  });

  it('summarizes text outputs without embedding binary display payloads', () => {
    const preview = buildNotebookOutputPreview([
      {
        output_type: 'stream',
        name: 'stdout',
        text: [['answer: ', '42\n']] as unknown as string[],
      },
      {
        output_type: 'display_data',
        data: { 'image/png': 'a'.repeat(20_000) },
        metadata: {},
      },
    ]);

    expect(preview).toContain('answer: 42');
    expect(preview).toContain('[image/png output omitted]');
    expect(preview.length).toBeLessThanOrEqual(480);
  });
});
