/**
 * ServiceManager factories. Each function returns a JupyterLab
 * `ServiceManager.IManager` pointed at a specific kernel source.
 *
 * v1 ships only `createLocalServiceManager` (talks to a user-started
 * `jupyter_server` on localhost). Future:
 *   - `createPyodideServiceManager`  in-browser Pyodide kernel
 *   - main-process managed local server (Phase 4)
 */

import { ServerConnection, ServiceManager } from '@jupyterlab/services';

export interface LocalServerConfig {
  /** e.g. http://127.0.0.1:8888 */
  baseUrl: string;
  /** Pass empty string if the server was started with --IdentityProvider.token="". */
  token: string;
  /** Optional explicit ws URL. Derived from baseUrl by default. */
  wsUrl?: string;
}

export function createLocalServiceManager(config: LocalServerConfig): ServiceManager.IManager {
  const serverSettings = ServerConnection.makeSettings({
    baseUrl: config.baseUrl.replace(/\/$/, ''),
    wsUrl: (config.wsUrl ?? config.baseUrl).replace(/^http/, 'ws').replace(/\/$/, ''),
    token: config.token,
    appendToken: config.token.length > 0,
  });
  return new ServiceManager({ serverSettings });
}

/**
 * Read the dev-only Jupyter server config from a renderer global. Until
 * the main-process `JupyterServerManager` lands (Phase 4) the developer
 * starts a server locally and points the renderer at it via:
 *
 *   window.__NIMBALYST_JUPYTER_DEV_SERVER__ = {
 *     baseUrl: 'http://127.0.0.1:8888',
 *     token: '',
 *   };
 *
 * Returns null if no config is present.
 */
export function readDevServerConfig(): LocalServerConfig | null {
  const cfg = (globalThis as unknown as { __NIMBALYST_JUPYTER_DEV_SERVER__?: LocalServerConfig })
    .__NIMBALYST_JUPYTER_DEV_SERVER__;
  if (!cfg || typeof cfg.baseUrl !== 'string' || typeof cfg.token !== 'string') {
    return null;
  }
  return cfg;
}
