/**
 * Nimbalyst Jupyter extension entry point.
 *
 * Ships a `.ipynb` custom editor backed by `@jupyterlab/notebook`. The
 * SessionContext + kernel wiring (cell execution, ipywidgets,
 * completer, kernel picker) is added in the kernel-execution phase;
 * this entry point exposes the renderer surface that phase will hook
 * into.
 */

import { aiTools as jupyterAiTools } from './aiTools';
import { JupyterNotebookEditor } from './components/JupyterNotebookEditor';

export { buildNotebookProjection } from './services/notebookProjection';
export type { NotebookProjectionResult } from './services/notebookProjection';

export const aiTools = jupyterAiTools;

export const components = {
  JupyterNotebookEditor,
};

export async function activate(): Promise<void> {
  // Declarative wiring via manifest.contributions.customEditors.
}

export async function deactivate(): Promise<void> {
  // No teardown required.
}
