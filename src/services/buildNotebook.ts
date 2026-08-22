/**
 * Build a JupyterLab `Notebook` widget plus its model, rendermime, and
 * CodeMirror-backed content factory. The widget is mounted bare (no
 * `NotebookPanel`) and the kernel-bound `SessionContext` is attached
 * separately by the kernel-execution phase.
 */

import { Notebook, NotebookModel, StaticNotebook } from '@jupyterlab/notebook';
import { Cell } from '@jupyterlab/cells';
import { RenderMimeRegistry, standardRendererFactories } from '@jupyterlab/rendermime';
import {
  CodeMirrorEditorFactory,
  CodeMirrorMimeTypeService,
  EditorExtensionRegistry,
  EditorLanguageRegistry,
  ybinding,
} from '@jupyterlab/codemirror';
import type * as nbformat from '@jupyterlab/nbformat';

export { parseNotebook, serializeNotebook } from './notebookSerializer';

export interface BuiltNotebook {
  notebook: Notebook;
  model: NotebookModel;
  rendermime: RenderMimeRegistry;
  dispose: () => void;
}

interface BuildOptions {
  readOnly: boolean;
}

let cachedFactories: {
  contentFactory: Notebook.IContentFactory;
  mimeTypeService: CodeMirrorMimeTypeService;
} | null = null;

function getSharedFactories() {
  if (cachedFactories) return cachedFactories;

  const languages = new EditorLanguageRegistry();
  for (const lang of EditorLanguageRegistry.getDefaultLanguages()) {
    languages.addLanguage(lang);
  }

  const extensions = new EditorExtensionRegistry();
  for (const ext of EditorExtensionRegistry.getDefaultExtensions()) {
    extensions.addExtension(ext);
  }
  extensions.addExtension({
    name: 'binding',
    factory: ({ model }) =>
      EditorExtensionRegistry.createImmutableExtension(
        ybinding({
          ytext: (model.sharedModel as unknown as { ysource: import('yjs').Text }).ysource,
          undoManager:
            (model.sharedModel as unknown as { undoManager?: import('yjs').UndoManager }).undoManager,
        }),
      ),
  });

  const factoryService = new CodeMirrorEditorFactory({ languages, extensions });
  const editorFactory = factoryService.newInlineEditor.bind(factoryService);
  const mimeTypeService = new CodeMirrorMimeTypeService(languages);

  const contentFactory = new Notebook.ContentFactory({
    editorFactory: editorFactory as Cell.ContentFactory.IOptions['editorFactory'],
  });

  cachedFactories = { contentFactory, mimeTypeService };
  return cachedFactories;
}

export function buildNotebook(
  content: nbformat.INotebookContent,
  { readOnly }: BuildOptions,
): BuiltNotebook {
  const { contentFactory, mimeTypeService } = getSharedFactories();
  // Widget renderers are bound to a specific kernel, so each notebook needs
  // its own registry even though the heavier editor factories remain shared.
  const rendermime = new RenderMimeRegistry({ initialFactories: standardRendererFactories });

  const model = new NotebookModel();
  model.fromJSON(content);
  model.readOnly = readOnly;

  const notebook = new Notebook({
    rendermime,
    contentFactory,
    mimeTypeService,
    notebookConfig: {
      ...StaticNotebook.defaultNotebookConfig,
      windowingMode: 'defer',
    },
  });
  notebook.model = model;

  return {
    notebook,
    model,
    rendermime,
    dispose: () => {
      try {
        notebook.dispose();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/Widget is not attached/i.test(message)) {
          throw error;
        }
      } finally {
        model.dispose();
      }
    },
  };
}
