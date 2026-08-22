import type { ExtensionAITool } from '@nimbalyst/extension-sdk';
import type * as nbformat from '@jupyterlab/nbformat';
import type {
    CellOutputSnapshot,
    CellType,
    JupyterEditorAPI,
} from './editorApi';
import { buildNotebookProjection } from './services/notebookProjection';
import {
    buildInspectVariableSnippet,
    buildListVariablesSnippet,
    buildPreviewDataFrameSnippet,
    isValidVariablePath,
    parseIntrospectionResult,
} from './services/kernelIntrospection';

const IPYNB_FILE_PATTERN = ['*.ipynb'];
const DEFAULT_OUTPUT_CHAR_LIMIT = 12000;
const MAX_OUTPUT_CHAR_LIMIT = 100000;
const DEFAULT_RUN_TIMEOUT_MS = 60_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000;

const FILE_PATH_PROPERTY = {
    type: 'string' as const,
    description:
        'Absolute path to the `.ipynb` file, or omit when it is the active file.',
};

const TIMEOUT_PROPERTY = {
    type: 'number' as const,
    description:
        'Stop waiting after this many ms and return partial results; the kernel keeps running. Use jupyter.get_execution_status to poll and jupyter.interrupt to stop it.',
};

const MAX_CHARS_PROPERTY = {
    type: 'number' as const,
    description: 'Maximum characters per output payload. Default 12000.',
};

export const aiTools: ExtensionAITool[] = [
    {
        name: 'jupyter.get_notebook_projection',
        access: { kind: 'filesystem' } as const,
        description:
            'Read a Jupyter `.ipynb` notebook and return a compact projection: cell sources preserved verbatim, outputs replaced with short MIME-aware placeholders (e.g. `[stdout hidden: 12 lines]`, `[image/png hidden: 142 chars]`). ALWAYS prefer this over the generic `Read` tool when working with `.ipynb` files -- the raw notebook JSON is dominated by output blobs (base64 images, JSON dumps, long stdout) that waste tokens and rarely matter for code reasoning. To see a specific cell output in full, use jupyter.get_cell_output; this projection is the default view.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description:
                        'Absolute path to the `.ipynb` file, or path relative to the workspace root.',
                },
            },
            required: ['filePath'],
        },
        scope: 'global',
        handler: async (params, context) => {
            const rawPath = typeof params.filePath === 'string' ? params.filePath : '';
            if (rawPath.length === 0) {
                return {
                    success: false,
                    error: '`filePath` is required and must be a non-empty string.',
                };
            }
            if (!/\.ipynb$/i.test(rawPath)) {
                return {
                    success: false,
                    error: `\`filePath\` must point to an .ipynb file (got "${rawPath}").`,
                };
            }

            let raw: string;
            try {
                raw = await context.extensionContext.services.filesystem.readFile(rawPath);
            } catch (error) {
                return {
                    success: false,
                    error: `Failed to read notebook at "${rawPath}": ${error instanceof Error ? error.message : String(error)}`,
                };
            }

            const projection = buildNotebookProjection(raw);
            if (projection.parseError) {
                // Still return success so the agent sees the projection's note
                // about the parse failure rather than re-fetching with Read.
                return {
                    success: true,
                    message: `Notebook at "${rawPath}" could not be parsed as nbformat JSON; returning a marker projection.`,
                    data: {
                        content: projection.content,
                        cellCount: projection.cellCount,
                        sourceBytes: projection.sourceBytes,
                        projectedBytes: projection.projectedBytes,
                        outputsRedacted: projection.outputsRedacted,
                        parseError: projection.parseError,
                    },
                };
            }

            return {
                success: true,
                message: `Projected ${projection.cellCount} cells (${projection.sourceBytes} -> ${projection.projectedBytes} bytes).`,
                data: {
                    content: projection.content,
                    cellCount: projection.cellCount,
                    sourceBytes: projection.sourceBytes,
                    projectedBytes: projection.projectedBytes,
                    outputsRedacted: projection.outputsRedacted,
                },
            };
        },
    },
    {
        name: 'jupyter.list_cells',
        access: { kind: 'editor-read' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'List cells in a mounted Jupyter notebook editor. Returns stable cell IDs, indexes, cell types, sources, execution counts, and freshness flags (`stale`: source edited since last run; `executedBeforeRestart`: last run predates the latest kernel restart, so its side effects are gone; null = unknown). Use this before cell-level edits or execution.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
            },
        },
        handler: async (_params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const cells = api.value.listCells();
            return {
                success: true,
                message: `Notebook has ${cells.length} cell(s).`,
                data: {
                    kernelStatus: api.value.getKernelStatus(),
                    cells,
                },
            };
        },
    },
    {
        name: 'jupyter.get_cell_output',
        access: { kind: 'editor-read' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Read output for a specific notebook cell from the live editor. Outputs are MIME-aware and truncated by default; use maxChars for larger payloads. Pass includeImages=true to save image outputs (plots, figures) as PNG/SVG files and get back file paths you can Read to actually see them.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                cellId: {
                    type: 'string',
                    description: 'Stable notebook cell ID. Preferred over index.',
                },
                index: {
                    type: 'number',
                    description: 'Zero-based cell index. Used when cellId is omitted.',
                },
                maxChars: MAX_CHARS_PROPERTY,
                includeImages: {
                    type: 'boolean',
                    description:
                        'Save image outputs to files and return their paths. Default false.',
                },
            },
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const cell = getCellOutput(api.value, params);
            if (!cell) return missingCellResult(params);
            const imageFiles =
                params.includeImages === true
                    ? await saveImageOutputs(cell, context)
                    : undefined;
            return {
                success: true,
                message: buildOutputMessage(cell, imageFiles),
                data: {
                    kernelStatus: api.value.getKernelStatus(),
                    cell: compactOutputSnapshot(cell, getMaxChars(params.maxChars)),
                    ...(imageFiles ? { imageFiles } : {}),
                },
            };
        },
    },
    {
        name: 'jupyter.run_cell',
        access: { kind: 'editor-write' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Run one notebook cell through the live Jupyter kernel and return its resulting outputs. Requires an attached kernel. Waits up to timeoutMs (default 60000); on timeout the cell keeps running -- poll with jupyter.get_execution_status or stop it with jupyter.interrupt.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                cellId: {
                    type: 'string',
                    description: 'Stable notebook cell ID. Preferred over index.',
                },
                index: {
                    type: 'number',
                    description: 'Zero-based cell index. Used when cellId is omitted.',
                },
                maxChars: MAX_CHARS_PROPERTY,
                timeoutMs: TIMEOUT_PROPERTY,
            },
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const result = await runCell(api.value, params);
            if (!result) return missingCellResult(params);
            if (result.timedOut) {
                return {
                    success: true,
                    message: `Cell ${result.index} (${result.id}) is still running after ${getTimeout(params.timeoutMs, DEFAULT_RUN_TIMEOUT_MS)}ms. Partial outputs included; poll jupyter.get_execution_status or call jupyter.interrupt.`,
                    data: {
                        kernelStatus: result.kernelStatus,
                        stillRunning: true,
                        cell: compactOutputSnapshot(result, getMaxChars(params.maxChars)),
                    },
                };
            }
            return {
                success: result.ran,
                message: result.ran
                    ? `Ran cell ${result.index} (${result.id}); kernel status ${result.kernelStatus}.${hasImageOutput(result) ? ' Cell produced image output; call jupyter.get_cell_output with includeImages=true to view it.' : ''}`
                    : `Cell ${result.index} (${result.id}) was not run; kernel status ${result.kernelStatus}.`,
                data: {
                    kernelStatus: result.kernelStatus,
                    cell: compactOutputSnapshot(result, getMaxChars(params.maxChars)),
                },
                error: result.ran ? undefined : 'Cell did not run. Check that a kernel is attached and idle.',
            };
        },
    },
    {
        name: 'jupyter.run_all',
        access: { kind: 'editor-write' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Run every notebook cell through the live Jupyter kernel and return compact output snapshots for code cells. Waits up to timeoutMs (default 60000); on timeout execution continues -- poll with jupyter.get_execution_status.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                maxChars: MAX_CHARS_PROPERTY,
                timeoutMs: TIMEOUT_PROPERTY,
            },
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const result = await api.value.runAll({
                timeoutMs: getTimeout(params.timeoutMs, DEFAULT_RUN_TIMEOUT_MS),
            });
            const maxChars = getMaxChars(params.maxChars);
            const cells = result.cells
                .filter((cell) => cell.outputs.length > 0 || cell.executionCount != null)
                .map((cell) => compactOutputSnapshot(cell, maxChars));
            if (result.timedOut) {
                return {
                    success: true,
                    message: `Notebook is still running after ${getTimeout(params.timeoutMs, DEFAULT_RUN_TIMEOUT_MS)}ms. Partial outputs included; poll jupyter.get_execution_status or call jupyter.interrupt.`,
                    data: { kernelStatus: result.kernelStatus, stillRunning: true, cells },
                };
            }
            return {
                success: result.ran,
                message: result.ran
                    ? `Ran ${result.cells.length} cell(s); kernel status ${result.kernelStatus}.`
                    : `Notebook was not run; kernel status ${result.kernelStatus}.`,
                data: { kernelStatus: result.kernelStatus, cells },
                error: result.ran || result.timedOut ? undefined : 'Notebook did not run. Check that a kernel is attached and idle.',
            };
        },
    },
    {
        name: 'jupyter.execute',
        access: { kind: 'editor-read' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Run scratch Python in the notebook kernel WITHOUT creating or modifying any cell -- no history entry, no execution-count bump. Use for quick state checks (df.shape, type(x), locals) while reasoning. Durable analysis steps belong in cells (jupyter.insert_cell + jupyter.run_cell) so the notebook stays a complete record.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                code: {
                    type: 'string',
                    description: 'Python source to execute in the kernel user namespace.',
                },
                timeoutMs: TIMEOUT_PROPERTY,
                maxChars: MAX_CHARS_PROPERTY,
            },
            required: ['code'],
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const code = typeof params.code === 'string' ? params.code : '';
            if (!code) return { success: false, error: '`code` is required.' };
            const result = await api.value.executeCode(code, {
                timeoutMs: getTimeout(params.timeoutMs, DEFAULT_EXECUTE_TIMEOUT_MS),
            });
            const maxChars = getMaxChars(params.maxChars);
            return {
                success: result.status === 'ok',
                message: `Transient execution status: ${result.status}; kernel status ${result.kernelStatus}.`,
                data: {
                    status: result.status,
                    kernelStatus: result.kernelStatus,
                    outputs: result.outputs.map((output) => compactOutput(output, maxChars)),
                },
                error:
                    result.status === 'ok'
                        ? undefined
                        : result.status === 'no-kernel'
                            ? 'No kernel attached to the notebook editor.'
                            : result.status === 'timeout'
                                ? 'Execution timed out; the kernel is still running the code. Call jupyter.interrupt to stop it.'
                                : 'Execution raised an error; see outputs.',
            };
        },
    },
    {
        name: 'jupyter.get_execution_status',
        access: { kind: 'editor-read' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Report kernel status and in-flight or recently finished cell executions (elapsed ms, done, success). Use after a run_cell/run_all timeout to poll a long-running cell without re-running it.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
            },
        },
        handler: async (_params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const report = api.value.getExecutionStatus();
            return {
                success: true,
                message: `Kernel status ${report.kernelStatus}; ${report.executions.filter((e) => !e.done).length} execution(s) in flight.`,
                data: report,
            };
        },
    },
    {
        name: 'jupyter.interrupt',
        access: { kind: 'editor-read' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Interrupt the notebook kernel (like Ctrl+C) to stop a runaway or long-running cell. Kernel state (variables) is preserved.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
            },
        },
        handler: async (_params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const interrupted = await api.value.interrupt();
            return {
                success: interrupted,
                message: interrupted
                    ? `Sent interrupt; kernel status ${api.value.getKernelStatus()}.`
                    : 'No kernel attached to interrupt.',
                error: interrupted ? undefined : 'No kernel attached to the notebook editor.',
            };
        },
    },
    {
        name: 'jupyter.restart_kernel',
        access: { kind: 'editor-write' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Restart the notebook kernel, clearing all variables and imports. Pass runAll=true to re-execute the whole notebook after the restart (reproducibility check).',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                runAll: {
                    type: 'boolean',
                    description: 'Run all cells after restarting. Default false.',
                },
            },
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const result = await api.value.restartKernel({ runAll: params.runAll === true });
            return {
                success: result.restarted,
                message: result.restarted
                    ? `Kernel restarted${result.ran != null ? `; run-all ${result.ran ? 'completed' : 'did not complete'}` : ''}; kernel status ${result.kernelStatus}.`
                    : 'Kernel was not restarted.',
                data: result,
                error: result.restarted ? undefined : 'Kernel restart failed or no kernel is attached.',
            };
        },
    },
    {
        name: 'jupyter.list_variables',
        access: { kind: 'editor-read' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'List variables in the kernel user namespace with type, short repr preview, and shape/length. Cheaper and more reliable than inserting print cells. Requires a running kernel.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                timeoutMs: TIMEOUT_PROPERTY,
            },
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            return runIntrospection(api.value, buildListVariablesSnippet(), params, 'Listed kernel variables.');
        },
    },
    {
        name: 'jupyter.inspect_variable',
        access: { kind: 'editor-read' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Inspect one kernel variable (or dotted attribute path like `model.coef_`): full repr up to maxChars, type, shape/dtype/length, dict keys. For arbitrary expressions use jupyter.execute.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                name: {
                    type: 'string',
                    description: 'Variable name or dotted attribute path (e.g. `df` or `result.params`).',
                },
                maxChars: MAX_CHARS_PROPERTY,
                timeoutMs: TIMEOUT_PROPERTY,
            },
            required: ['name'],
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const name = typeof params.name === 'string' ? params.name : '';
            if (!isValidVariablePath(name)) {
                return {
                    success: false,
                    error: `Invalid variable path "${name}". Use a plain name or dotted attribute path; for expressions use jupyter.execute.`,
                };
            }
            return runIntrospection(
                api.value,
                buildInspectVariableSnippet(name, getMaxChars(params.maxChars)),
                params,
                `Inspected ${name}.`,
            );
        },
    },
    {
        name: 'jupyter.preview_dataframe',
        access: { kind: 'editor-read' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Preview a pandas/polars DataFrame (or pandas Series) in the kernel: shape, dtypes, null counts, and the first N rows as text. The fastest way to understand tabular state without writing cells.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                name: {
                    type: 'string',
                    description: 'DataFrame variable name or dotted attribute path.',
                },
                rows: {
                    type: 'number',
                    description: 'Rows to include from head(). Default 10, max 100.',
                },
                timeoutMs: TIMEOUT_PROPERTY,
            },
            required: ['name'],
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const name = typeof params.name === 'string' ? params.name : '';
            if (!isValidVariablePath(name)) {
                return {
                    success: false,
                    error: `Invalid variable path "${name}". Use a plain name or dotted attribute path; for expressions use jupyter.execute.`,
                };
            }
            const rows = typeof params.rows === 'number' && Number.isFinite(params.rows)
                ? params.rows
                : 10;
            return runIntrospection(
                api.value,
                buildPreviewDataFrameSnippet(name, rows),
                params,
                `Previewed ${name}.`,
            );
        },
    },
    {
        name: 'jupyter.update_cell_source',
        access: { kind: 'editor-write' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Replace the source of an existing notebook cell by stable cell ID. The host persists the editor after the tool completes.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                cellId: {
                    type: 'string',
                    description: 'Stable notebook cell ID.',
                },
                source: {
                    type: 'string',
                    description: 'New complete cell source.',
                },
            },
            required: ['cellId', 'source'],
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const cellId = typeof params.cellId === 'string' ? params.cellId : '';
            const source = typeof params.source === 'string' ? params.source : '';
            if (!cellId) return { success: false, error: '`cellId` is required.' };
            const updated = api.value.updateCellSource(cellId, source);
            if (!updated) return { success: false, error: `Cell "${cellId}" was not found.` };
            return {
                success: true,
                message: `Updated source for cell ${cellId}.`,
                data: { cell: api.value.getCellById(cellId) },
            };
        },
    },
    {
        name: 'jupyter.insert_cell',
        access: { kind: 'editor-write' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Insert a notebook cell into the live editor. Appends at the end by default; use afterId/beforeId to anchor to an existing cell, or position="start" for the top. The host persists the editor after the tool completes.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                cellType: {
                    type: 'string',
                    enum: ['code', 'markdown', 'raw'],
                    description: 'Cell type to insert.',
                },
                source: {
                    type: 'string',
                    description: 'Initial source for the new cell.',
                },
                afterId: {
                    type: 'string',
                    description: 'Insert after this stable cell ID.',
                },
                beforeId: {
                    type: 'string',
                    description: 'Insert before this stable cell ID.',
                },
                position: {
                    type: 'string',
                    enum: ['start', 'end'],
                    description: 'Placement when no anchor cell is given. Default "end".',
                },
            },
            required: ['cellType', 'source'],
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const cellType = normalizeCellType(params.cellType);
            if (!cellType) {
                return { success: false, error: '`cellType` must be code, markdown, or raw.' };
            }
            const source = typeof params.source === 'string' ? params.source : '';
            const inserted = api.value.insertCell({
                cellType,
                source,
                afterId: readOptionalString(params.afterId),
                beforeId: readOptionalString(params.beforeId),
                position: params.position === 'start' ? 'start' : 'end',
            });
            if (!inserted) {
                return {
                    success: false,
                    error: 'Anchor cell (afterId/beforeId) was not found. Call jupyter.list_cells for current IDs.',
                };
            }
            return {
                success: true,
                message: `Inserted ${cellType} cell ${inserted.id} at index ${inserted.index}.`,
                data: { cell: inserted },
            };
        },
    },
    {
        name: 'jupyter.delete_cell',
        access: { kind: 'editor-write' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Delete a notebook cell by stable cell ID. The host persists the editor after the tool completes.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                cellId: {
                    type: 'string',
                    description: 'Stable notebook cell ID to delete.',
                },
            },
            required: ['cellId'],
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const cellId = typeof params.cellId === 'string' ? params.cellId : '';
            if (!cellId) return { success: false, error: '`cellId` is required.' };
            const deleted = api.value.deleteCell(cellId);
            if (!deleted) return { success: false, error: `Cell "${cellId}" was not found.` };
            return {
                success: true,
                message: `Deleted cell ${cellId}.`,
                data: { cellCount: api.value.listCells().length },
            };
        },
    },
    {
        name: 'jupyter.move_cell',
        access: { kind: 'editor-write' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Move a notebook cell to a new zero-based index. The host persists the editor after the tool completes.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                cellId: {
                    type: 'string',
                    description: 'Stable notebook cell ID to move.',
                },
                toIndex: {
                    type: 'number',
                    description: 'Destination zero-based index (clamped to the notebook length).',
                },
            },
            required: ['cellId', 'toIndex'],
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const cellId = typeof params.cellId === 'string' ? params.cellId : '';
            if (!cellId) return { success: false, error: '`cellId` is required.' };
            if (typeof params.toIndex !== 'number' || !Number.isInteger(params.toIndex)) {
                return { success: false, error: '`toIndex` must be an integer.' };
            }
            const moved = api.value.moveCell(cellId, params.toIndex);
            if (!moved) return { success: false, error: `Cell "${cellId}" was not found.` };
            return {
                success: true,
                message: `Moved cell ${cellId} to index ${moved.index}.`,
                data: { cell: moved },
            };
        },
    },
    {
        name: 'jupyter.set_cell_type',
        access: { kind: 'editor-write' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Change a cell between code, markdown, and raw. NOTE: the cell is rebuilt, so it may get a NEW cell ID -- use the returned cell for follow-up edits.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                cellId: {
                    type: 'string',
                    description: 'Stable notebook cell ID to convert.',
                },
                cellType: {
                    type: 'string',
                    enum: ['code', 'markdown', 'raw'],
                    description: 'Target cell type.',
                },
            },
            required: ['cellId', 'cellType'],
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const cellId = typeof params.cellId === 'string' ? params.cellId : '';
            const cellType = normalizeCellType(params.cellType);
            if (!cellId) return { success: false, error: '`cellId` is required.' };
            if (!cellType) {
                return { success: false, error: '`cellType` must be code, markdown, or raw.' };
            }
            const converted = api.value.setCellType(cellId, cellType);
            if (!converted) return { success: false, error: `Cell "${cellId}" was not found.` };
            return {
                success: true,
                message: `Cell is now ${converted.cellType} with id ${converted.id} at index ${converted.index}.`,
                data: { cell: converted },
            };
        },
    },
    {
        name: 'jupyter.clear_outputs',
        access: { kind: 'editor-write' } as const,
        scope: 'global',
        editorFilePatterns: IPYNB_FILE_PATTERN,
        description:
            'Clear outputs and execution counts for one cell (pass cellId) or every code cell (omit cellId). The host persists the editor after the tool completes.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: FILE_PATH_PROPERTY,
                cellId: {
                    type: 'string',
                    description: 'Stable notebook cell ID. Omit to clear all code cells.',
                },
            },
        },
        handler: async (params, context) => {
            const api = requireJupyterEditorAPI(context.editorAPI);
            if (!api.ok) return api.error;
            const cellId = readOptionalString(params.cellId);
            const cleared = api.value.clearOutputs(cellId ?? undefined);
            if (cellId && cleared === 0) {
                return { success: false, error: `Cell "${cellId}" was not found or is not a code cell.` };
            }
            return {
                success: true,
                message: `Cleared outputs for ${cleared} cell(s).`,
                data: { cleared },
            };
        },
    },
];

function requireJupyterEditorAPI(editorAPI: unknown):
  | { ok: true; value: JupyterEditorAPI }
  | { ok: false; error: { success: false; error: string } } {
    const api = editorAPI as Partial<JupyterEditorAPI> | undefined;
    if (
        !api ||
        typeof api.listCells !== 'function' ||
        typeof api.getCellOutputByIndex !== 'function' ||
        typeof api.runAll !== 'function'
    ) {
        return {
            ok: false,
            error: {
                success: false,
                error:
                    'Jupyter editor API is unavailable. Open the notebook with the Jupyter custom editor, or provide a filePath so the host can mount it.',
            },
        };
    }
    return { ok: true, value: api as JupyterEditorAPI };
}

async function runIntrospection(
    api: JupyterEditorAPI,
    snippet: string,
    params: Record<string, unknown>,
    successMessage: string,
) {
    const result = await api.executeCode(snippet, {
        timeoutMs: getTimeout(params.timeoutMs, DEFAULT_EXECUTE_TIMEOUT_MS),
    });
    if (result.status === 'no-kernel') {
        return { success: false, error: 'No kernel attached to the notebook editor.' };
    }
    if (result.status === 'timeout') {
        return {
            success: false,
            error: 'Introspection timed out; the kernel may be busy. Check jupyter.get_execution_status.',
        };
    }
    const parsed = parseIntrospectionResult(result.outputs);
    if (!parsed.ok) {
        return {
            success: false,
            error: 'Introspection produced no parseable result.',
            data: { raw: parsed.raw, outputs: result.outputs.map((o) => compactOutput(o, 2000)) },
        };
    }
    if (typeof parsed.value.error === 'string') {
        return {
            success: false,
            error: parsed.value.error,
            data: parsed.value,
        };
    }
    return {
        success: true,
        message: successMessage,
        data: { kernelStatus: result.kernelStatus, ...parsed.value },
    };
}

interface SavedImageFile {
    mime: string;
    path: string;
    outputIndex: number;
}

/**
 * Decode image outputs to files via the backend module (renderer-side
 * filesystem writes are string-only, so binary goes through Node).
 * Returns saved file descriptors; failures degrade to an empty list
 * with the reason folded into the message.
 */
async function saveImageOutputs(
    cell: CellOutputSnapshot,
    context: { extensionContext: { services: { ai?: { callBackendTool?: (name: string, params: Record<string, unknown>) => Promise<unknown> } } } },
): Promise<SavedImageFile[] | { error: string }> {
    const callBackendTool = context.extensionContext.services.ai?.callBackendTool;
    if (!callBackendTool) {
        return { error: 'Image export unavailable: the Jupyter backend module bridge is not connected.' };
    }
    const files: SavedImageFile[] = [];
    for (let i = 0; i < cell.outputs.length; i++) {
        const output = cell.outputs[i];
        if (output.output_type !== 'display_data' && output.output_type !== 'execute_result') continue;
        const data = (output as { data?: nbformat.IMimeBundle }).data ?? {};
        for (const [mime, payload] of Object.entries(data)) {
            if (!mime.startsWith('image/')) continue;
            const text = typeof payload === 'string'
                ? payload
                : Array.isArray(payload)
                    ? payload.join('')
                    : null;
            if (!text) continue;
            try {
                const saved = await callBackendTool('jupyter.save_output_asset', {
                    data: text,
                    encoding: mime === 'image/svg+xml' ? 'utf8' : 'base64',
                    mime,
                    prefix: `cell-${cell.id}`,
                }) as { path?: unknown };
                if (typeof saved?.path === 'string') {
                    files.push({ mime, path: saved.path, outputIndex: i });
                }
            } catch (error) {
                return {
                    error: `Image export failed: ${error instanceof Error ? error.message : String(error)}`,
                };
            }
        }
    }
    return files;
}

function buildOutputMessage(
    cell: CellOutputSnapshot,
    imageFiles: SavedImageFile[] | { error: string } | undefined,
): string {
    const base = `Read output for cell ${cell.index} (${cell.id}).`;
    if (imageFiles == null) {
        return hasImageOutput(cell)
            ? `${base} Cell has image output; pass includeImages=true to save it to a file you can Read.`
            : base;
    }
    if ('error' in imageFiles) return `${base} ${imageFiles.error}`;
    if (imageFiles.length === 0) return `${base} No image outputs found.`;
    return `${base} Saved ${imageFiles.length} image(s) to disk; Read the returned paths to view them.`;
}

function hasImageOutput(cell: CellOutputSnapshot): boolean {
    return cell.outputs.some((output) => {
        if (output.output_type !== 'display_data' && output.output_type !== 'execute_result') {
            return false;
        }
        const data = (output as { data?: nbformat.IMimeBundle }).data ?? {};
        return Object.keys(data).some((mime) => mime.startsWith('image/'));
    });
}

function getCellOutput(api: JupyterEditorAPI, params: Record<string, unknown>): CellOutputSnapshot | null {
    if (typeof params.cellId === 'string' && params.cellId.length > 0) {
        return api.getCellOutputById(params.cellId);
    }
    if (typeof params.index === 'number' && Number.isInteger(params.index)) {
        return api.getCellOutputByIndex(params.index);
    }
    return null;
}

async function runCell(api: JupyterEditorAPI, params: Record<string, unknown>) {
    const opts = { timeoutMs: getTimeout(params.timeoutMs, DEFAULT_RUN_TIMEOUT_MS) };
    if (typeof params.cellId === 'string' && params.cellId.length > 0) {
        return api.runCellById(params.cellId, opts);
    }
    if (typeof params.index === 'number' && Number.isInteger(params.index)) {
        return api.runCellByIndex(params.index, opts);
    }
    return null;
}

function missingCellResult(params: Record<string, unknown>) {
    const ref = typeof params.cellId === 'string' && params.cellId.length > 0
        ? `cellId "${params.cellId}"`
        : typeof params.index === 'number'
            ? `index ${params.index}`
            : 'the requested cell';
    return {
        success: false,
        error: `Could not find ${ref}. Pass a stable cellId from jupyter.list_cells or a zero-based index.`,
    };
}

function normalizeCellType(value: unknown): CellType | null {
    return value === 'code' || value === 'markdown' || value === 'raw' ? value : null;
}

function readOptionalString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function getTimeout(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
    return Math.min(Math.floor(value), 600_000);
}

function getMaxChars(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_OUTPUT_CHAR_LIMIT;
    return Math.max(100, Math.min(Math.floor(value), MAX_OUTPUT_CHAR_LIMIT));
}

function compactOutputSnapshot(snapshot: CellOutputSnapshot, maxChars: number) {
    return {
        id: snapshot.id,
        index: snapshot.index,
        executionCount: snapshot.executionCount,
        outputs: snapshot.outputs.map((output) => compactOutput(output, maxChars)),
    };
}

function compactOutput(output: nbformat.IOutput, maxChars: number) {
    switch (output.output_type) {
        case 'stream':
            return {
                outputType: output.output_type,
                name: output.name,
                text: truncateNotebookText((output as { text?: unknown }).text, maxChars),
            };
        case 'error':
            const traceback = (output as { traceback?: unknown }).traceback;
            return {
                outputType: output.output_type,
                ename: output.ename,
                evalue: output.evalue,
                traceback: Array.isArray(traceback)
                    ? traceback.map((line) => truncateString(String(line), maxChars))
                    : undefined,
            };
        case 'display_data':
        case 'execute_result':
            return {
                outputType: output.output_type,
                executionCount: 'execution_count' in output ? output.execution_count : undefined,
                data: compactMimeBundle((output as { data?: nbformat.IMimeBundle }).data ?? {}, maxChars),
                metadata: output.metadata,
            };
        default:
            return output;
    }
}

function compactMimeBundle(data: nbformat.IMimeBundle, maxChars: number) {
    return Object.fromEntries(
        Object.entries(data).map(([mime, payload]) => [
            mime,
            // Base64 image payloads are worthless to a text model; keep a
            // stub and steer to includeImages instead of burning maxChars.
            mime.startsWith('image/') && mime !== 'image/svg+xml'
                ? truncatePayload(payload, Math.min(maxChars, 200))
                : truncatePayload(payload, maxChars),
        ]),
    );
}

function truncatePayload(payload: unknown, maxChars: number): unknown {
    if (typeof payload === 'string') return truncateString(payload, maxChars);
    if (Array.isArray(payload)) {
        return payload.map((item) =>
            typeof item === 'string' ? truncateString(item, maxChars) : item,
        );
    }
    return payload;
}

function truncateNotebookText(text: unknown, maxChars: number): string {
    return truncateString(Array.isArray(text) ? text.join('') : String(text ?? ''), maxChars);
}

function truncateString(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}
