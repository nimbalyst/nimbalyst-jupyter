/**
 * On-disk record of managed Jupyter server processes.
 *
 * The backend utility process is the only thing that stops a managed server, so any
 * teardown it does not observe (host crash, hard kill, extension disable that skips
 * `deactivate`) leaves the `jupyter-server` child reparented to init and running
 * forever. This registry survives the backend process so the next `activate()` can
 * reclaim whatever the previous one abandoned.
 *
 * Entries are matched back to live processes by token, not by pid alone: pids are
 * recycled, and killing a stranger that inherited one would be far worse than
 * leaking.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export interface ServerRecord {
  pid: number;
  port: number;
  token: string;
  rootDir: string;
  startedAt: string;
}

const REGISTRY_FILE = 'managed-servers.json';

export function registryPath(dataDir: string): string {
  return path.join(dataDir, REGISTRY_FILE);
}

export function readRegistry(dataDir: string): ServerRecord[] {
  let raw: string;
  try {
    raw = readFileSync(registryPath(dataDir), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isServerRecord);
}

function isServerRecord(value: unknown): value is ServerRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.pid === 'number'
    && Number.isInteger(record.pid)
    && record.pid > 0
    && typeof record.port === 'number'
    && typeof record.token === 'string'
    && record.token.length > 0
    && typeof record.rootDir === 'string'
    && typeof record.startedAt === 'string'
  );
}

/** Writes via a temp file + rename so a crash mid-write cannot corrupt the registry. */
function writeRegistry(dataDir: string, records: ServerRecord[]): void {
  const target = registryPath(dataDir);
  const temp = `${target}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(records, null, 1)}\n`, 'utf8');
    renameSync(temp, target);
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing useful to do; the registry is best-effort.
    }
  }
}

export function recordServer(dataDir: string, record: ServerRecord): void {
  const records = readRegistry(dataDir).filter((entry) => entry.pid !== record.pid);
  records.push(record);
  writeRegistry(dataDir, records);
}

export function forgetServer(dataDir: string, pid: number): void {
  const records = readRegistry(dataDir);
  const remaining = records.filter((entry) => entry.pid !== pid);
  if (remaining.length !== records.length) writeRegistry(dataDir, remaining);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user, which already fails
    // the ownership check we need before killing anything.
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Confirms `pid` is still the server we recorded rather than an unrelated process
 * that inherited the pid. The token is unique per spawn and appears verbatim in the
 * command line, so it is a sufficient identity check.
 */
export function processMatchesRecord(pid: number, record: ServerRecord): boolean {
  let commandLine: string;
  try {
    commandLine = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 5_000,
    });
  } catch {
    return false;
  }
  return (
    commandLine.includes(`--IdentityProvider.token=${record.token}`)
    && commandLine.includes('jupyter')
  );
}

/**
 * Kills managed servers left behind by a previous backend process. Returns the pids
 * actually reclaimed. Records whose process is gone (or is now someone else) are
 * dropped from the registry without signalling anything.
 */
export function reclaimOrphanedServers(
  dataDir: string,
  options: { skipPids?: readonly number[] } = {},
): number[] {
  const skip = new Set(options.skipPids ?? []);
  const reclaimed: number[] = [];

  for (const record of readRegistry(dataDir)) {
    if (skip.has(record.pid)) continue;
    if (!isProcessAlive(record.pid) || !processMatchesRecord(record.pid, record)) continue;
    try {
      process.kill(record.pid, 'SIGTERM');
      reclaimed.push(record.pid);
    } catch {
      // Already gone, or not ours to signal.
    }
  }

  const survivors = readRegistry(dataDir).filter((record) => skip.has(record.pid));
  writeRegistry(dataDir, survivors);
  return reclaimed;
}

/**
 * Second pass over pids that ignored SIGTERM. Callers run this after a grace period.
 */
export function forceKillSurvivors(pids: readonly number[]): number[] {
  const killed: number[] = [];
  for (const pid of pids) {
    if (!isProcessAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // Already gone.
    }
  }
  return killed;
}
