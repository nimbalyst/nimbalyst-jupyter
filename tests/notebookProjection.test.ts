import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { buildNotebookProjection } from '../src/services/notebookProjection';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, 'fixtures', 'notebook-with-large-outputs.ipynb');

describe('buildNotebookProjection', () => {
  it('produces a compact projection that hides outputs but preserves cell sources', () => {
    const raw = readFileSync(fixturePath, 'utf-8');
    const result = buildNotebookProjection(raw);

    // The raw fixture contains a multi-KB base64 image; projection must
    // be significantly smaller. Outputs (esp. base64) are the whole
    // reason this helper exists.
    expect(result.projectedBytes).toBeLessThan(result.sourceBytes / 2);
    expect(result.content).not.toContain('iVBORw0KGgo'); // base64 PNG signature

    // Cell sources are preserved verbatim.
    expect(result.content).toContain("import json");
    expect(result.content).toContain("float('oops')");

    // Outputs are summarized, not inlined.
    expect(result.content).toMatch(/\[stdout hidden: \d+ lines/);
    expect(result.content).toMatch(/\[image\/png hidden:/);
    expect(result.content).toMatch(/\[ValueError:/);

    expect(result.cellCount).toBe(3);
    expect(result.outputsRedacted).toBe(true);
    expect(result.parseError).toBeUndefined();
  });
});
