import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { KernelMessage } from '@jupyterlab/services';

import { activate } from '../src/backend';
import { createLocalServiceManager, toJupyterSessionPath } from '../src/services/serviceManagers';

const integration = import.meta.env.MODE === 'integration';
const cleanupPaths: string[] = [];

describe.runIf(integration)('managed Jupyter backend integration', () => {
  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('starts a leased server and runs a nested notebook kernel in its directory', async () => {
    const workspacePath = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-jupyter-workspace-'));
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-jupyter-data-'));
    cleanupPaths.push(workspacePath, dataDir);
    const notebookDir = path.join(workspacePath, 'notebooks', 'nested');
    const notebookPath = path.join(notebookDir, 'integration.ipynb');
    mkdirSync(notebookDir, { recursive: true });
    writeFileSync(notebookPath, '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}\n');

    const registered: string[] = [];
    const backend = await activate({
      services: {
        workspacePath,
        dataDir,
        log: () => undefined,
        registerMcpTools: async (tools) => {
          registered.push(...tools.map((tool) => tool.name));
          return { registered };
        },
      },
    });

    try {
      const pythons = await backend.methods.list_pythons();
      const readyPython = pythons.pythons.find((python) => python.hasJupyterServer);
      expect(readyPython, 'integration test requires a Python with jupyter_server').toBeTruthy();

      const server = await backend.methods.acquire_server({
        pythonPath: readyPython?.executable,
      });
      expect(server.rootDir).toBe(workspacePath);
      expect(server.pythonPath).toBe(readyPython?.executable);
      expect(server.token).toMatch(/^[a-f0-9]{48}$/);
      expect(await backend.methods.heartbeat_server({ leaseId: server.leaseId })).toMatchObject({
        active: true,
      });

      const serviceManager = createLocalServiceManager(server);
      await serviceManager.ready;
      const sessionPath = toJupyterSessionPath(notebookPath, server.rootDir);
      expect(sessionPath).toBe('notebooks/nested/integration.ipynb');
      const session = await serviceManager.sessions.startNew({
        path: sessionPath,
        name: 'integration.ipynb',
        type: 'notebook',
        kernel: { name: 'python3' },
      });
      const stdout: string[] = [];
      try {
        const future = session.kernel?.requestExecute({
          code: 'import os; print(os.getcwd())',
          stop_on_error: true,
        });
        expect(future).toBeTruthy();
        if (!future) throw new Error('Kernel did not return an execution future.');
        future.onIOPub = (message: KernelMessage.IIOPubMessage) => {
          if (message.header.msg_type !== 'stream') return;
          stdout.push(String((message.content as { text?: unknown }).text ?? ''));
        };
        await future.done;
        expect(realpathSync(stdout.join('').trim())).toBe(realpathSync(notebookDir));
      } finally {
        await session.shutdown();
        session.dispose();
        serviceManager.dispose();
      }

      expect(await backend.methods.release_server({ leaseId: server.leaseId })).toEqual({
        released: true,
      });
      expect(await backend.methods.stop_server()).toMatchObject({ stopped: true });
      expect(registered).toContain('acquire_server');
      expect(registered).toContain('heartbeat_server');
      expect(registered).toContain('release_server');
    } finally {
      await backend.deactivate();
    }
  }, 30_000);
});
