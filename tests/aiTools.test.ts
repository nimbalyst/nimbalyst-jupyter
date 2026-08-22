import { describe, expect, it, vi } from 'vitest';

import { aiTools } from '../src/aiTools';
import type { JupyterEditorAPI } from '../src/editorApi';

function tool(name: string) {
  const found = aiTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Tool ${name} not found`);
  return found;
}

function context(editorAPI: JupyterEditorAPI, callBackendTool?: (name: string, params: Record<string, unknown>) => Promise<unknown>) {
  return {
    editorAPI,
    extensionContext: {
      services: {
        filesystem: {
          readFile: vi.fn(),
        },
        ai: callBackendTool ? { callBackendTool } : undefined,
      },
    },
  } as any;
}

function mockApi(overrides: Partial<JupyterEditorAPI> = {}): JupyterEditorAPI {
  return {
    isReadOnly: vi.fn(() => false),
    getCellById: vi.fn((id: string) => ({
      id,
      index: 0,
      cellType: 'code' as const,
      source: 'print("updated")',
    })),
    getCellByIndex: vi.fn(),
    listCells: vi.fn(() => [
      {
        id: 'cell-1',
        index: 0,
        cellType: 'code' as const,
        source: 'print("hello")',
        executionCount: 1,
        stale: false,
        executedBeforeRestart: false,
      },
    ]),
    getCellOutputById: vi.fn((id: string) => ({
      id,
      index: 0,
      executionCount: 1,
      outputs: [
        {
          output_type: 'stream' as const,
          name: 'stdout',
          text: 'hello\n',
        },
      ],
    })),
    getCellOutputByIndex: vi.fn(),
    getKernelStatus: vi.fn(() => 'idle' as const),
    runCellById: vi.fn(async (id: string) => ({
      id,
      index: 0,
      executionCount: 2,
      outputs: [
        {
          output_type: 'stream' as const,
          name: 'stdout',
          text: 'ran\n',
        },
      ],
      ran: true,
      kernelStatus: 'idle' as const,
    })),
    runCellByIndex: vi.fn(),
    runAll: vi.fn(async () => ({
      ran: true,
      kernelStatus: 'idle' as const,
      cells: [
        {
          id: 'cell-1',
          index: 0,
          executionCount: 2,
          outputs: [
            {
              output_type: 'stream' as const,
              name: 'stdout',
              text: 'ran\n',
            },
          ],
        },
      ],
    })),
    executeCode: vi.fn(async () => ({
      status: 'ok' as const,
      kernelStatus: 'idle' as const,
      outputs: [
        {
          output_type: 'stream' as const,
          name: 'stdout' as const,
          text: '{"variables": [{"name": "df", "type": "DataFrame"}]}\n',
        },
      ],
    })),
    interrupt: vi.fn(async () => true),
    restartKernel: vi.fn(async () => ({
      restarted: true,
      kernelStatus: 'idle' as const,
    })),
    getExecutionStatus: vi.fn(() => ({
      kernelStatus: 'busy' as const,
      executions: [
        {
          kind: 'cell' as const,
          cellId: 'cell-1',
          index: 0,
          elapsedMs: 1200,
          done: false,
          ran: null,
        },
      ],
    })),
    updateCellSource: vi.fn(() => true),
    insertCell: vi.fn(() => ({
      id: 'inserted',
      index: 1,
      cellType: 'markdown' as const,
      source: '# inserted',
    })),
    deleteCell: vi.fn(() => true),
    moveCell: vi.fn((id: string, toIndex: number) => ({
      id,
      index: toIndex,
      cellType: 'code' as const,
      source: 'print("hello")',
    })),
    setCellType: vi.fn((id: string, cellType) => ({
      id: `${id}-new`,
      index: 0,
      cellType,
      source: 'print("hello")',
    })),
    clearOutputs: vi.fn(() => 3),
    ...overrides,
  };
}

describe('jupyter AI tools', () => {
  it('lists live editor cells with kernel status and freshness flags', async () => {
    const api = mockApi();
    const result = await tool('jupyter.list_cells').handler({}, context(api));

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      kernelStatus: 'idle',
      cells: [
        {
          id: 'cell-1',
          index: 0,
          cellType: 'code',
          source: 'print("hello")',
          executionCount: 1,
          stale: false,
          executedBeforeRestart: false,
        },
      ],
    });
  });

  it('returns compact output for a requested cell', async () => {
    const api = mockApi();
    const result = await tool('jupyter.get_cell_output').handler(
      { cellId: 'cell-1' },
      context(api),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      kernelStatus: 'idle',
      cell: {
        id: 'cell-1',
        outputs: [{ outputType: 'stream', name: 'stdout', text: 'hello\n' }],
      },
    });
  });

  it('saves image outputs through the backend when includeImages is set', async () => {
    const api = mockApi({
      getCellOutputById: vi.fn(() => ({
        id: 'cell-1',
        index: 0,
        executionCount: 1,
        outputs: [
          {
            output_type: 'display_data' as const,
            data: { 'image/png': 'aGVsbG8=' },
            metadata: {},
          },
        ],
      })),
    });
    const callBackendTool = vi.fn(async () => ({ path: '/tmp/assets/cell-1.png', bytes: 5 }));
    const result = await tool('jupyter.get_cell_output').handler(
      { cellId: 'cell-1', includeImages: true },
      context(api, callBackendTool),
    );

    expect(callBackendTool).toHaveBeenCalledWith('jupyter.save_output_asset', {
      data: 'aGVsbG8=',
      encoding: 'base64',
      mime: 'image/png',
      prefix: 'cell-cell-1',
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      imageFiles: [{ mime: 'image/png', path: '/tmp/assets/cell-1.png', outputIndex: 0 }],
    });
  });

  it('runs one cell through the editor API with the default timeout', async () => {
    const api = mockApi();
    const result = await tool('jupyter.run_cell').handler(
      { cellId: 'cell-1' },
      context(api),
    );

    expect(api.runCellById).toHaveBeenCalledWith('cell-1', { timeoutMs: 60_000 });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      kernelStatus: 'idle',
      cell: {
        id: 'cell-1',
        outputs: [{ outputType: 'stream', text: 'ran\n' }],
      },
    });
  });

  it('reports still-running on run_cell timeout instead of failing', async () => {
    const api = mockApi({
      runCellById: vi.fn(async () => ({
        id: 'cell-1',
        index: 0,
        executionCount: null,
        outputs: [],
        ran: false,
        timedOut: true,
        kernelStatus: 'busy' as const,
      })),
    });
    const result = await tool('jupyter.run_cell').handler(
      { cellId: 'cell-1', timeoutMs: 500 },
      context(api),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ stillRunning: true, kernelStatus: 'busy' });
    expect(result.message).toContain('still running');
  });

  it('executes transient code and reports execution status', async () => {
    const api = mockApi();
    const executeResult = await tool('jupyter.execute').handler(
      { code: 'df.shape' },
      context(api),
    );
    expect(api.executeCode).toHaveBeenCalledWith('df.shape', { timeoutMs: 30_000 });
    expect(executeResult.success).toBe(true);

    const statusResult = await tool('jupyter.get_execution_status').handler({}, context(api));
    expect(statusResult.success).toBe(true);
    expect(statusResult.data).toMatchObject({
      kernelStatus: 'busy',
      executions: [{ cellId: 'cell-1', done: false }],
    });
  });

  it('parses introspection JSON from list_variables', async () => {
    const api = mockApi();
    const result = await tool('jupyter.list_variables').handler({}, context(api));

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      kernelStatus: 'idle',
      variables: [{ name: 'df', type: 'DataFrame' }],
    });
  });

  it('rejects unsafe variable paths without touching the kernel', async () => {
    const api = mockApi();
    const result = await tool('jupyter.inspect_variable').handler(
      { name: 'df; import os' },
      context(api),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid variable path');
    expect(api.executeCode).not.toHaveBeenCalled();
  });

  it('interrupts and restarts the kernel', async () => {
    const api = mockApi();
    const interruptResult = await tool('jupyter.interrupt').handler({}, context(api));
    const restartResult = await tool('jupyter.restart_kernel').handler(
      { runAll: false },
      context(api),
    );

    expect(interruptResult.success).toBe(true);
    expect(api.restartKernel).toHaveBeenCalledWith({ runAll: false });
    expect(restartResult.success).toBe(true);
  });

  it('updates and inserts cells through editor-write tools', async () => {
    const api = mockApi();

    const updateResult = await tool('jupyter.update_cell_source').handler(
      { cellId: 'cell-1', source: 'print("updated")' },
      context(api),
    );
    const insertResult = await tool('jupyter.insert_cell').handler(
      { cellType: 'markdown', source: '# inserted', afterId: 'cell-1' },
      context(api),
    );

    expect(api.updateCellSource).toHaveBeenCalledWith('cell-1', 'print("updated")');
    expect(api.insertCell).toHaveBeenCalledWith({
      cellType: 'markdown',
      source: '# inserted',
      afterId: 'cell-1',
      beforeId: null,
      position: 'end',
    });
    expect(updateResult.success).toBe(true);
    expect(insertResult.success).toBe(true);
  });

  it('defaults insert placement to end and errors on a missing anchor', async () => {
    const api = mockApi();
    await tool('jupyter.insert_cell').handler(
      { cellType: 'code', source: 'x = 1' },
      context(api),
    );
    expect(api.insertCell).toHaveBeenCalledWith({
      cellType: 'code',
      source: 'x = 1',
      afterId: null,
      beforeId: null,
      position: 'end',
    });

    const missingAnchor = await tool('jupyter.insert_cell').handler(
      { cellType: 'code', source: 'x = 1', afterId: 'nope' },
      context(mockApi({ insertCell: vi.fn(() => null) })),
    );
    expect(missingAnchor.success).toBe(false);
    expect(missingAnchor.error).toContain('Anchor cell');
  });

  it('deletes, moves, retypes, and clears cells', async () => {
    const api = mockApi();

    const deleteResult = await tool('jupyter.delete_cell').handler(
      { cellId: 'cell-1' },
      context(api),
    );
    const moveResult = await tool('jupyter.move_cell').handler(
      { cellId: 'cell-1', toIndex: 2 },
      context(api),
    );
    const typeResult = await tool('jupyter.set_cell_type').handler(
      { cellId: 'cell-1', cellType: 'markdown' },
      context(api),
    );
    const clearResult = await tool('jupyter.clear_outputs').handler({}, context(api));

    expect(api.deleteCell).toHaveBeenCalledWith('cell-1');
    expect(api.moveCell).toHaveBeenCalledWith('cell-1', 2);
    expect(api.setCellType).toHaveBeenCalledWith('cell-1', 'markdown');
    expect(api.clearOutputs).toHaveBeenCalledWith(undefined);
    expect(deleteResult.success).toBe(true);
    expect(moveResult.success).toBe(true);
    expect(typeResult.success).toBe(true);
    expect(typeResult.data).toMatchObject({ cell: { id: 'cell-1-new', cellType: 'markdown' } });
    expect(clearResult.success).toBe(true);
    expect(clearResult.data).toEqual({ cleared: 3 });
  });

  it('refuses every editor-write tool on a read-only notebook', async () => {
    const api = mockApi({ isReadOnly: vi.fn(() => true) });
    const writeTools = aiTools.filter(
      (candidate) => (candidate.access as { kind?: string } | undefined)?.kind === 'editor-write',
    );
    expect(writeTools.map((candidate) => candidate.name)).toEqual([
      'jupyter.run_cell',
      'jupyter.run_all',
      'jupyter.restart_kernel',
      'jupyter.update_cell_source',
      'jupyter.insert_cell',
      'jupyter.delete_cell',
      'jupyter.move_cell',
      'jupyter.set_cell_type',
      'jupyter.clear_outputs',
    ]);

    for (const writeTool of writeTools) {
      const result = await writeTool.handler(
        { cellId: 'cell-1', source: 'print("nope")', cellType: 'markdown', toIndex: 2 },
        context(api),
      );
      expect(result.success, `${writeTool.name} should be refused`).toBe(false);
      expect(result.error).toMatch(/read-only/);
    }

    expect(api.updateCellSource).not.toHaveBeenCalled();
    expect(api.insertCell).not.toHaveBeenCalled();
    expect(api.deleteCell).not.toHaveBeenCalled();
    expect(api.moveCell).not.toHaveBeenCalled();
    expect(api.setCellType).not.toHaveBeenCalled();
    expect(api.clearOutputs).not.toHaveBeenCalled();
    expect(api.runCellById).not.toHaveBeenCalled();
    expect(api.runAll).not.toHaveBeenCalled();
    expect(api.restartKernel).not.toHaveBeenCalled();
  });

  it('still allows transient execute on a read-only notebook', async () => {
    const api = mockApi({ isReadOnly: vi.fn(() => true) });
    const result = await tool('jupyter.execute').handler({ code: '1 + 1' }, context(api));

    expect(result.success).toBe(true);
    expect(api.executeCode).toHaveBeenCalled();
  });
});
