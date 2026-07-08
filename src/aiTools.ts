import type { ExtensionAITool } from '@nimbalyst/extension-sdk';
import { buildNotebookProjection } from './services/notebookProjection';

export const aiTools: ExtensionAITool[] = [
    {
        name: 'jupyter.get_notebook_projection',
        access: { kind: 'filesystem' } as const,
        description:
            'Read a Jupyter `.ipynb` notebook and return a compact projection: cell sources preserved verbatim, outputs replaced with short MIME-aware placeholders (e.g. `[stdout hidden: 12 lines]`, `[image/png hidden: 142 chars]`). ALWAYS prefer this over the generic `Read` tool when working with `.ipynb` files -- the raw notebook JSON is dominated by output blobs (base64 images, JSON dumps, long stdout) that waste tokens and rarely matter for code reasoning. To see a specific cell output in full, request it explicitly through the upcoming cell-output tools; this projection is the default view.',
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
];
