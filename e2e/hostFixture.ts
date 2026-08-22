/**
 * CDP fixture for the live-host suite.
 *
 * This mirrors `@nimbalyst/extension-sdk/testing`, which we cannot import here:
 * the SDK ships that entry point as ESM with only an `import` condition, and
 * ESM resolution ignores the NODE_PATH the host runner sets to share its own
 * Playwright. See e2e/package.json for the full explanation. Keeping a small
 * CommonJS mirror is what lets these specs run as committed files rather than
 * as inline scripts.
 *
 * Behavior is intentionally identical to the SDK fixture: attach to the running
 * Nimbalyst instance over CDP, pick the window whose workspace contains this
 * test file, and never close the browser -- it is the user's app.
 */

import { test as base, expect } from '@playwright/test';
import { chromium } from 'playwright';
import type { Locator, Page } from 'playwright';

const CDP_ENDPOINT = `http://localhost:${process.env.NIMBALYST_CDP_PORT || '9222'}`;

export const test = base.extend<{ page: Page }>({
  page: async ({}, use, testInfo) => {
    let browser;
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    } catch (error) {
      throw new Error(
        `Could not connect to Nimbalyst via CDP at ${CDP_ENDPOINT}.\n` +
          `Start Nimbalyst in dev mode (npm run dev) before running the live suite.\n` +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // The spec lives inside the workspace, so the window whose workspacePath is
    // a prefix of this file's directory is the one under test. This matters when
    // several Nimbalyst windows are open on different projects.
    const testFileDir = testInfo.file
      ? testInfo.file.substring(0, testInfo.file.lastIndexOf('/'))
      : undefined;

    let target: Page | undefined;
    for (const context of browser.contexts()) {
      for (const candidate of context.pages()) {
        const url = candidate.url();
        if (url.startsWith('devtools://') || url.includes('mode=capture')) continue;
        try {
          const workspacePath = await candidate.evaluate(async () =>
            (
              await (window as unknown as {
                electronAPI: { getInitialState?: () => Promise<{ workspacePath?: string }> };
              }).electronAPI.getInitialState?.()
            )?.workspacePath,
          );
          if (workspacePath && testFileDir && testFileDir.startsWith(workspacePath)) {
            target = candidate;
            break;
          }
        } catch {
          // A window that cannot answer is not our window; keep looking.
        }
      }
      if (target) break;
    }

    if (!target) {
      throw new Error(
        `No Nimbalyst window found via CDP for this workspace.\n` +
          (testFileDir ? `Looking for a window whose workspace contains: ${testFileDir}\n` : '') +
          `Open this project in Nimbalyst and retry.`,
      );
    }

    await use(target);

    // Detach only. Closing would close the user's app.
    void browser.close();
  },
});

export { expect };

/** Locator for this extension's editor container for a specific file. */
export function extensionEditor(page: Page, extensionId: string, filePath?: string): Locator {
  if (!filePath) return page.locator(`[data-extension-id="${extensionId}"]`).first();
  const escaped = filePath.replace(/([\\/"'[\](){}|^$*+?.])/g, '\\$1');
  return page.locator(`[data-extension-id="${extensionId}"][data-file-path="${escaped}"]`);
}

export interface ExtensionToolResult {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
}

/**
 * Invoke an extension AI tool through the renderer's tool bridge -- the same
 * path the agent's MCP calls take, minus the MCP transport. When `filePath`
 * names a file that is not open, the host mounts a hidden editor for it, which
 * is exactly how the tools behave in production.
 */
export async function callExtensionTool(
  page: Page,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<ExtensionToolResult> {
  return await page.evaluate(
    async ({ toolName, args }) => {
      const bridge = (window as unknown as {
        __nimbalyst_extension_tools__?: {
          executeExtensionTool: (
            name: string,
            args: Record<string, unknown>,
            context: Record<string, unknown>,
          ) => Promise<ExtensionToolResult>;
        };
      }).__nimbalyst_extension_tools__;
      if (!bridge) {
        return {
          success: false,
          error: '__nimbalyst_extension_tools__ not found. Is Nimbalyst running in dev mode?',
        };
      }
      return await bridge.executeExtensionTool(toolName, args, {});
    },
    { toolName, args },
  );
}

/** Every MCP tool definition currently registered by extensions. */
export async function listExtensionTools(
  page: Page,
): Promise<Array<{ name: string; description: string }>> {
  return await page.evaluate(async () => {
    const bridge = (window as unknown as {
      __nimbalyst_extension_tools__?: {
        getMCPToolDefinitions: () => Promise<Array<{ name: string; description: string }>>;
      };
    }).__nimbalyst_extension_tools__;
    if (!bridge) return [];
    return await bridge.getMCPToolDefinitions();
  });
}
