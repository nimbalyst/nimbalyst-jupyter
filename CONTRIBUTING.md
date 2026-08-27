# Contributing

Thanks for your interest in improving the Nimbalyst Jupyter extension.

## What this project is

This is a **Nimbalyst extension**, not a standalone application. It contributes a
custom `.ipynb` editor to the Nimbalyst host. The editor host API, AI tool context,
filesystem access, and React itself all come from the host at runtime and are marked
`external` in the build. The contract is `@nimbalyst/extension-sdk`, a devDependency.

That means you need Nimbalyst installed to see your changes running. Unit tests,
typechecking, and the build all work without it.

## Getting set up

```bash
npm install
npm run build      # renderer + backend -> dist/ (index.js, index.css, backend.js)
npm run typecheck  # tsc --noEmit, strict, with noUnusedLocals/Parameters
npm test           # vitest run tests
```

Node 20 or newer. `npm run dev` rebuilds on change; `npm run build:debug` adds the
renderer sourcemap, which is ~13 MB and is not published.

To load a build into a running Nimbalyst dev instance, use the extension-dev MCP tools
(`extension_reload` / `extension_install`) pointed at this repo's `dist/`. Backend
changes need an extension disable/enable or an app restart to re-register MCP tools;
`extension_reload` alone is not enough.

In dev builds, backend modules require Nimbalyst to launch with
`NIMBALYST_ALLOW_DEV_BACKEND_MODULES=1`. Without it, start a local Jupyter server
yourself and use **Connect to a server I started** in the runtime setup panel.

## Before you open a pull request

- `npm run typecheck` and `npm test` both pass.
- `npm audit --omit=dev` reports zero vulnerabilities.
- `version` matches in `manifest.json` and `package.json`.
- New behaviour has a test. `tests/` runs under vitest with jsdom; keep anything you
  want testable free of DOM imports where you can, the way
  `src/services/notebookSerializer.ts` and `notebookProjection.ts` are.
- User-visible changes have a `CHANGELOG.md` entry under an Unreleased heading.

Please open an issue before starting anything large, so we can agree on the approach
before you spend time on it.

## Read AGENTS.md first

[`AGENTS.md`](./AGENTS.md) is the architecture guide, written for both humans and AI
coding agents (`CLAUDE.md` imports it, so edit `AGENTS.md` and both stay in sync). It
covers things that are not obvious from reading the code:

- The two distinct surfaces that read and write a notebook — the live editor via
  `NotebookModel`, and the on-disk projection used when the editor is closed — and why
  conflating them breaks things.
- Where the kernel actually comes from. There is no Pyodide kernel;
  `resolveServerConfig()` picks a manual, dev, or managed local `jupyter_server`.
- Why three independent layers exist to stop a spawned server, and why removing any
  one of them leaks a process that outlives the host.
- Build and bundle constraints, including why the externals list must never be
  hand-maintained (bundling a second `Y.Doc` breaks the host's `instanceof` checks).

## Security invariants

Some properties in this codebase are load-bearing, because the extension executes
Python and renders untrusted notebook content. Weakening one is a regression, not a
refactor. [`SECURITY.md`](./SECURITY.md) lists them and explains what each protects
against; the short version:

- Server configs are loopback-only, including ones read from workspace configuration.
- The managed server always has a token.
- Read-only notebooks refuse every `editor-write` AI tool. If you add a mutating tool,
  mark it `editor-write` and use `requireWritableJupyterEditorAPI` —
  `tests/aiTools.test.ts` asserts the exact list.
- The `overrides` block in `package.json` pins six bundled parsers past known
  advisories. Do not drop them.

If a change has to touch one of these, say so explicitly in the pull request
description and explain why it is safe.

## Tests

Unit tests live in `tests/` and run with `npm test`. One test first, then the rest of
the suite — it keeps the shape of the thing under test honest.

Live host end-to-end tests live in `e2e/*.spec.ts` and are **not** part of `npm test`.
They run only through the extension-dev MCP tool (`extension_test_run`) against a
running Nimbalyst window, and they assert against the built `dist/`, so build and
reload before trusting a result. `e2e/README.md` explains the CommonJS scoping that
makes the host's Playwright resolvable, and the rules these unsandboxed tests follow.

## Commit messages

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`) with a
subject line that describes the user-visible effect. Explain in the body what was
wrong and why the fix is the right shape, not just what the diff does.

## License

By contributing, you agree that your contributions are licensed under the MIT License,
the same as the rest of the project.
