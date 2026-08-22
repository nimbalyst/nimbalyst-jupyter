import { afterEach, describe, expect, it, vi } from 'vitest';

import { setExtensionContext } from '../src/extensionContext';
import {
  DEV_SERVER_CONFIG_STORAGE_KEY,
  assertLoopbackServerConfig,
  readDevServerConfig,
  resolveServerConfig,
  setManualServerConfig,
  toJupyterSessionPath,
} from '../src/services/serviceManagers';

describe('service manager configuration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setExtensionContext(null);
    setManualServerConfig(null);
    vi.restoreAllMocks();
  });

  it('rejects remote manual server URLs in the local-only v1', () => {
    expect(() => assertLoopbackServerConfig({
      baseUrl: 'https://example.com/jupyter',
      token: 'do-not-send',
    })).toThrow(/localhost only/);
  });

  it('prefers a session-only manual server without persisting its token', async () => {
    vi.stubGlobal('localStorage', createStorage());
    setManualServerConfig({ baseUrl: 'http://localhost:9999', token: 'session-token' });
    await expect(resolveServerConfig()).resolves.toEqual({
      config: { baseUrl: 'http://localhost:9999', token: 'session-token' },
      source: 'manual',
      error: null,
    });
    expect(localStorage.length).toBe(0);
  });

  it('reads persisted dev server config', () => {
    const storage = createStorage();
    vi.stubGlobal('localStorage', storage);
    localStorage.setItem(
      DEV_SERVER_CONFIG_STORAGE_KEY,
      JSON.stringify({ baseUrl: 'http://127.0.0.1:8889', token: '' }),
    );

    expect(readDevServerConfig()).toEqual({
      baseUrl: 'http://127.0.0.1:8889',
      token: '',
    });
  });

  it('asks the managed backend for a server when no dev config exists', async () => {
    vi.stubGlobal('localStorage', createStorage());
    const callBackendTool = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8890',
      wsUrl: 'ws://127.0.0.1:8890',
      token: 'managed-token',
      rootDir: '/workspace/project',
      pythonPath: '/workspace/project/.venv/bin/python',
      leaseId: 'editor-lease',
    }));
    setExtensionContext({
      services: {
        ai: { callBackendTool },
      },
    } as never);

    await expect(resolveServerConfig()).resolves.toEqual({
      config: {
        baseUrl: 'http://127.0.0.1:8890',
        wsUrl: 'ws://127.0.0.1:8890',
        token: 'managed-token',
        rootDir: '/workspace/project',
        pythonPath: '/workspace/project/.venv/bin/python',
      },
      source: 'managed',
      error: null,
      leaseId: 'editor-lease',
    });
    expect(callBackendTool).toHaveBeenCalledWith('jupyter.acquire_server', {});
  });

  it('converts host absolute paths to server-relative Jupyter session paths', () => {
    expect(toJupyterSessionPath(
      '/workspace/project/notebooks/analysis.ipynb',
      '/workspace/project',
    )).toBe('notebooks/analysis.ipynb');
    expect(toJupyterSessionPath(
      'C:\\workspace\\project\\notebooks\\analysis.ipynb',
      'c:\\workspace\\project',
    )).toBe('notebooks/analysis.ipynb');
    expect(() => toJupyterSessionPath(
      '/outside/project/analysis.ipynb',
      '/workspace/project',
    )).toThrow(/outside the configured Jupyter server root/);
    expect(toJupyterSessionPath('/outside/project/analysis.ipynb')).toBe('analysis.ipynb');
  });

  it('requests the explicitly selected workspace Python', async () => {
    vi.stubGlobal('localStorage', createStorage());
    const callBackendTool = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:8890',
      token: 'token',
      rootDir: '/workspace/project',
      pythonPath: '/workspace/project/.venv/bin/python',
      leaseId: 'lease',
    }));
    setExtensionContext({
      services: {
        ai: { callBackendTool },
        configuration: {
          get: vi.fn((key: string) => key === 'pythonPath'
            ? '/workspace/project/.venv/bin/python'
            : ''),
        },
      },
    } as never);

    await expect(resolveServerConfig()).resolves.toMatchObject({
      source: 'managed',
      leaseId: 'lease',
      config: { pythonPath: '/workspace/project/.venv/bin/python' },
    });
    expect(callBackendTool).toHaveBeenCalledWith('jupyter.acquire_server', {
      pythonPath: '/workspace/project/.venv/bin/python',
    });
  });

  it('refuses a non-loopback manualServerUrl instead of falling back silently', async () => {
    vi.stubGlobal('localStorage', createStorage());
    const callBackendTool = vi.fn();
    setExtensionContext({
      services: {
        ai: { callBackendTool },
        configuration: {
          get: vi.fn((key: string) =>
            key === 'manualServerUrl' ? 'https://evil.example.com' : ''),
        },
      },
    } as never);

    const resolution = await resolveServerConfig();

    expect(resolution.config).toBeNull();
    expect(resolution.source).toBeNull();
    expect(resolution.error).toMatch(/rejected/);
    // Falling through to the managed server would hide the bad setting.
    expect(callBackendTool).not.toHaveBeenCalled();
  });

  it('accepts a loopback manualServerUrl from workspace configuration', async () => {
    vi.stubGlobal('localStorage', createStorage());
    setExtensionContext({
      services: {
        configuration: {
          get: vi.fn((key: string) =>
            key === 'manualServerUrl' ? 'http://127.0.0.1:8888' : ''),
        },
      },
    } as never);

    await expect(resolveServerConfig()).resolves.toMatchObject({
      source: 'manual',
      config: { baseUrl: 'http://127.0.0.1:8888', token: '' },
    });
  });
});

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}
