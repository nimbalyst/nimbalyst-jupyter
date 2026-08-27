# Security Policy

## Reporting a vulnerability

Report vulnerabilities through GitHub private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Please do not open a public issue for a security problem.

Include the extension version (`manifest.json`), your operating system, and a description of what an attacker gains. A notebook file or minimal reproduction that triggers the behaviour is the most useful thing you can attach.

We aim to acknowledge a report within a few business days.

## Supported versions

Fixes land on the latest release. There are no maintained older release branches.

## Threat model

This extension runs inside Nimbalyst as a custom `.ipynb` editor, and it executes Python. Two categories of input are untrusted:

1. **Notebook files.** An `.ipynb` may come from anywhere and carries arbitrary HTML, SVG, and JavaScript in its saved outputs, which the renderer displays.
2. **Workspace configuration.** Workspace settings travel with the workspace, so `manualServerUrl`, `manualServerRoot`, and `pythonPath` are attacker-controllable whenever the workspace itself is.

Executing a notebook's code cells is not a vulnerability. That is the point of the extension, and it is a deliberate user action.

## Invariants

These properties are load-bearing. A change that weakens one is a security regression, not a refactor. `AGENTS.md` describes where each is enforced.

- **Loopback only.** `assertLoopbackServerConfig` gates every server config, including one read from workspace configuration. A non-loopback `manualServerUrl` fails closed with a visible error; it never silently falls back to the managed server.
- **Server root stays in the workspace.** `resolveWorkspaceRoot` bounds the managed server's root directory.
- **The managed server always has a token.** `allowTokenless` and an explicit `token` are absent from the `ensure_server` MCP schema and ignored unless `NIMBALYST_JUPYTER_DEV_UNSAFE_SERVER=1`. A tokenless local Jupyter is arbitrary code execution for anything else on the machine.
- **Read-only notebooks refuse writes on the AI path.** `requireWritableJupyterEditorAPI` blocks every `editor-write` tool, and `createEditorAPI` guards the same methods as a backstop. `NotebookModel.readOnly` alone does not stop `sharedModel` writes.
- **Bundled parsers stay patched.** The `overrides` block in `package.json` pins `sanitize-html`, `mermaid`, `dompurify`, `postcss`, `nanoid`, and `fast-uri` past known advisories. All six are bundled into `dist/index.js` and process untrusted notebook content. `npm audit --omit=dev` should report zero.
- **No orphaned servers.** Three independent layers stop a spawned `jupyter-server` (process teardown hooks, a pid registry reclaimed on next launch, and Jupyter's own idle culling), because a child process outlives its parent.

## Debug flags

`NIMBALYST_JUPYTER_DEV_UNSAFE_SERVER=1` re-enables the `allowTokenless` and explicit `token` parameters on `ensure_server`. It exists for development against a throwaway workspace. Do not set it on a machine you care about.
