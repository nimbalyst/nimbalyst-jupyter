/**
 * Stand-in for `@nimbalyst/runtime`, which the host injects at runtime and the
 * build marks external, so it is not installed here. Anything that imports the
 * `@nimbalyst/extension-sdk` barrel in a test pulls it in transitively; these
 * are the only two symbols the barrel reaches for.
 */

export function useDocumentPath(): string | undefined {
  return undefined;
}

export function MaterialSymbol(): null {
  return null;
}
