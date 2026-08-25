import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import {
  forceKillSurvivors,
  forgetServer,
  reclaimOrphanedServers,
  recordServer,
} from './services/serverRegistry.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface ActivateCtx {
  services: {
    workspacePath: string;
    dataDir: string;
    log: (level: LogLevel, message: string, data?: unknown) => void;
    registerMcpTools: (
      tools: Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
        scope?: 'global' | 'editor';
      }>
    ) => Promise<{ registered: string[] }>;
  };
}

interface EnsureServerParams {
  rootDir?: string;
  port?: number;
  startupTimeoutMs?: number;
  allowTokenless?: boolean;
  token?: string;
  pythonPath?: string;
}

export interface DetectedPython {
  executable: string;
  version: string;
  hasJupyterServer: boolean;
  hasPip: boolean;
  source: 'workspace' | 'environment' | 'path' | 'system';
}

interface ManagedServerInfo {
  baseUrl: string;
  wsUrl: string;
  token: string;
  pid: number | null;
  rootDir: string;
  logPath: string;
  startedAt: string;
  command: string;
  pythonPath: string;
}

interface ServerLease {
  expiresAt: number;
}

interface ServerState {
  process: ChildProcess;
  logStream: WriteStream;
  info: ManagedServerInfo;
  stopping: boolean;
  startError: Error | null;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

/**
 * `allowTokenless` and an explicit `token` let a caller stand up a local Jupyter
 * server whose auth is absent or attacker-known, which is arbitrary code
 * execution for anything else on the machine. They stay out of the MCP tool
 * schema and are ignored unless a developer opts in through the environment, so
 * an agent driving these tools can never reach them.
 */
function devUnsafeServerAllowed(): boolean {
  return process.env.NIMBALYST_JUPYTER_DEV_UNSAFE_SERVER === '1';
}

export function resolveServerToken(
  params: Pick<EnsureServerParams, 'token' | 'allowTokenless'>,
  devUnsafeAllowed = devUnsafeServerAllowed(),
): string {
  if (devUnsafeAllowed) {
    if (typeof params.token === 'string') return params.token;
    if (params.allowTokenless === true) return '';
  }
  return randomBytes(24).toString('hex');
}
const TOOL_DESCRIPTORS = [
  {
    name: 'list_pythons',
    description:
      'Detect Python installations available to this workspace and report whether pip and jupyter_server are installed.',
    inputSchema: { type: 'object', properties: {} },
    scope: 'global' as const,
  },
  {
    name: 'install_server',
    description:
      'Install jupyter_server, jupyter-client, ipykernel, and ipywidgets into a detected Python environment.',
    inputSchema: {
      type: 'object',
      properties: {
        pythonPath: {
          type: 'string',
          description: 'Executable returned by list_pythons. Defaults to the first detected Python.',
        },
      },
    },
    scope: 'global' as const,
  },
  {
    name: 'acquire_server',
    description:
      'Start or return the workspace-local Jupyter server and acquire a renewable editor lease that prevents idle shutdown while the notebook is mounted.',
    inputSchema: {
      type: 'object',
      properties: {
        pythonPath: {
          type: 'string',
          description: 'Optional executable returned by list_pythons.',
        },
      },
    },
    scope: 'global' as const,
  },
  {
    name: 'heartbeat_server',
    description: 'Renew a mounted notebook editor lease for the managed Jupyter server.',
    inputSchema: {
      type: 'object',
      properties: { leaseId: { type: 'string' } },
      required: ['leaseId'],
    },
    scope: 'global' as const,
  },
  {
    name: 'release_server',
    description: 'Release a mounted notebook editor lease for the managed Jupyter server.',
    inputSchema: {
      type: 'object',
      properties: { leaseId: { type: 'string' } },
      required: ['leaseId'],
    },
    scope: 'global' as const,
  },
  {
    name: 'ensure_server',
    description:
      'Start or return the workspace-local Jupyter server used by the Nimbalyst notebook editor. Returns baseUrl, wsUrl, token, pid, and rootDir.',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: {
          type: 'string',
          description:
            'Optional workspace-relative root directory. Defaults to the workspace root.',
        },
        port: {
          type: 'number',
          description: 'Optional localhost port. Defaults to an available random port.',
        },
        startupTimeoutMs: {
          type: 'number',
          description: 'How long to wait for Jupyter to answer /api/status.',
        },
        pythonPath: {
          type: 'string',
          description: 'Optional executable returned by list_pythons.',
        },
      },
    },
    scope: 'global' as const,
  },
  {
    name: 'get_server_status',
    description:
      'Return the managed Jupyter server status for this workspace, without starting a new server.',
    inputSchema: { type: 'object', properties: {} },
    scope: 'global' as const,
  },
  {
    name: 'list_kernels',
    description:
      'List kernel specs available from the managed Jupyter server. Starts the server by default.',
    inputSchema: {
      type: 'object',
      properties: {
        start: {
          type: 'boolean',
          description: 'Start the managed server if it is not already running. Default true.',
        },
      },
    },
    scope: 'global' as const,
  },
  {
    name: 'stop_server',
    description: 'Stop the managed Jupyter server for this workspace.',
    inputSchema: { type: 'object', properties: {} },
    scope: 'global' as const,
  },
  {
    name: 'save_output_asset',
    description:
      'Internal: decode a notebook output payload (e.g. a plot PNG) to a file under the extension data directory and return its absolute path. Used by jupyter.get_cell_output includeImages.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Payload content.' },
        encoding: {
          type: 'string',
          enum: ['base64', 'utf8'],
          description: 'How to decode `data`. Default base64.',
        },
        mime: { type: 'string', description: 'MIME type, drives the file extension.' },
        prefix: { type: 'string', description: 'Filename prefix, e.g. the cell id.' },
      },
      required: ['data'],
    },
    scope: 'global' as const,
  },
] as const;

const ASSET_DIR_NAME = 'assets';
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_ASSETS_KEPT = 100;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

let managedServer: ServerState | null = null;
let lastExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let serverStartPromise: Promise<ManagedServerInfo> | null = null;
let startingState: ServerState | null = null;
let shuttingDown = false;
const IDLE_SHUTDOWN_MS = 30 * 60_000;
const SERVER_LEASE_TTL_MS = 3 * 60_000;
const RECLAIM_GRACE_MS = 3_000;
const serverLeases = new Map<string, ServerLease>();
let teardownHooksInstalled = false;

export async function activate(ctx: ActivateCtx) {
  shuttingDown = false;
  const { workspacePath, dataDir, log, registerMcpTools } = ctx.services;
  mkdirSync(dataDir, { recursive: true });

  // A previous backend process may have died without stopping its server. Reclaim
  // before starting anything of our own, so leaks cannot accumulate across launches.
  reclaimPreviousServers(dataDir, log);
  installTeardownHooks(dataDir, log);

  await registerMcpTools(TOOL_DESCRIPTORS.map((tool) => ({ ...tool })));

  return {
    methods: {
      list_pythons: async () => ({ pythons: await detectPythons(workspacePath) }),
      install_server: async (params: { pythonPath?: string } = {}) =>
        installServer({ workspacePath, log }, params.pythonPath),
      acquire_server: async (params: EnsureServerParams = {}) => {
        const info = await ensureServerCoalesced({ workspacePath, dataDir, log }, params);
        const leaseId = randomBytes(18).toString('hex');
        serverLeases.set(leaseId, { expiresAt: Date.now() + SERVER_LEASE_TTL_MS });
        touchIdleTimer();
        return { ...info, leaseId };
      },
      heartbeat_server: async (params: { leaseId?: string } = {}) => {
        const leaseId = typeof params.leaseId === 'string' ? params.leaseId : '';
        const lease = serverLeases.get(leaseId);
        if (!lease || !managedServer) return { active: false };
        lease.expiresAt = Date.now() + SERVER_LEASE_TTL_MS;
        touchIdleTimer();
        return { active: true, expiresAt: new Date(lease.expiresAt).toISOString() };
      },
      release_server: async (params: { leaseId?: string } = {}) => {
        const released = typeof params.leaseId === 'string'
          ? serverLeases.delete(params.leaseId)
          : false;
        touchIdleTimer();
        return { released };
      },
      ensure_server: async (params: EnsureServerParams = {}) =>
        ensureServerCoalesced({ workspacePath, dataDir, log }, params),
      get_server_status: async () => getServerStatus(),
      list_kernels: async (params: { start?: boolean } = {}) => {
        const start = params.start !== false;
        if (!managedServer && start) {
          await ensureServerCoalesced({ workspacePath, dataDir, log }, {});
        }
        if (!managedServer) {
          return { running: false, kernels: [], lastExit };
        }
        touchIdleTimer();
        return {
          running: true,
          server: redactServerInfo(managedServer.info),
          kernels: await fetchKernelSpecs(managedServer.info),
        };
      },
      stop_server: async () => stopServer(),
      save_output_asset: async (params: {
        data?: string;
        encoding?: string;
        mime?: string;
        prefix?: string;
      } = {}) => saveOutputAsset(dataDir, params),
    },
    deactivate: async () => {
      shuttingDown = true;
      if (startingState) await stopState(startingState);
      await stopServer();
    },
  };
}

function reclaimPreviousServers(
  dataDir: string,
  log: ActivateCtx['services']['log'],
): void {
  const skipPids = managedServer?.info.pid != null ? [managedServer.info.pid] : [];
  const reclaimed = reclaimOrphanedServers(dataDir, { skipPids });
  if (reclaimed.length === 0) return;
  log('warn', `[jupyter] reclaiming ${reclaimed.length} orphaned server(s): ${reclaimed.join(', ')}`);
  const timer = setTimeout(() => {
    const killed = forceKillSurvivors(reclaimed);
    if (killed.length > 0) {
      log('warn', `[jupyter] force-killed orphaned server(s): ${killed.join(', ')}`);
    }
  }, RECLAIM_GRACE_MS);
  timer.unref?.();
}

/**
 * Kills the managed server when this process goes away. `deactivate` covers the
 * graceful path, but it does not run on host crash, signal, or a dropped IPC
 * channel — and without these hooks the child simply reparents to init and survives.
 *
 * The `exit` handler must be synchronous, so it uses SIGKILL directly rather than the
 * SIGTERM-then-escalate dance in `stopState`.
 */
function installTeardownHooks(
  dataDir: string,
  log: ActivateCtx['services']['log'],
): void {
  if (teardownHooksInstalled) return;
  teardownHooksInstalled = true;

  process.on('exit', () => {
    const pid = managedServer?.info.pid ?? startingState?.info.pid ?? null;
    if (pid == null) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    try {
      forgetServer(dataDir, pid);
    } catch {
      // Best-effort; the next activate() reclaims whatever is left.
    }
  });

  const shutdownAndExit = (reason: string) => {
    void (async () => {
      shuttingDown = true;
      log('info', `[jupyter] backend shutting down (${reason}); stopping managed server`);
      if (startingState) await stopState(startingState).catch(() => undefined);
      await stopServer().catch(() => undefined);
      process.exit(0);
    })();
  };

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => shutdownAndExit(signal));
  }
  // The host closed the utility process IPC channel: nothing will call deactivate.
  process.on('disconnect', () => shutdownAndExit('disconnect'));
}

function ensureServerCoalesced(
  ctx: Pick<ActivateCtx['services'], 'workspacePath' | 'dataDir' | 'log'>,
  params: EnsureServerParams,
): Promise<ManagedServerInfo> {
  if (serverStartPromise) return serverStartPromise;
  serverStartPromise = ensureServer(ctx, params).finally(() => {
    serverStartPromise = null;
  });
  return serverStartPromise;
}

async function saveOutputAsset(
  dataDir: string,
  params: { data?: string; encoding?: string; mime?: string; prefix?: string },
): Promise<{ path: string; bytes: number }> {
  if (typeof params.data !== 'string' || params.data.length === 0) {
    throw new Error('`data` is required.');
  }
  const encoding = params.encoding === 'utf8' ? 'utf8' : 'base64';
  const buffer = Buffer.from(params.data, encoding);
  if (buffer.byteLength === 0) {
    throw new Error('Decoded payload is empty; check the encoding.');
  }
  if (buffer.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`Payload exceeds the ${MAX_ASSET_BYTES / (1024 * 1024)}MB asset limit.`);
  }
  const extension = MIME_EXTENSIONS[params.mime ?? ''] ?? 'bin';
  const prefix = (params.prefix ?? 'output').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 60);
  const assetDir = path.join(dataDir, ASSET_DIR_NAME);
  mkdirSync(assetDir, { recursive: true });
  const filePath = path.join(
    assetDir,
    `${prefix}-${Date.now()}-${randomBytes(3).toString('hex')}.${extension}`,
  );
  await writeFile(filePath, buffer);
  pruneAssets(assetDir);
  return { path: filePath, bytes: buffer.byteLength };
}

/** Keep the newest MAX_ASSETS_KEPT files; exports are throwaway views. */
function pruneAssets(assetDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(assetDir);
  } catch {
    return;
  }
  if (entries.length <= MAX_ASSETS_KEPT) return;
  const stamped = entries
    .map((name) => {
      const fullPath = path.join(assetDir, name);
      try {
        return { fullPath, mtimeMs: statSync(fullPath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { fullPath: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of stamped.slice(MAX_ASSETS_KEPT)) {
    try {
      unlinkSync(entry.fullPath);
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Last-resort self-termination for a server nothing is managing any more.
 *
 * `ServerApp.shutdown_no_activity_timeout` only fires when the server has *zero*
 * kernels, so kernel culling has to be enabled for the chain to complete — an
 * abandoned server holding an idle kernel would otherwise live forever.
 * `cull_connected` stays at its default (false) so a kernel an editor is still
 * attached to is never culled out from under the user.
 *
 * These are deliberately slack compared to IDLE_SHUTDOWN_MS: the lease/idle logic and
 * the teardown hooks are the real mechanisms, and this must never race them.
 */
const KERNEL_CULL_IDLE_SECONDS = 2 * 60 * 60;
const KERNEL_CULL_INTERVAL_SECONDS = 5 * 60;
const SERVER_NO_ACTIVITY_SHUTDOWN_SECONDS = 30 * 60;

export function buildJupyterServerArgs(options: {
  rootDir: string;
  port: number;
  token: string;
}): string[] {
  return [
    'server',
    '--no-browser',
    '--ip=127.0.0.1',
    `--port=${options.port}`,
    `--ServerApp.root_dir=${options.rootDir}`,
    `--IdentityProvider.token=${options.token}`,
    '--ServerApp.password=',
    '--ServerApp.allow_origin=*',
    `--ServerApp.shutdown_no_activity_timeout=${SERVER_NO_ACTIVITY_SHUTDOWN_SECONDS}`,
    `--MappingKernelManager.cull_idle_timeout=${KERNEL_CULL_IDLE_SECONDS}`,
    `--MappingKernelManager.cull_interval=${KERNEL_CULL_INTERVAL_SECONDS}`,
  ];
}

export function resolveWorkspaceRoot(workspacePath: string, requestedRoot?: string): string {
  const workspaceRoot = path.resolve(workspacePath);
  const resolved = requestedRoot
    ? path.resolve(workspaceRoot, requestedRoot)
    : workspaceRoot;
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error('Jupyter server root must stay inside the active workspace.');
}

interface PythonCandidate {
  executable: string;
  source: DetectedPython['source'];
}

/** Ordered, de-duplicated Python candidates. Kept pure for platform regression tests. */
export function buildPythonCandidates(
  workspacePath: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir = os.homedir(),
): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  const add = (executable: string | undefined, source: PythonCandidate['source']) => {
    if (!executable || candidates.some((candidate) => candidate.executable === executable)) return;
    candidates.push({ executable, source });
  };

  if (platform === 'win32') {
    add(path.join(workspacePath, '.venv', 'Scripts', 'python.exe'), 'workspace');
    add(env.VIRTUAL_ENV ? path.join(env.VIRTUAL_ENV, 'Scripts', 'python.exe') : undefined, 'environment');
    add(env.CONDA_PREFIX ? path.join(env.CONDA_PREFIX, 'python.exe') : undefined, 'environment');
    add('python.exe', 'path');
    add('python3.exe', 'path');
  } else {
    add(path.join(workspacePath, '.venv', 'bin', 'python'), 'workspace');
    add(env.VIRTUAL_ENV ? path.join(env.VIRTUAL_ENV, 'bin', 'python') : undefined, 'environment');
    add(env.CONDA_PREFIX ? path.join(env.CONDA_PREFIX, 'bin', 'python') : undefined, 'environment');
    add(path.join(homeDir, '.pyenv', 'shims', 'python3'), 'environment');
    add('python3', 'path');
    add('python', 'path');
    add('/opt/homebrew/bin/python3', 'system');
    add('/usr/local/bin/python3', 'system');
    add('/usr/bin/python3', 'system');
  }
  return candidates;
}

export async function detectPythons(workspacePath: string): Promise<DetectedPython[]> {
  const detected: DetectedPython[] = [];
  for (const candidate of buildPythonCandidates(workspacePath)) {
    if (path.isAbsolute(candidate.executable) && !existsSync(candidate.executable)) continue;
    const probe = await runCommand(candidate.executable, [
      '-c',
      'import importlib.util, json, platform, sys; print(json.dumps({"executable": sys.executable, "version": platform.python_version(), "jupyter": importlib.util.find_spec("jupyter_server") is not None, "pip": importlib.util.find_spec("pip") is not None}))',
    ], 5_000).catch(() => null);
    if (!probe || probe.code !== 0) continue;
    try {
      const parsed = JSON.parse(probe.stdout.trim()) as {
        version?: unknown;
        executable?: unknown;
        jupyter?: unknown;
        pip?: unknown;
      };
      if (typeof parsed.version !== 'string') continue;
      const executable = typeof parsed.executable === 'string'
        ? parsed.executable
        : candidate.executable;
      if (detected.some((python) => python.executable === executable)) continue;
      detected.push({
        executable,
        version: parsed.version,
        hasJupyterServer: parsed.jupyter === true,
        hasPip: parsed.pip === true,
        source: candidate.source,
      });
    } catch {
      // Ignore executables that are not actually a compatible Python.
    }
  }
  return detected;
}

export function buildPipInstallArgs(useUserSite: boolean): string[] {
  return [
    '-m',
    'pip',
    'install',
    ...(useUserSite ? ['--user'] : []),
    'jupyter_server',
    'jupyter-client',
    'ipykernel',
    'ipywidgets',
  ];
}

async function installServer(
  ctx: Pick<ActivateCtx['services'], 'workspacePath' | 'log'>,
  requestedPython?: string,
): Promise<{ python: DetectedPython; output: string }> {
  const pythons = await detectPythons(ctx.workspacePath);
  const python = requestedPython
    ? pythons.find((candidate) => candidate.executable === requestedPython)
    : pythons[0];
  if (!python) {
    throw new Error(
      requestedPython
        ? 'The requested Python was not returned by list_pythons. Refresh detection and try again.'
        : 'No compatible Python installation was detected. Install Python 3, then retry detection.',
    );
  }
  if (!python.hasPip) {
    throw new Error(`Python ${python.version} at ${python.executable} does not provide pip.`);
  }
  const insideEnvironment = python.source === 'workspace' || python.source === 'environment';
  ctx.log('info', `[jupyter] installing server packages with ${python.executable}`);
  const result = await runCommand(
    python.executable,
    buildPipInstallArgs(!insideEnvironment),
    10 * 60_000,
  );
  if (result.code !== 0) {
    throw new Error(`pip install failed (${result.code}).\n${tail(result.stderr || result.stdout, 8_000)}`);
  }
  const refreshed = (await detectPythons(ctx.workspacePath)).find(
    (candidate) => candidate.executable === python.executable,
  );
  if (!refreshed?.hasJupyterServer) {
    throw new Error('pip completed, but jupyter_server is still not importable in the selected Python.');
  }
  return { python: refreshed, output: tail(result.stdout || result.stderr, 8_000) };
}

async function ensureServer(
  ctx: Pick<ActivateCtx['services'], 'workspacePath' | 'dataDir' | 'log'>,
  params: EnsureServerParams,
): Promise<ManagedServerInfo> {
  if (managedServer && await isServerHealthy(managedServer.info)) {
    const selectedPythonChanged = !!params.pythonPath &&
      params.pythonPath !== managedServer.info.pythonPath;
    if (!selectedPythonChanged) {
      touchIdleTimer();
      return managedServer.info;
    }
    await stopServer();
  }
  if (managedServer) {
    await stopServer();
  }

  const rootDir = resolveWorkspaceRoot(ctx.workspacePath, params.rootDir);
  const port = normalizePort(params.port) ?? await pickAvailablePort();
  const token = resolveServerToken(params);
  const startupTimeoutMs = normalizeTimeout(params.startupTimeoutMs);
  const args = buildJupyterServerArgs({ rootDir, port, token });
  const logPath = path.join(ctx.dataDir, 'jupyter-server.log');
  const startedAt = new Date().toISOString();
  const detected = await detectPythons(ctx.workspacePath);
  const requested = params.pythonPath
    ? detected.find((python) => python.executable === params.pythonPath)
    : undefined;
  if (params.pythonPath && !requested) {
    throw new Error('The selected Python is no longer available. Refresh Python detection and retry.');
  }
  const runnable = (requested ? [requested] : detected).filter((python) => python.hasJupyterServer);
  const candidates = runnable.map((python) => ({
    command: python.executable,
    args: ['-m', 'jupyter', ...args],
    pythonPath: python.executable,
  }));
  if (candidates.length === 0) {
    throw new Error(
      detected.length === 0
        ? 'No Python 3 installation was detected. Install Python, then use the Jupyter runtime setup panel to retry.'
        : 'Python was detected, but jupyter_server is not installed. Use Install Jupyter in the runtime setup panel.',
    );
  }
  const errors: string[] = [];

  for (const candidate of candidates) {
    if (shuttingDown) throw new Error('Jupyter backend is shutting down.');
    const logStream = createWriteStream(logPath, { flags: 'a' });
    const state = spawnServer({
      command: candidate.command,
      args: candidate.args,
      env: buildChildEnv(),
      info: {
        baseUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}`,
        token,
        pid: null,
        rootDir,
        logPath,
        startedAt,
        command: `${candidate.command} ${candidate.args.join(' ')}`,
        pythonPath: candidate.pythonPath,
      },
      logStream,
      log: ctx.log,
      dataDir: ctx.dataDir,
      port,
    });
    startingState = state;

    try {
      await waitForServer(state, startupTimeoutMs);
      if (shuttingDown) throw new Error('Jupyter backend is shutting down.');
      managedServer = state;
      startingState = null;
      touchIdleTimer();
      ctx.log('info', `[jupyter] managed server ready: ${state.info.baseUrl}`);
      return state.info;
    } catch (error) {
      errors.push(`${candidate.command}: ${error instanceof Error ? error.message : String(error)}`);
      await stopState(state);
      if (startingState === state) startingState = null;
    }
  }

  throw new Error(`Failed to start Jupyter. Attempts: ${errors.join('; ')}`);
}

function spawnServer(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  info: ManagedServerInfo;
  logStream: WriteStream;
  log: ActivateCtx['services']['log'];
  dataDir: string;
  port: number;
}): ServerState {
  const child = spawn(options.command, options.args, {
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(options.logStream, { end: false });
  child.stderr.pipe(options.logStream, { end: false });
  const state: ServerState = {
    process: child,
    logStream: options.logStream,
    info: { ...options.info, pid: child.pid ?? null },
    stopping: false,
    startError: null,
    exit: null,
  };
  // Recorded before the server is known to be healthy: a spawn that hangs during
  // startup is exactly the kind that gets abandoned and needs reclaiming later.
  if (child.pid != null) {
    recordServer(options.dataDir, {
      pid: child.pid,
      port: options.port,
      token: options.info.token,
      rootDir: options.info.rootDir,
      startedAt: options.info.startedAt,
    });
  }
  child.once('error', (error) => {
    state.startError = error;
  });
  child.once('exit', (code, signal) => {
    state.exit = { code, signal };
    lastExit = state.exit;
    if (child.pid != null) forgetServer(options.dataDir, child.pid);
    if (managedServer === state) {
      managedServer = null;
      serverLeases.clear();
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }
    if (!state.stopping) {
      options.log('warn', `[jupyter] server exited: code=${code} signal=${signal}`);
    }
  });
  return state;
}

async function waitForServer(state: ServerState, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastError = 'not ready';
  while (Date.now() - started < timeoutMs) {
    if (state.startError) throw state.startError;
    if (state.exit) {
      throw new Error(`process exited before startup: code=${state.exit.code} signal=${state.exit.signal}`);
    }
    try {
      if (await isServerHealthy(state.info)) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for /api/status (${lastError})`);
}

async function isServerHealthy(info: ManagedServerInfo): Promise<boolean> {
  const response = await fetch(withToken(`${info.baseUrl}/api/status`, info.token));
  return response.ok;
}

async function fetchKernelSpecs(info: ManagedServerInfo): Promise<Array<{
  name: string;
  displayName: string;
  language: string;
}>> {
  const response = await fetch(withToken(`${info.baseUrl}/api/kernelspecs`, info.token));
  if (!response.ok) {
    throw new Error(`Failed to list kernels (${response.status}).`);
  }
  const body = await response.json() as {
    kernelspecs?: Record<string, {
      spec?: {
        display_name?: string;
        language?: string;
      };
    }>;
  };
  return Object.entries(body.kernelspecs ?? {}).map(([name, spec]) => ({
    name,
    displayName: spec.spec?.display_name ?? name,
    language: spec.spec?.language ?? '',
  }));
}

async function getServerStatus() {
  if (!managedServer) {
    return { running: false, lastExit };
  }
  const healthy = await isServerHealthy(managedServer.info).catch(() => false);
  return {
    running: healthy,
    server: redactServerInfo(managedServer.info),
    lastExit,
  };
}

async function stopServer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const state = managedServer;
  managedServer = null;
  serverLeases.clear();
  if (!state) {
    return { stopped: false, lastExit };
  }
  await stopState(state);
  return { stopped: true, lastExit };
}

function touchIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  const now = Date.now();
  for (const [leaseId, lease] of serverLeases) {
    if (lease.expiresAt <= now) serverLeases.delete(leaseId);
  }
  if (!managedServer) {
    idleTimer = null;
    return;
  }
  const nextLeaseExpiry = Math.min(
    ...Array.from(serverLeases.values(), (lease) => lease.expiresAt),
  );
  const delayMs = serverLeases.size > 0
    ? Math.max(1_000, nextLeaseExpiry - now)
    : IDLE_SHUTDOWN_MS;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (serverLeases.size > 0) {
      touchIdleTimer();
    } else {
      void stopServer();
    }
  }, delayMs);
  idleTimer.unref?.();
}

async function stopState(state: ServerState): Promise<void> {
  state.stopping = true;
  if (state.exit == null) {
    state.process.kill('SIGTERM');
    await Promise.race([
      waitForExit(state),
      delay(2000),
    ]);
    if (state.exit == null) {
      state.process.kill('SIGKILL');
      await Promise.race([waitForExit(state), delay(1000)]);
    }
  }
  state.logStream.end();
}

function waitForExit(state: ServerState): Promise<void> {
  if (state.exit) return Promise.resolve();
  return new Promise((resolve) => state.process.once('exit', () => resolve()));
}

function redactServerInfo(info: ManagedServerInfo) {
  return {
    ...info,
    token: info.token ? '[redacted]' : '',
    command: info.command.replace(
      /--IdentityProvider\.token=\S+/,
      '--IdentityProvider.token=[redacted]',
    ),
  };
}

function withToken(url: string, token: string): string {
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}

function buildChildEnv(): NodeJS.ProcessEnv {
  const commonPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const currentPath = process.env.PATH ?? '';
  const pathParts = new Set([...currentPath.split(path.delimiter).filter(Boolean), ...commonPaths]);
  return {
    ...process.env,
    PATH: Array.from(pathParts).join(path.delimiter),
  };
}

function normalizePort(port: number | undefined): number | null {
  if (port == null) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port must be an integer from 1 to 65535.');
  }
  return port;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs == null) return DEFAULT_STARTUP_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs)) return DEFAULT_STARTUP_TIMEOUT_MS;
  return Math.max(1000, Math.min(Math.floor(timeoutMs), 60_000));
}

function pickAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address) {
          resolve(address.port);
        } else {
          reject(new Error('Could not allocate a local port.'));
        }
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: buildChildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer): string =>
      tail(current + chunk.toString(), 256_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function tail(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(-maxChars);
}
