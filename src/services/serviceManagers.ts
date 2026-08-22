/**
 * ServiceManager factories. Each function returns a JupyterLab
 * `ServiceManager.IManager` pointed at a specific kernel source.
 *
 * v1 ships `createLocalServiceManager` (talks to localhost `jupyter_server`).
 * The server can be user-started in dev mode or spawned by the extension's
 * backend module when that privileged capability is granted. Future:
 *   - `createPyodideServiceManager`  in-browser Pyodide kernel
 */

import { ServerConnection, ServiceManager } from '@jupyterlab/services';
import { getExtensionContext } from '../extensionContext';

export interface LocalServerConfig {
  /** e.g. http://127.0.0.1:8888 */
  baseUrl: string;
  /** Pass empty string if the server was started with --IdentityProvider.token="". */
  token: string;
  /** Optional explicit ws URL. Derived from baseUrl by default. */
  wsUrl?: string;
  /** Managed server filesystem root. Used to derive the Jupyter API path. */
  rootDir?: string;
  /** Python executable backing a managed server. */
  pythonPath?: string;
}

export interface ServerResolution {
  config: LocalServerConfig | null;
  source: 'manual' | 'dev' | 'managed' | null;
  error: string | null;
  leaseId?: string;
}

export const DEV_SERVER_CONFIG_STORAGE_KEY = 'nimbalyst.jupyter.devServer';
export const MANUAL_SERVER_URL_CONFIG_KEY = 'manualServerUrl';
export const MANUAL_SERVER_ROOT_CONFIG_KEY = 'manualServerRoot';
let manualSessionConfig: LocalServerConfig | null = null;

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
  if (isLocalServerConfig(cfg)) {
    return cfg;
  }

  try {
    const raw = globalThis.localStorage?.getItem(DEV_SERVER_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isLocalServerConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Store a manual token for this renderer session only; tokens never enter localStorage. */
export function setManualServerConfig(config: LocalServerConfig | null): void {
  if (config) assertLoopbackServerConfig(config);
  manualSessionConfig = config;
}

export function assertLoopbackServerConfig(config: LocalServerConfig): void {
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw new Error('Enter a valid Jupyter server URL, such as http://127.0.0.1:8888.');
  }
  const isLoopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (!isLoopback || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error('v1 supports local Jupyter servers on localhost only.');
  }
  if (config.wsUrl) {
    const wsUrl = new URL(config.wsUrl);
    if (!isLoopbackHost(wsUrl.hostname) || (wsUrl.protocol !== 'ws:' && wsUrl.protocol !== 'wss:')) {
      throw new Error('The websocket URL must also use localhost.');
    }
  }
}

export async function resolveServerConfig(): Promise<ServerResolution> {
  const configuredUrl = getExtensionContext()?.services.configuration?.get<string>(
    MANUAL_SERVER_URL_CONFIG_KEY,
    '',
  );
  if (configuredUrl && !manualSessionConfig) {
    const configuredRoot = getExtensionContext()?.services.configuration?.get<string>(
      MANUAL_SERVER_ROOT_CONFIG_KEY,
      '',
    );
    const candidate: LocalServerConfig = {
      baseUrl: configuredUrl,
      token: '',
      ...(configuredRoot ? { rootDir: configuredRoot } : {}),
    };
    // `manualServerUrl` is workspace-scoped, so it arrives with the workspace and
    // is no more trusted than any other file in it. Fail closed rather than
    // silently falling through to the managed server, so the rejected setting is
    // visible instead of looking like it took effect.
    try {
      assertLoopbackServerConfig(candidate);
    } catch (error) {
      return {
        config: null,
        source: null,
        error: `The configured Jupyter server URL was rejected: ${
          error instanceof Error ? error.message : String(error)
        } Clear "manualServerUrl" in workspace settings to use the managed server.`,
      };
    }
    manualSessionConfig = candidate;
  }
  if (manualSessionConfig) {
    return { config: manualSessionConfig, source: 'manual', error: null };
  }
  const devConfig = readDevServerConfig();
  if (devConfig) {
    return { config: devConfig, source: 'dev', error: null };
  }

  const ai = getExtensionContext()?.services.ai;
  if (!ai?.callBackendTool) {
    return {
      config: null,
      source: null,
      error:
        'No Jupyter server configured and the managed runtime bridge is unavailable. Grant the Jupyter backend module, or set window.__NIMBALYST_JUPYTER_DEV_SERVER__ in DevTools.',
    };
  }

  try {
    const selectedPython = getExtensionContext()?.services.configuration?.get<string>(
      'pythonPath',
      '',
    );
    const result = await ai.callBackendTool('jupyter.acquire_server', {
      ...(selectedPython ? { pythonPath: selectedPython } : {}),
    });
    const config = managedServerResultToConfig(result);
    if (!config) {
      return {
        config: null,
        source: null,
        error: 'The managed Jupyter runtime returned an invalid server configuration.',
      };
    }
    const leaseId = readStringProperty(result, 'leaseId');
    if (!leaseId) {
      return {
        config: null,
        source: null,
        error: 'The managed Jupyter runtime did not return an editor lease.',
      };
    }
    return { config, source: 'managed', error: null, leaseId };
  } catch (error) {
    return {
      config: null,
      source: null,
      error: `Managed Jupyter runtime is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isLocalServerConfig(value: unknown): value is LocalServerConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LocalServerConfig>;
  const validShape = (
    typeof candidate.baseUrl === 'string' &&
    typeof candidate.token === 'string' &&
    (candidate.wsUrl == null || typeof candidate.wsUrl === 'string') &&
    (candidate.rootDir == null || typeof candidate.rootDir === 'string') &&
    (candidate.pythonPath == null || typeof candidate.pythonPath === 'string')
  );
  if (!validShape) return false;
  try {
    assertLoopbackServerConfig(candidate as LocalServerConfig);
    return true;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function managedServerResultToConfig(value: unknown): LocalServerConfig | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    baseUrl?: unknown;
    token?: unknown;
    wsUrl?: unknown;
    rootDir?: unknown;
    pythonPath?: unknown;
  };
  const config = {
    baseUrl: candidate.baseUrl,
    token: candidate.token,
    wsUrl: candidate.wsUrl,
    rootDir: candidate.rootDir,
    pythonPath: candidate.pythonPath,
  };
  return isLocalServerConfig(config) ? config : null;
}

function readStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === 'string' && property.length > 0 ? property : null;
}

export async function heartbeatServerLease(leaseId: string): Promise<boolean> {
  const call = getExtensionContext()?.services.ai?.callBackendTool;
  if (!call) return false;
  const result = await call('jupyter.heartbeat_server', { leaseId });
  return !!result && typeof result === 'object' &&
    (result as { active?: unknown }).active === true;
}

export async function releaseServerLease(leaseId: string): Promise<void> {
  const call = getExtensionContext()?.services.ai?.callBackendTool;
  if (!call) return;
  await call('jupyter.release_server', { leaseId });
}

/** Convert an absolute host path into the relative path expected by Jupyter's sessions API. */
export function toJupyterSessionPath(filePath: string, rootDir?: string): string {
  const normalizedFile = normalizeSlashes(filePath);
  if (!isAbsoluteLike(normalizedFile)) {
    return normalizedFile.replace(/^\.\//, '') || 'untitled.ipynb';
  }
  if (rootDir) {
    const normalizedRoot = normalizeSlashes(rootDir).replace(/\/$/, '');
    const fileForCompare = comparablePath(normalizedFile);
    const rootForCompare = comparablePath(normalizedRoot);
    if (fileForCompare.startsWith(`${rootForCompare}/`)) {
      return normalizedFile.slice(normalizedRoot.length + 1);
    }
    throw new Error('The notebook is outside the configured Jupyter server root.');
  }
  return normalizedFile.split('/').filter(Boolean).at(-1) ?? 'untitled.ipynb';
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

function comparablePath(value: string): string {
  return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}
