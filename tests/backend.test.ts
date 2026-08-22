import { describe, expect, it } from 'vitest';

import {
  buildJupyterServerArgs,
  buildPipInstallArgs,
  buildPythonCandidates,
  resolveWorkspaceRoot,
} from '../src/backend';

describe('managed Jupyter backend helpers', () => {
  it('builds token-secured localhost server arguments', () => {
    expect(buildJupyterServerArgs({
      rootDir: '/workspace/notebooks',
      port: 8899,
      token: 'secret-token',
    })).toEqual([
      'server',
      '--no-browser',
      '--ip=127.0.0.1',
      '--port=8899',
      '--ServerApp.root_dir=/workspace/notebooks',
      '--IdentityProvider.token=secret-token',
      '--ServerApp.password=',
      '--ServerApp.allow_origin=*',
    ]);
  });

  it('keeps requested roots inside the active workspace', () => {
    expect(resolveWorkspaceRoot('/workspace/project', 'notebooks')).toBe('/workspace/project/notebooks');
    expect(() => resolveWorkspaceRoot('/workspace/project', '../other')).toThrow(
      /inside the active workspace/,
    );
  });

  it('prioritizes workspace and active-environment Python installations', () => {
    expect(buildPythonCandidates(
      '/workspace/project',
      { VIRTUAL_ENV: '/env', CONDA_PREFIX: '/conda' },
      'darwin',
      '/home/me',
    ).slice(0, 5)).toEqual([
      { executable: '/workspace/project/.venv/bin/python', source: 'workspace' },
      { executable: '/env/bin/python', source: 'environment' },
      { executable: '/conda/bin/python', source: 'environment' },
      { executable: '/home/me/.pyenv/shims/python3', source: 'environment' },
      { executable: 'python3', source: 'path' },
    ]);
  });

  it('installs into virtual environments directly and uses user site for system Python', () => {
    expect(buildPipInstallArgs(false)).not.toContain('--user');
    expect(buildPipInstallArgs(true)).toContain('--user');
    expect(buildPipInstallArgs(false)).toEqual([
      '-m', 'pip', 'install', 'jupyter_server', 'jupyter-client', 'ipykernel', 'ipywidgets',
    ]);
  });
});
