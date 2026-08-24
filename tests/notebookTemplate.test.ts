import { describe, expect, it } from 'vitest';

import { buildNewNotebook, toMultilineSource } from '../src/services/notebookTemplate';
import { parseNotebook, serializeNotebook } from '../src/services/notebookSerializer';

function fixedIds() {
  let n = 0;
  return () => `cell${n++}`;
}

describe('buildNewNotebook', () => {
  it('produces a notebook that round-trips through the serializer', () => {
    const notebook = buildNewNotebook({
      cells: [
        { cellType: 'markdown', source: '# Title' },
        { cellType: 'code', source: 'import pandas as pd\ndf = pd.DataFrame()' },
      ],
      makeId: fixedIds(),
    });

    const reparsed = parseNotebook(serializeNotebook(notebook));

    expect(reparsed.nbformat).toBe(4);
    expect(reparsed.nbformat_minor).toBe(5);
    expect(reparsed.cells).toHaveLength(2);
    expect(reparsed.cells[0]).toEqual({
      cell_type: 'markdown',
      id: 'cell0',
      metadata: {},
      source: ['# Title'],
    });
    expect(reparsed.cells[1]).toEqual({
      cell_type: 'code',
      id: 'cell1',
      metadata: {},
      execution_count: null,
      outputs: [],
      source: ['import pandas as pd\n', 'df = pd.DataFrame()'],
    });
    expect(reparsed.metadata.kernelspec).toEqual({
      display_name: 'Python 3 (ipykernel)',
      language: 'python',
      name: 'python3',
    });
  });
});

describe('toMultilineSource', () => {
  it('keeps trailing newlines per line and drops the empty tail', () => {
    expect(toMultilineSource('')).toEqual([]);
    expect(toMultilineSource('one')).toEqual(['one']);
    expect(toMultilineSource('one\ntwo')).toEqual(['one\n', 'two']);
    expect(toMultilineSource('one\n')).toEqual(['one\n']);
  });
});
