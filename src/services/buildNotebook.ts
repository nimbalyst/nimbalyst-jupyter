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
  dispose: () => void;
}

interface BuildOptions {
  readOnly: boolean;
}

let cachedFactories: {
  contentFactory: Notebook.IContentFactory;
  mimeTypeService: CodeMirrorMimeTypeService;
  rendermime: RenderMimeRegistry;
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

  const rendermime = new RenderMimeRegistry({
    initialFactories: standardRendererFactories,
  });

  cachedFactories = { contentFactory, mimeTypeService, rendermime };
  return cachedFactories;
}

export function buildNotebook(
  content: nbformat.INotebookContent,
  { readOnly }: BuildOptions,
): BuiltNotebook {
  const { contentFactory, mimeTypeService, rendermime } = getSharedFactories();

  const model = new NotebookModel();
  model.fromJSON(content);
  model.readOnly = readOnly;

  const notebook = new Notebook({
    rendermime,
    contentFactory,
    mimeTypeService,
    notebookConfig: {
      ...StaticNotebook.defaultNotebookConfig,
      windowingMode: 'none',
    },
  });
  notebook.model = model;

  return {
    notebook,
    model,
    dispose: () => {
      notebook.dispose();
      model.dispose();
    },
  };
}
