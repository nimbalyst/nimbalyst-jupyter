    /**
 * Custom editor for `.ipynb` files.
 *
 * Mounts the JupyterLab `Notebook` widget (Lumino) inside a React tree
 * and attaches a `SessionContextManager` so cells actually execute
 * against a Jupyter kernel. In v1 the kernel comes from a user-started
 * `jupyter_server` (configured via `window.__NIMBALYST_JUPYTER_DEV_SERVER__`);
 * Phase 4 swaps that for `electronAPI.jupyter.ensureServer`.
 *
 * If no server config is found, the editor still renders (edit-only
 * mode) and the kernel toolbar reports "No kernel". This lets users
 * see and edit notebooks without a running Jupyter server.
 */

import { forwardRef, useEffect, useRef, useState } from 'react';
import { Widget } from '@lumino/widgets';
import type { Notebook, NotebookModel } from '@jupyterlab/notebook';
import type { ServiceManager } from '@jupyterlab/services';
import { useEditorLifecycle, type EditorHostProps } from '@nimbalyst/extension-sdk';
import type * as nbformat from '@jupyterlab/nbformat';

import { buildNotebook, parseNotebook, serializeNotebook } from '../services/buildNotebook';
import { applyTheme } from '../services/theme';
import { createEditorAPI } from '../editorApi';
import { createLocalServiceManager, readDevServerConfig } from '../services/serviceManagers';
import { SessionContextManager } from '../services/sessionContext';
import { KernelToolbar } from './KernelToolbar';

import '@jupyterlab/notebook/style/index.js';
import '@jupyterlab/theme-light-extension/style/variables.css';
import '@jupyterlab/theme-light-extension/style/theme.css';
import './JupyterNotebookEditor.css';

interface BuiltNotebookRef {
  notebook: Notebook;
  model: NotebookModel;
  dispose: () => void;
}

export const JupyterNotebookEditor = forwardRef<unknown, EditorHostProps>(
  function JupyterNotebookEditor({ host }, _ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const builtRef = useRef<BuiltNotebookRef | null>(null);
    const attachedRef = useRef(false);
    const serviceManagerRef = useRef<ServiceManager.IManager | null>(null);
    const sessionContextRef = useRef<SessionContextManager | null>(null);
    const [sessionContext, setSessionContext] = useState<SessionContextManager | null>(null);
    const [kernelError, setKernelError] = useState<string | null>(null);

    const { isLoading, error, theme } = useEditorLifecycle<nbformat.INotebookContent>(host, {
      parse: parseNotebook,
      serialize: serializeNotebook,

      applyContent: (content) => {
        const container = containerRef.current;
        if (!container) return;

        if (!builtRef.current) {
          const built = buildNotebook(content, { readOnly: host.readOnly === true });
          built.model.contentChanged.connect(handleModelContentChanged);
          builtRef.current = built;
          Widget.attach(built.notebook, container);
          attachedRef.current = true;
          applyTheme(container, host.theme);
          host.registerEditorAPI(createEditorAPI(built.notebook, built.model));
          attachKernelShortcuts(built.notebook);
          // Kick off kernel attach now that we have a notebook to bind to.
          void initializeKernel(host.filePath ?? 'untitled.ipynb');
          return;
        }

        builtRef.current.model.fromJSON(content);
      },

      getCurrentContent: () => {
        if (!builtRef.current) {
          throw new Error('Notebook not initialized');
        }
        return builtRef.current.model.toJSON();
      },
    });

    function handleModelContentChanged() {
      host.setDirty(true);
    }

    /**
     * Capture Shift+Enter / Ctrl+Enter at the Notebook root and route
     * to the SessionContext. Without this, JupyterLab's run shortcut
     * doesn't fire because we're not running inside JupyterLab's
     * application shell + CommandRegistry.
     */
    function attachKernelShortcuts(notebook: Notebook) {
      const node = notebook.node;
      node.addEventListener('keydown', (ev: KeyboardEvent) => {
        const isEnter = ev.key === 'Enter';
        if (!isEnter) return;
        const sc = sessionContextRef.current;
        if (!sc) return;
        if (ev.shiftKey) {
          ev.preventDefault();
          ev.stopPropagation();
          void sc.runAndAdvance(notebook);
        } else if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          ev.stopPropagation();
          void sc.runActive(notebook);
        }
      });
    }

    async function initializeKernel(path: string) {
      const cfg = readDevServerConfig();
      if (!cfg) {
        setKernelError(
          'No Jupyter server configured. Start one (e.g. `jupyter server --no-browser --IdentityProvider.token=""`) and set window.__NIMBALYST_JUPYTER_DEV_SERVER__ = { baseUrl, token } in DevTools.',
        );
        return;
      }
      try {
        const sm = createLocalServiceManager(cfg);
        serviceManagerRef.current = sm;
        await sm.ready;
        const sc = new SessionContextManager({ serviceManager: sm, path });
        sessionContextRef.current = sc;
        setSessionContext(sc);
        await sc.initialize();
      } catch (err) {
        setKernelError(err instanceof Error ? err.message : String(err));
      }
    }

    useEffect(() => {
      if (containerRef.current) {
        applyTheme(containerRef.current, theme);
      }
    }, [theme]);

    useEffect(() => {
      const onChange = host.onReadOnlyChanged;
      if (!onChange) return;
      return onChange((nextReadOnly) => {
        if (builtRef.current) {
          builtRef.current.model.readOnly = nextReadOnly;
        }
      });
    }, [host]);

    useEffect(() => {
      return () => {
        host.registerEditorAPI(null);
        const sc = sessionContextRef.current;
        if (sc) {
          sc.dispose();
          sessionContextRef.current = null;
        }
        const sm = serviceManagerRef.current;
        if (sm) {
          sm.dispose();
          serviceManagerRef.current = null;
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
      <div className="jupyter-notebook-editor-root">
        <KernelToolbar
          sessionContext={sessionContext}
          notebook={builtRef.current?.notebook ?? null}
          disabled={host.readOnly === true}
        />
        {kernelError ? (
          <div className="jupyter-notebook-editor-kernel-error" title={kernelError}>
            Kernel unavailable. Editing only.
          </div>
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
      </div>
    );
  },
);
