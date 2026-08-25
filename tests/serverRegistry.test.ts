import { describe, expect, it, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isProcessAlive,
  processMatchesRecord,
  readRegistry,
  recordServer,
  forgetServer,
  reclaimOrphanedServers,
  registryPath,
} from '../src/services/serverRegistry';

const spawned: ChildProcess[] = [];
const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jupyter-registry-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Stands in for a managed jupyter-server: a long-lived process whose command line
 * carries the token, which is what identity matching keys off.
 */
function spawnFakeServer(token: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ['-e', `/* jupyter --IdentityProvider.token=${token} */ setTimeout(() => {}, 60000)`],
    { stdio: 'ignore' },
  );
  spawned.push(child);
  return child;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('managed server registry', () => {
  it('kills a recorded server left behind by a previous backend process', async () => {
    const dataDir = makeDataDir();
    const token = 'abc123token';
    const child = spawnFakeServer(token);
    expect(child.pid).toBeDefined();

    recordServer(dataDir, {
      pid: child.pid!,
      port: 8899,
      token,
      rootDir: '/workspace',
      startedAt: new Date(0).toISOString(),
    });

    const reclaimed = reclaimOrphanedServers(dataDir);

    expect(reclaimed).toEqual([child.pid]);
    await waitForExit(child);
    expect(isProcessAlive(child.pid!)).toBe(false);
    // The registry is cleared so the next activate() does not retry a dead pid.
    expect(readRegistry(dataDir)).toEqual([]);
  });

  it('spares the pid the caller is currently managing', async () => {
    const dataDir = makeDataDir();
    const token = 'live-server-token';
    const child = spawnFakeServer(token);

    recordServer(dataDir, {
      pid: child.pid!,
      port: 8899,
      token,
      rootDir: '/workspace',
      startedAt: new Date(0).toISOString(),
    });

    const reclaimed = reclaimOrphanedServers(dataDir, { skipPids: [child.pid!] });

    expect(reclaimed).toEqual([]);
    expect(isProcessAlive(child.pid!)).toBe(true);
    // The live server stays recorded, so a later crash can still reclaim it.
    expect(readRegistry(dataDir)).toHaveLength(1);
  });

  it('refuses to kill a pid that no longer carries the recorded token', () => {
    const dataDir = makeDataDir();
    const impostor = spawnFakeServer('some-other-token');

    recordServer(dataDir, {
      pid: impostor.pid!,
      port: 8899,
      token: 'the-token-we-recorded',
      rootDir: '/workspace',
      startedAt: new Date(0).toISOString(),
    });

    expect(processMatchesRecord(impostor.pid!, {
      pid: impostor.pid!,
      port: 8899,
      token: 'the-token-we-recorded',
      rootDir: '/workspace',
      startedAt: new Date(0).toISOString(),
    })).toBe(false);

    expect(reclaimOrphanedServers(dataDir)).toEqual([]);
    expect(isProcessAlive(impostor.pid!)).toBe(true);
  });

  it('survives a corrupt or partially written registry file', () => {
    const dataDir = makeDataDir();
    writeFileSync(registryPath(dataDir), '{ this is not json', 'utf8');

    expect(readRegistry(dataDir)).toEqual([]);
    expect(reclaimOrphanedServers(dataDir)).toEqual([]);
  });

  it('drops malformed entries but keeps valid ones', () => {
    const dataDir = makeDataDir();
    writeFileSync(
      registryPath(dataDir),
      JSON.stringify([
        { pid: 'not-a-number', token: 'x' },
        { pid: 424242, port: 1, token: 't', rootDir: '/w', startedAt: 'now' },
        null,
      ]),
      'utf8',
    );

    expect(readRegistry(dataDir)).toEqual([
      { pid: 424242, port: 1, token: 't', rootDir: '/w', startedAt: 'now' },
    ]);
  });

  it('forgets a pid once its process has exited', () => {
    const dataDir = makeDataDir();
    recordServer(dataDir, {
      pid: 424242,
      port: 8899,
      token: 'tok',
      rootDir: '/workspace',
      startedAt: new Date(0).toISOString(),
    });
    expect(readRegistry(dataDir)).toHaveLength(1);

    forgetServer(dataDir, 424242);

    expect(readRegistry(dataDir)).toEqual([]);
  });
});
