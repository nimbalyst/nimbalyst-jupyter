import type * as nbformat from '@jupyterlab/nbformat';

export interface NotebookCellContextSnapshot {
  id: string;
  index: number;
  type: 'code' | 'markdown' | 'raw';
  source: string;
  executionCount?: number | null;
  outputCount?: number;
  outputPreview?: string;
}

export interface NotebookSelectionContextItem {
  id: string;
  label: string;
  description: string;
  icon: string;
  groupLabel: string;
  data?: unknown;
  includeData?: true;
}

export const MAX_NOTEBOOK_CONTEXT_CELLS = 24;
const SOURCE_LIMIT = 640;
const OUTPUT_LIMIT = 480;
const NOTEBOOK_LABEL_LIMIT = 120;

function bounded(value: unknown, limit: number): string {
  const normalized = String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
    .trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 14))}… [truncated]`;
}

function cellIcon(type: NotebookCellContextSnapshot['type']): string {
  if (type === 'code') return 'code';
  if (type === 'markdown') return 'markdown';
  return 'text_snippet';
}

function cellTypeLabel(type: NotebookCellContextSnapshot['type']): string {
  return `${type[0].toUpperCase()}${type.slice(1)}`;
}

function notebookLabel(notebookPath: string): string {
  const normalized = bounded(notebookPath, 600);
  return bounded(normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized, NOTEBOOK_LABEL_LIMIT)
    || 'notebook';
}

export function buildNotebookOutputPreview(outputs: nbformat.IOutput[]): string {
  const previews = outputs.slice(0, 6).map((output) => {
    if (output.output_type === 'stream' && 'text' in output) {
      return multilineText(output.text as nbformat.MultilineString);
    }
    if (output.output_type === 'error' && 'ename' in output && 'evalue' in output) {
      return `${String(output.ename)}: ${String(output.evalue)}`;
    }
    if (
      (output.output_type === 'execute_result' || output.output_type === 'display_data')
      && 'data' in output
    ) {
      const data = output.data as nbformat.IMimeBundle;
      const plainText = data['text/plain'];
      if (plainText !== undefined) return multilineText(plainText as nbformat.MultilineString);
      const markdown = data['text/markdown'];
      if (markdown !== undefined) return multilineText(markdown as nbformat.MultilineString);
      const json = data['application/json'];
      if (json !== undefined) {
        try {
          return JSON.stringify(json);
        } catch {
          return '[application/json output omitted]';
        }
      }
      const mimeTypes = Object.keys(data).slice(0, 6);
      return mimeTypes.length ? `[${mimeTypes.join(', ')} output omitted]` : '[display output]';
    }
    return `[${output.output_type || 'unknown'} output]`;
  }).filter(Boolean);
  const omitted = outputs.length - Math.min(outputs.length, 6);
  if (omitted > 0) previews.push(`[${omitted} additional outputs omitted]`);
  return bounded(previews.join('\n'), OUTPUT_LIMIT);
}

function multilineText(value: unknown): string {
  if (Array.isArray(value)) return value.map(multilineText).join('');
  return typeof value === 'string' ? value : String(value ?? '');
}

export function buildNotebookSelectionContextItems(
  cells: NotebookCellContextSnapshot[],
  notebookPath: string,
): NotebookSelectionContextItem[] {
  const visible = cells.slice(0, MAX_NOTEBOOK_CONTEXT_CELLS);
  const groupLabel = notebookLabel(notebookPath);
  const items: NotebookSelectionContextItem[] = visible.map((cell) => {
    const source = bounded(cell.source, SOURCE_LIMIT);
    const outputPreview = bounded(cell.outputPreview, OUTPUT_LIMIT);
    const index = Number.isInteger(cell.index) && cell.index >= 0 ? cell.index : 0;
    const outputCount = Number.isInteger(cell.outputCount) && (cell.outputCount ?? 0) >= 0
      ? cell.outputCount ?? 0
      : 0;
    return {
      id: `cell:${bounded(cell.id, 480)}`,
      label: `${cellTypeLabel(cell.type)} cell ${index + 1}`,
      description: [
        `Selected ${cell.type} cell ${index + 1} (id ${bounded(cell.id, 240)}) in notebook "${groupLabel}".`,
        cell.type === 'code' ? `Execution count: ${cell.executionCount ?? 'not run'}; outputs: ${outputCount}.` : '',
        `Source preview:\n${source || '(empty cell)'}`,
        cell.type === 'code' ? `Output preview:\n${outputPreview || '(no text output)'}` : '',
      ].filter(Boolean).join(' '),
      icon: cellIcon(cell.type),
      groupLabel,
      data: {
        cellId: bounded(cell.id, 240),
        index,
        type: cell.type,
        source,
        ...(cell.type === 'code'
          ? {
              executionCount: cell.executionCount ?? null,
              outputCount,
              outputPreview,
            }
          : {}),
      },
      includeData: true as const,
    };
  });
  const omitted = cells.length - visible.length;
  if (omitted > 0) {
    items.push({
      id: `cells:omitted:${omitted}`,
      label: `${omitted} more ${omitted === 1 ? 'cell' : 'cells'}`,
      description: `${omitted} additional selected notebook ${omitted === 1 ? 'cell was' : 'cells were'} omitted from editor context to keep the prompt bounded. Inspect the live notebook before applying a bulk change.`,
      icon: 'more_horiz',
      groupLabel,
    });
  }
  return items;
}
