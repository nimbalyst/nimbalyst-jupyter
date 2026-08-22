/**
 * Nimbalyst Jupyter extension entry point.
 *
 * Ships a `.ipynb` custom editor backed by `@jupyterlab/notebook`. The
 * The renderer composes a bare JupyterLab Notebook with a managed local
 * SessionContext, kernel picker, ipywidgets, and kernel-backed assistance.
 */

import { aiTools as jupyterAiTools } from './aiTools';
import { JupyterNotebookEditor } from './components/JupyterNotebookEditor';
import { setExtensionContext } from './extensionContext';
import { NotebookCollabCodec } from './services/notebookCollaboration';
import type { ExtensionContext } from '@nimbalyst/extension-sdk';

export { JupyterNotebookEditor };
export { NotebookCollabCodec };

export { buildNotebookProjection } from './services/notebookProjection';
export type { NotebookProjectionResult } from './services/notebookProjection';

export const aiTools = jupyterAiTools;

export const components = {
  JupyterNotebookEditor,
};

export async function activate(context: ExtensionContext): Promise<void> {
  setExtensionContext(context);
  context.services.collab.registerContentAdapter(NotebookCollabCodec);
  // Declarative wiring via manifest.contributions.customEditors.
}

export async function deactivate(): Promise<void> {
  setExtensionContext(null);
}
