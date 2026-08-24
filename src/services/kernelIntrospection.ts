/**
 * Canned Python snippets for kernel-state introspection tools
 * (`jupyter.list_variables`, `jupyter.inspect_variable`,
 * `jupyter.preview_dataframe`) plus the parser for their output.
 *
 * Design constraints:
 *   - Snippets run through the transient execute path
 *     (`SessionContextManager.executeCode`, store_history=false) so they
 *     never bump the execution counter or appear as `In[n]` history.
 *   - Each snippet defines one dunder-prefixed helper, calls it, then
 *     deletes it — the only namespace residue is during the call.
 *   - Results are printed as a single JSON document on stdout; the
 *     parser reads the last JSON-looking line so stray warnings printed
 *     by user-installed libraries don't break parsing.
 *   - Snippets must be side-effect-free against user data. Attribute
 *     paths are validated in JS before interpolation; values are only
 *     read, never called (except len()/repr()/isna(), which are the
 *     accepted introspection surface).
 *
 * Kept DOM-free and kernel-free so unit tests can cover snippet
 * generation and parsing from Node.
 */

import type * as nbformat from '@jupyterlab/nbformat';

/** `df`, `obj.attr`, `obj.attr.sub` — no calls, no subscripts, no dunders. */
const VARIABLE_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function isValidVariablePath(name: string): boolean {
  return (
    VARIABLE_PATH_PATTERN.test(name) &&
    !name.split('.').some((part) => part.startsWith('__'))
  );
}

export function buildListVariablesSnippet(maxPreviewChars = 120): string {
  const limit = clampInt(maxPreviewChars, 20, 2000);
  return `
def __nimbalyst_list_variables():
    import json
    skip_types = {'module', 'function', 'builtin_function_or_method', 'method', 'type', 'ABCMeta'}
    skip_names = {'In', 'Out', 'exit', 'quit', 'get_ipython', 'open'}
    entries = []
    for name, value in list(globals().items()):
        if name.startswith('_') or name in skip_names:
            continue
        type_name = type(value).__name__
        if type_name in skip_types:
            continue
        entry = {'name': name, 'type': type_name}
        try:
            preview = repr(value)
            entry['preview'] = preview[:${limit}] + ('...' if len(preview) > ${limit} else '')
        except Exception:
            entry['preview'] = '<repr failed>'
        shape = getattr(value, 'shape', None)
        if shape is not None:
            try:
                entry['shape'] = str(shape)
            except Exception:
                pass
        else:
            try:
                entry['length'] = len(value)
            except Exception:
                pass
        entries.append(entry)
    print(json.dumps({'variables': entries}))
__nimbalyst_list_variables()
del __nimbalyst_list_variables
`.trim();
}

/**
 * Reports which Python is actually behind the kernel. Agents guess this
 * constantly and get it wrong — a notebook can be running a different
 * interpreter than the workspace `.venv` the agent just inspected on
 * disk. `packages` answers "is X importable, and at what version" in the
 * same round trip, which is the other half of the same question.
 */
export function buildRuntimeInfoSnippet(packages: string[] = []): string {
  for (const name of packages) {
    if (!isValidVariablePath(name)) {
      throw new Error(
        `Invalid package name "${name}". Use an importable module name such as "pandas" or "sklearn.tree".`,
      );
    }
  }
  const packageList = JSON.stringify(packages.slice(0, 20));
  return `
def __nimbalyst_runtime_info():
    import importlib, json, os, platform, sys
    info = {
        'executable': sys.executable,
        'pythonVersion': platform.python_version(),
        'implementation': platform.python_implementation(),
        'platform': platform.platform(),
        'cwd': os.getcwd(),
        'prefix': sys.prefix,
        'inVirtualEnv': sys.prefix != getattr(sys, 'base_prefix', sys.prefix),
        'virtualEnv': os.environ.get('VIRTUAL_ENV'),
        'condaEnv': os.environ.get('CONDA_DEFAULT_ENV'),
    }
    packages = {}
    for name in ${packageList}:
        try:
            module = importlib.import_module(name)
        except Exception as exc:
            packages[name] = {'importable': False, 'error': type(exc).__name__ + ': ' + str(exc)}
            continue
        entry = {'importable': True}
        version = getattr(module, '__version__', None)
        if version is not None:
            entry['version'] = str(version)
        location = getattr(module, '__file__', None)
        if location is not None:
            entry['path'] = str(location)
        packages[name] = entry
    if packages:
        info['packages'] = packages
    print(json.dumps(info))
__nimbalyst_runtime_info()
del __nimbalyst_runtime_info
`.trim();
}

export function buildInspectVariableSnippet(name: string, maxChars = 4000): string {
  if (!isValidVariablePath(name)) {
    throw new Error(
      `Invalid variable path "${name}". Use a plain name or dotted attribute path; for expressions use jupyter.execute.`,
    );
  }
  const limit = clampInt(maxChars, 100, 100_000);
  const nameLiteral = JSON.stringify(name);
  return `
def __nimbalyst_inspect_variable():
    import json
    name = ${nameLiteral}
    try:
        value = eval(name, globals())
    except Exception as exc:
        print(json.dumps({'name': name, 'error': type(exc).__name__ + ': ' + str(exc)}))
        return
    info = {'name': name, 'type': type(value).__name__}
    try:
        text = repr(value)
        info['repr'] = text[:${limit}] + ('...[truncated]' if len(text) > ${limit} else '')
    except Exception:
        info['repr'] = '<repr failed>'
    shape = getattr(value, 'shape', None)
    if shape is not None:
        try:
            info['shape'] = str(shape)
        except Exception:
            pass
    dtype = getattr(value, 'dtype', None)
    if dtype is not None:
        try:
            info['dtype'] = str(dtype)
        except Exception:
            pass
    try:
        info['length'] = len(value)
    except Exception:
        pass
    if isinstance(value, dict):
        info['keys'] = [str(k) for k in list(value.keys())[:50]]
    print(json.dumps(info))
__nimbalyst_inspect_variable()
del __nimbalyst_inspect_variable
`.trim();
}

export function buildPreviewDataFrameSnippet(name: string, rows = 10): string {
  if (!isValidVariablePath(name)) {
    throw new Error(
      `Invalid variable path "${name}". Use a plain name or dotted attribute path; for expressions use jupyter.execute.`,
    );
  }
  const rowCount = clampInt(rows, 1, 100);
  const nameLiteral = JSON.stringify(name);
  return `
def __nimbalyst_preview_dataframe():
    import json
    name = ${nameLiteral}
    rows = ${rowCount}
    try:
        value = eval(name, globals())
    except Exception as exc:
        print(json.dumps({'name': name, 'error': type(exc).__name__ + ': ' + str(exc)}))
        return
    info = {'name': name, 'type': type(value).__name__}
    handled = False
    try:
        import pandas as pd
        if isinstance(value, pd.DataFrame):
            info['shape'] = list(value.shape)
            info['dtypes'] = {str(c): str(t) for c, t in value.dtypes.items()}
            info['nullCounts'] = {str(c): int(n) for c, n in value.isna().sum().items()}
            info['head'] = value.head(rows).to_string()
            handled = True
        elif isinstance(value, pd.Series):
            info['shape'] = list(value.shape)
            info['dtype'] = str(value.dtype)
            info['nullCount'] = int(value.isna().sum())
            info['head'] = value.head(rows).to_string()
            handled = True
    except ImportError:
        pass
    if not handled:
        try:
            import polars as pl
            if isinstance(value, pl.DataFrame):
                info['shape'] = list(value.shape)
                info['dtypes'] = {c: str(t) for c, t in zip(value.columns, value.dtypes)}
                info['head'] = str(value.head(rows))
                handled = True
        except ImportError:
            pass
    if not handled:
        info['note'] = 'Not a pandas/polars DataFrame or Series; use jupyter.inspect_variable instead.'
    print(json.dumps(info))
__nimbalyst_preview_dataframe()
del __nimbalyst_preview_dataframe
`.trim();
}

/**
 * Pull the introspection JSON back out of transient-execute outputs.
 * Scans stdout stream text for the last line that parses as a JSON
 * object, so library warnings printed before/after don't break it.
 */
export function parseIntrospectionResult(
  outputs: nbformat.IOutput[],
): { ok: true; value: Record<string, unknown> } | { ok: false; raw: string } {
  const stdout = outputs
    .filter(
      (output): output is nbformat.IStream =>
        output.output_type === 'stream' && (output as nbformat.IStream).name === 'stdout',
    )
    .map((output) => joinMultiline(output.text))
    .join('');

  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
      }
    } catch {
      // keep scanning upward
    }
  }
  return { ok: false, raw: stdout };
}

function joinMultiline(text: nbformat.MultilineString): string {
  return Array.isArray(text) ? text.join('') : text;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(Math.floor(value), max));
}
