import type { ExtensionContext } from '@nimbalyst/extension-sdk';

let activeExtensionContext: ExtensionContext | null = null;

export function setExtensionContext(context: ExtensionContext | null): void {
  activeExtensionContext = context;
}

export function getExtensionContext(): ExtensionContext | null {
  return activeExtensionContext;
}
