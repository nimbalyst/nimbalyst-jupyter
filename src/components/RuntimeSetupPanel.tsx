import { useEffect, useState } from 'react';

import { getExtensionContext } from '../extensionContext';
import {
  MANUAL_SERVER_URL_CONFIG_KEY,
  MANUAL_SERVER_ROOT_CONFIG_KEY,
  assertLoopbackServerConfig,
  setManualServerConfig,
} from '../services/serviceManagers';

interface PythonInfo {
  executable: string;
  version: string;
  hasJupyterServer: boolean;
  hasPip: boolean;
  source: string;
}

export interface RuntimeSetupPanelProps {
  error?: string;
  onRetry: () => void;
  onClose?: () => void;
}

export function RuntimeSetupPanel({ error, onRetry, onClose }: RuntimeSetupPanelProps) {
  const [pythons, setPythons] = useState<PythonInfo[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const configuration = getExtensionContext()?.services.configuration;
  const [selectedPython, setSelectedPython] = useState(
    configuration?.get<string>('pythonPath', '') ?? '',
  );
  const [baseUrl, setBaseUrl] = useState(
    configuration?.get<string>(MANUAL_SERVER_URL_CONFIG_KEY, '') ?? '',
  );
  const [token, setToken] = useState('');
  const [serverRoot, setServerRoot] = useState(
    configuration?.get<string>(MANUAL_SERVER_ROOT_CONFIG_KEY, '') ?? '',
  );

  const detect = async () => {
    const call = getExtensionContext()?.services.ai?.callBackendTool;
    if (!call) return;
    setDetecting(true);
    setActionError(null);
    try {
      const result = await call('jupyter.list_pythons', {}) as { pythons?: PythonInfo[] };
      setPythons(Array.isArray(result.pythons) ? result.pythons : []);
    } catch (caught) {
      setActionError(messageOf(caught));
    } finally {
      setDetecting(false);
    }
  };

  useEffect(() => {
    if (error) void detect();
  }, [error]);

  const install = async (python: PythonInfo) => {
    const call = getExtensionContext()?.services.ai?.callBackendTool;
    if (!call) return;
    setInstalling(python.executable);
    setActionError(null);
    try {
      await call('jupyter.install_server', { pythonPath: python.executable });
      await selectPython(python.executable);
      await detect();
    } catch (caught) {
      setActionError(messageOf(caught));
    } finally {
      setInstalling(null);
    }
  };

  const selectPython = async (pythonPath: string, stopExisting = true) => {
    const call = getExtensionContext()?.services.ai?.callBackendTool;
    setActionError(null);
    try {
      await configuration?.update('pythonPath', pythonPath, 'workspace');
      await configuration?.update(MANUAL_SERVER_URL_CONFIG_KEY, '', 'workspace');
      setManualServerConfig(null);
      setSelectedPython(pythonPath);
      setBaseUrl('');
      setToken('');
      setServerRoot('');
      await configuration?.update(MANUAL_SERVER_ROOT_CONFIG_KEY, '', 'workspace');
      if (stopExisting) await call?.('jupyter.stop_server', {});
      onRetry();
    } catch (caught) {
      setActionError(messageOf(caught));
    }
  };

  const connectManual = async () => {
    try {
      const config = {
        baseUrl: baseUrl.trim(),
        token,
        ...(serverRoot.trim() ? { rootDir: serverRoot.trim() } : {}),
      };
      assertLoopbackServerConfig(config);
      await getExtensionContext()?.services.ai?.callBackendTool?.('jupyter.stop_server', {})
        .catch(() => undefined);
      setManualServerConfig(config);
      await configuration?.update(MANUAL_SERVER_URL_CONFIG_KEY, config.baseUrl, 'workspace');
      await configuration?.update(MANUAL_SERVER_ROOT_CONFIG_KEY, config.rootDir ?? '', 'workspace');
      setActionError(null);
      onRetry();
    } catch (caught) {
      setActionError(messageOf(caught));
    }
  };

  const useManaged = async () => {
    try {
      setManualServerConfig(null);
      setBaseUrl('');
      setToken('');
      setServerRoot('');
      await configuration?.update(MANUAL_SERVER_URL_CONFIG_KEY, '', 'workspace');
      await configuration?.update(MANUAL_SERVER_ROOT_CONFIG_KEY, '', 'workspace');
      setActionError(null);
      onRetry();
    } catch (caught) {
      setActionError(messageOf(caught));
    }
  };

  return (
    <section className="jupyter-runtime-setup" aria-label="Jupyter runtime setup">
      <div className="jupyter-runtime-setup__title-row">
        <div className="jupyter-runtime-setup__heading">
          {error ? 'Kernel unavailable' : 'Jupyter runtime'}
        </div>
        {onClose ? <button type="button" onClick={onClose} aria-label="Close runtime panel">Close</button> : null}
      </div>
      {error ? <div className="jupyter-runtime-setup__message">{error}</div> : null}
      <div className="jupyter-runtime-setup__actions">
        {error ? <button type="button" onClick={onRetry}>Retry managed server</button> : null}
        <button type="button" onClick={() => void detect()} disabled={detecting}>
          {detecting ? 'Detecting Python…' : 'Detect Python'}
        </button>
        {selectedPython ? (
          <button type="button" onClick={() => void selectPython('')}>
            Choose Python automatically
          </button>
        ) : null}
      </div>
      {pythons.length > 0 ? (
        <div className="jupyter-runtime-setup__pythons">
          {pythons.map((python) => (
            <div className="jupyter-runtime-setup__python" key={python.executable}>
              <span>
                Python {python.version} · {python.executable}
                {python.hasJupyterServer ? ' · Jupyter ready' : ''}
                {selectedPython === python.executable ? ' · Selected' : ''}
              </span>
              {python.hasJupyterServer ? (
                <button
                  type="button"
                  disabled={installing !== null || selectedPython === python.executable}
                  onClick={() => void selectPython(python.executable)}
                >
                  {selectedPython === python.executable ? 'Selected' : 'Use this Python'}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!python.hasPip || installing !== null}
                  onClick={() => void install(python)}
                >
                  {installing === python.executable ? 'Installing…' : 'Install Jupyter'}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
      <details className="jupyter-runtime-setup__manual">
        <summary>Connect to a server I started</summary>
        <div className="jupyter-runtime-setup__manual-fields">
          <input
            aria-label="Jupyter server URL"
            placeholder="http://127.0.0.1:8888"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
          <input
            aria-label="Jupyter server root directory"
            placeholder="Server root (optional)"
            value={serverRoot}
            onChange={(event) => setServerRoot(event.target.value)}
          />
          <input
            aria-label="Jupyter token"
            placeholder="Token (kept for this session only)"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="button" onClick={() => void connectManual()}>Connect</button>
          {baseUrl ? <button type="button" onClick={() => void useManaged()}>Clear override</button> : null}
        </div>
      </details>
      {actionError ? <div className="jupyter-runtime-setup__action-error">{actionError}</div> : null}
    </section>
  );
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
