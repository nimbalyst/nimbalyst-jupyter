/**
 * Notebook Projection
 *
 * Parses a raw `.ipynb` JSON string into a compact text representation
 * suitable for AI active-file context. Cell sources are preserved
 * verbatim; outputs are replaced with short MIME-aware placeholders so
 * stdout dumps, base64 images, and large JSON payloads don't burn the
 * agent's token budget.
 *
 * Intended caller: the upcoming notebook custom editor (slice 2 of the
 * Jupyter plan), which will inject the projection into its own
 * `documentContext` payload. There is no host-level AI context
 * contribution point -- this function is just an internal helper.
 */

/**
 * Subset of the nbformat v4 cell shape we actually read. Unknown fields
 * are ignored; missing optional fields are tolerated. Defined inline
 * (no external nbformat dependency) so this stays self-contained.
 */
interface RawNotebookCell {
  cell_type?: string;
  source?: string | string[];
  id?: string;
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
  outputs?: RawNotebookOutput[];
}

interface RawNotebookOutput {
  output_type?: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface RawNotebook {
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: {
    kernelspec?: {
      name?: string;
      display_name?: string;
      language?: string;
    };
    language_info?: {
      name?: string;
      version?: string;
    };
  };
  cells?: RawNotebookCell[];
}

export interface NotebookProjectionResult {
  /** Projected text suitable for direct prompt injection. */
  content: string;
  /** Number of cells in the notebook (0 when parse failed). */
  cellCount: number;
  /** Bytes of raw input. */
  sourceBytes: number;
  /** Bytes of the projected output. */
  projectedBytes: number;
  /** True if any output was replaced with a placeholder. */
  outputsRedacted: boolean;
  /** Parse failure message, if any. The projection still returns a usable string. */
  parseError?: string;
}

/**
 * Build a compact projection of a notebook JSON string.
 *
 * Failure modes:
 * - Invalid JSON: returns a short marker plus `parseError`. Callers can
 *   detect this and choose to fall back to raw content; the projection
 *   is still safe to inject.
 * - Missing `cells` array: returns a header with "No cells" and no error.
 */
export function buildNotebookProjection(rawIpynbJson: string): NotebookProjectionResult {
  const sourceBytes = rawIpynbJson.length;

  let parsed: RawNotebook;
  try {
    parsed = JSON.parse(rawIpynbJson) as RawNotebook;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const content = `# Notebook (unparseable)\n${message}\n\nRaw size: ${sourceBytes} bytes\n`;
    return {
      content,
      cellCount: 0,
      sourceBytes,
      projectedBytes: content.length,
      outputsRedacted: false,
      parseError: message,
    };
  }

  const cells = Array.isArray(parsed.cells) ? parsed.cells : [];
  const lines: string[] = [];
  const kernel = parsed.metadata?.kernelspec;
  const language = parsed.metadata?.language_info;

  lines.push('# Notebook (projected for AI context)');
  lines.push('');
  lines.push(`nbformat: ${parsed.nbformat ?? '?'}.${parsed.nbformat_minor ?? '?'}`);
  if (kernel?.display_name || kernel?.name) {
    lines.push(`kernel: ${kernel.display_name ?? kernel.name ?? ''}${kernel.name && kernel.display_name ? ` (${kernel.name})` : ''}`);
  }
  if (language?.name) {
    lines.push(`language: ${language.name}${language.version ? ` ${language.version}` : ''}`);
  }
  lines.push(`cells: ${cells.length}`);
  lines.push('');
  lines.push(
    'Outputs are summarized -- request a specific cell output via the notebook tools to see full output.'
  );
  lines.push('');

  let outputsRedacted = false;

  if (cells.length === 0) {
    lines.push('No cells.');
  } else {
    cells.forEach((cell, index) => {
      const oneBasedIndex = index + 1;
      const cellId = typeof cell.id === 'string' && cell.id.length > 0 ? cell.id : `cell-${oneBasedIndex}`;
      const type = typeof cell.cell_type === 'string' ? cell.cell_type : 'unknown';
      const execLabel = cell.execution_count != null ? ` exec=${cell.execution_count}` : '';
      lines.push(`## Cell ${oneBasedIndex} [${type}] [id=${cellId}]${execLabel}`);

      const source = normalizeSource(cell.source);
      if (source.length === 0) {
        lines.push('(empty source)');
      } else {
        lines.push(source);
      }

      const outputSummaries = summarizeOutputs(cell.outputs);
      if (outputSummaries.length > 0) {
        outputsRedacted = true;
        lines.push('');
        lines.push(`Outputs: ${outputSummaries.join(', ')}`);
      }
      lines.push('');
    });
  }

  const content = lines.join('\n');
  return {
    content,
    cellCount: cells.length,
    sourceBytes,
    projectedBytes: content.length,
    outputsRedacted,
  };
}

/**
 * nbformat stores source as either a single string or an array of strings
 * (one per line, newlines included). Collapse both into a plain string.
 */
function normalizeSource(source: RawNotebookCell['source']): string {
  if (typeof source === 'string') {
    return source;
  }
  if (Array.isArray(source)) {
    return source.join('');
  }
  return '';
}

/**
 * Build a compact list of human-readable output summaries for a cell.
 * Each entry names the MIME type (or stream name) and the size of the
 * payload that was hidden. Empty arrays produce no entries.
 */
function summarizeOutputs(outputs: RawNotebookCell['outputs']): string[] {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    return [];
  }

  const summaries: string[] = [];
  for (const output of outputs) {
    const type = typeof output.output_type === 'string' ? output.output_type : 'unknown';
    switch (type) {
      case 'stream': {
        const text = normalizeSource(output.text);
        const lineCount = text.length === 0 ? 0 : text.split('\n').length;
        const streamName = typeof output.name === 'string' ? output.name : 'stream';
        summaries.push(`[${streamName} hidden: ${lineCount} lines, ${text.length} bytes]`);
        break;
      }
      case 'error': {
        const ename = typeof output.ename === 'string' ? output.ename : 'Error';
        const evalue = typeof output.evalue === 'string' ? output.evalue : '';
        // Keep error name + value (short, useful to the agent); hide
        // traceback bulk since it's frequently huge.
        const traceback = Array.isArray(output.traceback) ? output.traceback : [];
        const tbLines = traceback.length;
        summaries.push(`[${ename}: ${truncate(evalue, 120)} | traceback hidden: ${tbLines} frames]`);
        break;
      }
      case 'display_data':
      case 'execute_result': {
        const data = output.data ?? {};
        const entries = Object.entries(data);
        if (entries.length === 0) {
          summaries.push(`[${type} hidden: no data]`);
          break;
        }
        for (const [mime, payload] of entries) {
          summaries.push(`[${mime} hidden: ${describePayload(payload)}]`);
        }
        break;
      }
      default:
        summaries.push(`[${type} hidden]`);
    }
  }
  return summaries;
}

function describePayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return `${payload.length} chars`;
  }
  if (Array.isArray(payload)) {
    const joined = payload.join('');
    return `${joined.length} chars`;
  }
  // Objects: serialize to estimate size without leaking content.
  try {
    const serialized = JSON.stringify(payload);
    return `${serialized.length} chars (json)`;
  } catch {
    return 'unknown size';
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
