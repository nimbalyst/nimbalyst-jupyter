    /**
 * Custom editor for `.ipynb` files.
 *
 * Mounts the JupyterLab `Notebook` widget (Lumino) inside a React tree
 * and attaches a `SessionContextManager` so cells actually execute
 * against a Jupyter kernel. In v1 the kernel comes from a localhost
 * `jupyter_server`, preferably spawned by the extension backend module and
 * falling back to the dev-only `window.__NIMBALYST_JUPYTER_DEV_SERVER__` hook.
 *
 * If no server config is found, the editor still renders (edit-only
 * mode) and the kernel toolbar reports "No kernel". This lets users
 * see and edit notebooks without a running Jupyter server.
 */

import { forwardRef, useEffect, useRef, useState } from 'react';
import { Widget } from '@lumino/widgets';
import { NotebookActions, type Notebook, type NotebookModel } from '@jupyterlab/notebook';
import type { ServiceManager } from '@jupyterlab/services';
import {
  useCollaborativeEditor,
  useEditorLifecycle,
  type EditorHostProps,
} from '@nimbalyst/extension-sdk';
import type * as nbformat from '@jupyterlab/nbformat';

import { buildNotebook, parseNotebook, serializeNotebook } from '../services/buildNotebook';
import { applyTheme } from '../services/theme';
import { createEditorAPI } from '../editorApi';
import {
  createLocalServiceManager,
  heartbeatServerLease,
  releaseServerLease,
  resolveServerConfig,
  toJupyterSessionPath,
} from '../services/serviceManagers';
import { SessionContextManager } from '../services/sessionContext';
import { StalenessTracker } from '../services/stalenessTracker';
import { IpywidgetsIntegration } from '../widgets/ipywidgets';
import { KernelCodeAssistance } from '../services/completer';
import { NotebookToolbar } from './NotebookToolbar';
import { CellChrome } from './CellToolbar';
import { useConfirm } from './ConfirmDialog';
import { attachKernelShortcuts } from '../services/notebookShortcuts';
import { RuntimeSetupPanel } from './RuntimeSetupPanel';
import {
  clearSelectedOutputs,
  duplicateCells,
  insertCell,
  mergeCells,
  splitActiveCell,
  toggleSelectedInputs,
  toggleSelectedOutputs,
  toggleSelectedOutputScrolling,
  selectedCells,
} from '../services/notebookCellActions';
import type { RenderMimeRegistry } from '@jupyterlab/rendermime';
import {
  buildNotebookSelectionContextItems,
  buildNotebookOutputPreview,
  type NotebookCellContextSnapshot,
  type NotebookSelectionContextItem,
} from '../services/selectionContext';
import { NotebookCollabCodec } from '../services/notebookCollaboration';
import { NotebookCollabBinding } from '../services/notebookCollabBinding';

import '@jupyterlab/notebook/style/index.js';
import '@jupyterlab/completer/style/index.js';
import '@jupyterlab/theme-light-extension/style/variables.css';
import '@jupyterlab/theme-light-extension/style/theme.css';
import './JupyterNotebookEditor.css';

interface BuiltNotebookRef {
  notebook: Notebook;
  model: NotebookModel;
  rendermime: RenderMimeRegistry;
  dispose: () => void;
}

// @nimbalyst/extension-sdk 0.3.0 contains this method, but is not published yet.
// Keep this structural bridge local so runtime adoption does not fall back to the
// legacy single-item context shim while the external package remains on 0.2.1.
interface EditorContextItemsHost {
  setEditorContextItems(items: NotebookSelectionContextItem[] | null): void;
}

export const JupyterNotebookEditor = forwardRef<unknown, EditorHostProps>(
  function JupyterNotebookEditor({ host }, _ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const builtRef = useRef<BuiltNotebookRef | null>(null);
    const notebookReadyResolversRef = useRef<Array<(built: BuiltNotebookRef) => void>>([]);
    const attachedRef = useRef(false);
    const serviceManagerRef = useRef<ServiceManager.IManager | null>(null);
    const sessionContextRef = useRef<SessionContextManager | null>(null);
    const stalenessTrackerRef = useRef<StalenessTracker | null>(null);
    const widgetsRef = useRef<IpywidgetsIntegration | null>(null);
    const codeAssistanceRef = useRef<KernelCodeAssistance | null>(null);
    const kernelAttemptRef = useRef(0);
    const serverLeaseRef = useRef<string | null>(null);
    const leaseHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [sessionContext, setSessionContext] = useState<SessionContextManager | null>(null);
    const [kernelError, setKernelError] = useState<string | null>(null);
    const [showRuntimeSetup, setShowRuntimeSetup] = useState(false);
    const [runtimeDescription, setRuntimeDescription] = useState('No runtime connected');
    const [selectionNotebook, setSelectionNotebook] = useState<Notebook | null>(null);
    const [readOnly, setReadOnly] = useState(host.readOnly === true);
    // Mirrors `stalenessTrackerRef` as state: the cell gutter renders freshness,
    // and a ref alone never re-renders it into existence.
    const [stalenessTracker, setStalenessTracker] = useState<StalenessTracker | null>(null);
    // Declared ahead of the lifecycle hook: `applyContent` runs synchronously
    // during it and wires `requestConfirm` into the key handler.
    const { requestConfirm, confirmDialog } = useConfirm();

    const { isLoading, error, theme } = useEditorLifecycle<nbformat.INotebookContent>(host, {
      parse: parseNotebook,
      serialize: serializeNotebook,

      applyContent: (content) => {
        const container = containerRef.current;
        if (!container) return;

        if (!builtRef.current) {
          const built = buildNotebook(
            host.collaboration ? parseNotebook('') : content,
            { readOnly: host.readOnly === true },
          );
          built.model.contentChanged.connect(handleModelContentChanged);
          builtRef.current = built;
          for (const resolve of notebookReadyResolversRef.current.splice(0)) resolve(built);
          setSelectionNotebook(built.notebook);
          Widget.attach(built.notebook, container);
          attachedRef.current = true;
          if (rootRef.current) {
            applyTheme(rootRef.current, host.theme);
          }
          stalenessTrackerRef.current = new StalenessTracker(built.notebook);
          setStalenessTracker(stalenessTrackerRef.current);
          host.registerEditorAPI(
            createEditorAPI(
              built.notebook,
              built.model,
              () => sessionContextRef.current,
              stalenessTrackerRef.current,
              () => host.readOnly === true,
            ),
          );
          attachKernelShortcuts(built.notebook, {
            getSessionContext: () => sessionContextRef.current,
            isReadOnly: () => host.readOnly === true,
            onError: setKernelError,
            requestConfirm,
          });
          // Kick off kernel attach now that we have a notebook to bind to.
          void initializeKernel(host.filePath ?? 'untitled.ipynb');
          return;
        }

        if (!host.collaboration) builtRef.current.model.fromJSON(content);
      },

      getCurrentContent: () => {
        if (!builtRef.current) {
          throw new Error('Notebook not initialized');
        }
        return builtRef.current.model.toJSON();
      },
    });

    function handleModelContentChanged() {
      if (!host.collaboration) host.setDirty(true);
    }

    const awaitBuiltNotebook = (): Promise<BuiltNotebookRef> => {
      if (builtRef.current) return Promise.resolve(builtRef.current);
      return new Promise((resolve) => notebookReadyResolversRef.current.push(resolve));
    };

    useCollaborativeEditor(host, {
      codec: NotebookCollabCodec,
      bind: async ({ yDoc }) => {
        const built = await awaitBuiltNotebook();
        const binding = new NotebookCollabBinding(yDoc, built.model);
        return { destroy: () => binding.destroy() };
      },
    });

    async function initializeKernel(path: string) {
      const attempt = ++kernelAttemptRef.current;
      await releaseManagedLease();
      widgetsRef.current?.dispose();
      widgetsRef.current = null;
      const previousSession = sessionContextRef.current;
      sessionContextRef.current = null;
      const previousServiceManager = serviceManagerRef.current;
      serviceManagerRef.current = null;
      if (previousSession) {
        await previousSession.disposeAsync().catch(() => undefined);
      }
      previousServiceManager?.dispose();
      setSessionContext(null);
      setKernelError(null);
      const { config, source, error: serverConfigError, leaseId } = await resolveServerConfig();
      if (attempt !== kernelAttemptRef.current) {
        if (leaseId) await releaseServerLease(leaseId).catch(() => undefined);
        return;
      }
      if (!config) {
        setRuntimeDescription('No runtime connected');
        setKernelError(serverConfigError ?? 'No Jupyter server configured.');
        return;
      }
      setRuntimeDescription([
        source === 'managed' ? 'Managed local server' : source === 'manual' ? 'Manual local server' : 'Developer server',
        config.pythonPath,
        config.rootDir ? `root ${config.rootDir}` : 'server root unknown',
      ].filter(Boolean).join(' · '));
      if (leaseId) holdManagedLease(leaseId);
      try {
        const sm = createLocalServiceManager(config);
        serviceManagerRef.current = sm;
        await sm.ready;
        const sessionPath = toJupyterSessionPath(path, config.rootDir);
        const sc = new SessionContextManager({ serviceManager: sm, path: sessionPath });
        sessionContextRef.current = sc;
        sc.statusChanged.connect((_sender, status) => {
          stalenessTrackerRef.current?.onKernelStatus(status);
        });
        await sc.initialize();
        if (attempt !== kernelAttemptRef.current) {
          await sc.disposeAsync().catch(() => undefined);
          sm.dispose();
          return;
        }
        if (builtRef.current) {
          widgetsRef.current = new IpywidgetsIntegration(
            sc.sessionContext,
            builtRef.current.rendermime,
          );
          if (codeAssistanceRef.current) {
            codeAssistanceRef.current.updateSessionContext(sc.sessionContext);
          } else {
            codeAssistanceRef.current = new KernelCodeAssistance(
              builtRef.current.notebook,
              sc.sessionContext,
              builtRef.current.rendermime,
            );
          }
        }
        setSessionContext(sc);
      } catch (err) {
        if (attempt !== kernelAttemptRef.current) return;
        await sessionContextRef.current?.disposeAsync().catch(() => undefined);
        sessionContextRef.current = null;
        serviceManagerRef.current?.dispose();
        serviceManagerRef.current = null;
        await releaseManagedLease();
        setKernelError(err instanceof Error ? err.message : String(err));
      }
    }

    function holdManagedLease(leaseId: string) {
      serverLeaseRef.current = leaseId;
      leaseHeartbeatRef.current = setInterval(() => {
        void heartbeatServerLease(leaseId)
          .then((active) => {
            if (!active && serverLeaseRef.current === leaseId) {
              setKernelError('The managed Jupyter server stopped. Reconnect to start it again.');
            }
          })
          .catch((caught) => {
            if (serverLeaseRef.current === leaseId) {
              setKernelError(`Could not renew the Jupyter server lease: ${messageOf(caught)}`);
            }
          });
      }, 60_000);
    }

    async function releaseManagedLease() {
      if (leaseHeartbeatRef.current) {
        clearInterval(leaseHeartbeatRef.current);
        leaseHeartbeatRef.current = null;
      }
      const leaseId = serverLeaseRef.current;
      serverLeaseRef.current = null;
      if (leaseId) await releaseServerLease(leaseId).catch(() => undefined);
    }

    useEffect(() => {
      if (rootRef.current) {
        applyTheme(rootRef.current, theme);
      }
    }, [theme]);

    useEffect(() => {
      if (!selectionNotebook) return;
      const contextHost = host as typeof host & EditorContextItemsHost;
      const publish = () => {
        const snapshots: NotebookCellContextSnapshot[] = selectedCells(selectionNotebook).map((cell) => {
          const json = cell.model.toJSON() as nbformat.ICell;
          const source = Array.isArray(json.source) ? json.source.join('') : String(json.source ?? '');
          const codeJson = json.cell_type === 'code' ? json as nbformat.ICodeCell : null;
          return {
            id: cell.model.id,
            index: selectionNotebook.widgets.indexOf(cell),
            type: cell.model.type as NotebookCellContextSnapshot['type'],
            source,
            ...(codeJson
              ? {
                  executionCount: typeof codeJson.execution_count === 'number' ? codeJson.execution_count : null,
                  outputCount: Array.isArray(codeJson.outputs) ? codeJson.outputs.length : 0,
                  outputPreview: buildNotebookOutputPreview(codeJson.outputs),
                }
              : {}),
          };
        });
        const items = buildNotebookSelectionContextItems(snapshots, host.filePath ?? host.fileName);
        contextHost.setEditorContextItems(items.length ? items : null);
      };
      publish();
      selectionNotebook.activeCellChanged.connect(publish);
      selectionNotebook.selectionChanged.connect(publish);
      selectionNotebook.model?.contentChanged.connect(publish);
      return () => {
        selectionNotebook.activeCellChanged.disconnect(publish);
        selectionNotebook.selectionChanged.disconnect(publish);
        selectionNotebook.model?.contentChanged.disconnect(publish);
      };
    }, [host, selectionNotebook]);

    useEffect(() => () => {
      (host as typeof host & EditorContextItemsHost).setEditorContextItems(null);
    }, [host]);

    // React state, not just the model: an embed can flip between view and edit
    // mode without remounting, and the chrome only unmounts if a render follows.
    useEffect(() => host.onReadOnlyChanged?.((nextReadOnly) => {
      setReadOnly(nextReadOnly);
      if (builtRef.current) builtRef.current.model.readOnly = nextReadOnly;
    }), [host]);

    useEffect(() => {
      const withNotebook = (action: (notebook: Notebook) => void, mutates = true) => () => {
        const notebook = builtRef.current?.notebook;
        if (!notebook || (mutates && host.readOnly === true)) return;
        action(notebook);
      };
      host.registerMenuItems([
        { label: 'Insert Cell Above', icon: 'add', onClick: withNotebook((notebook) => insertCell(notebook, 'above')) },
        { label: 'Insert Cell Below', icon: 'add', onClick: withNotebook((notebook) => insertCell(notebook, 'below')) },
        { label: 'Duplicate Cell', icon: 'content_copy', onClick: withNotebook(duplicateCells) },
        { label: 'Cut Cell', icon: 'content_cut', onClick: withNotebook(NotebookActions.cut) },
        { label: 'Copy Cell', icon: 'file_copy', onClick: withNotebook(NotebookActions.copy, false) },
        { label: 'Paste Cell Below', icon: 'content_paste', onClick: withNotebook((notebook) => NotebookActions.paste(notebook, 'belowSelected')) },
        { label: 'Change Cell to Code', icon: 'code', onClick: withNotebook((notebook) => NotebookActions.changeCellType(notebook, 'code')) },
        { label: 'Change Cell to Markdown', icon: 'markdown', onClick: withNotebook((notebook) => NotebookActions.changeCellType(notebook, 'markdown')) },
        { label: 'Change Cell to Raw', icon: 'text_fields', onClick: withNotebook((notebook) => NotebookActions.changeCellType(notebook, 'raw')) },
        { label: 'Move Cell Up', icon: 'arrow_upward', onClick: withNotebook(NotebookActions.moveUp) },
        { label: 'Move Cell Down', icon: 'arrow_downward', onClick: withNotebook(NotebookActions.moveDown) },
        { label: 'Split Cell at Cursor', icon: 'call_split', onClick: withNotebook(splitActiveCell) },
        { label: 'Merge Cell Above', icon: 'vertical_align_top', onClick: withNotebook((notebook) => mergeCells(notebook, 'above')) },
        { label: 'Merge Cell Below', icon: 'vertical_align_bottom', onClick: withNotebook((notebook) => mergeCells(notebook, 'below')) },
        { label: 'Clear Selected Output', icon: 'ink_eraser', onClick: withNotebook(clearSelectedOutputs) },
        { label: 'Collapse or Expand Input', icon: 'unfold_less', onClick: withNotebook(toggleSelectedInputs) },
        { label: 'Collapse or Expand Output', icon: 'unfold_more', onClick: withNotebook(toggleSelectedOutputs) },
        { label: 'Toggle Output Scrolling', icon: 'swap_vert', onClick: withNotebook(toggleSelectedOutputScrolling) },
        { label: 'Undo Cell Action', icon: 'undo', onClick: withNotebook(NotebookActions.undo) },
        { label: 'Redo Cell Action', icon: 'redo', onClick: withNotebook(NotebookActions.redo) },
        {
          label: 'Delete Selected Cell',
          icon: 'delete',
          onClick: withNotebook((notebook) => {
            requestConfirm({
              message: 'Delete the selected notebook cell(s)?',
              confirmLabel: 'Delete',
              onConfirm: () => NotebookActions.deleteCells(notebook),
            });
          }),
        },
      ]);
      return () => host.registerMenuItems([]);
    }, [host, requestConfirm]);

    useEffect(() => {
      return () => {
        host.registerEditorAPI(null);
        kernelAttemptRef.current += 1;
        void releaseManagedLease();
        widgetsRef.current?.dispose();
        widgetsRef.current = null;
        codeAssistanceRef.current?.dispose();
        codeAssistanceRef.current = null;
        stalenessTrackerRef.current?.dispose();
        stalenessTrackerRef.current = null;
        const sc = sessionContextRef.current;
        const sm = serviceManagerRef.current;
        if (sc) {
          sessionContextRef.current = null;
        }
        if (sm) {
          serviceManagerRef.current = null;
        }
        if (sc) {
          void sc.disposeAsync()
            .catch(() => undefined)
            .finally(() => sm?.dispose());
        } else {
          sm?.dispose();
        }
        if (builtRef.current) {
          if (attachedRef.current) {
            try {
              Widget.detach(builtRef.current.notebook);
            } catch {
              // detach throws if already detached; safe to ignore
            }
            attachedRef.current = false;
          }
          builtRef.current.dispose();
          builtRef.current = null;
        }
      };
    }, [host]);

    return (
      <div ref={rootRef} className="jupyter-notebook-editor-root">
        <NotebookToolbar
          sessionContext={sessionContext}
          notebook={selectionNotebook}
          readOnly={readOnly}
          requestConfirm={requestConfirm}
          onError={setKernelError}
          onManageRuntime={() => setShowRuntimeSetup((visible) => !visible)}
          runtimeDescription={runtimeDescription}
        />
        <CellChrome
          notebook={selectionNotebook}
          sessionContext={sessionContext}
          staleness={stalenessTracker}
          readOnly={readOnly}
          requestConfirm={requestConfirm}
          onError={setKernelError}
        />
        {kernelError || showRuntimeSetup ? (
          <RuntimeSetupPanel
            error={kernelError ?? undefined}
            onClose={kernelError ? undefined : () => setShowRuntimeSetup(false)}
            onRetry={() => void initializeKernel(host.filePath ?? 'untitled.ipynb')}
          />
        ) : null}
        {error ? (
          <div className="jupyter-notebook-editor-error">
            Failed to load notebook: {error.message}
          </div>
        ) : null}
        {isLoading ? (
          <div className="jupyter-notebook-editor-loading">Loading notebook…</div>
        ) : null}
        <div ref={containerRef} className="jupyter-notebook-editor-mount" />
        {confirmDialog}
      </div>
    );
  },
);

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
