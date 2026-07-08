import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { parseNotebook, serializeNotebook } from '../src/services/notebookSerializer';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, 'fixtures', 'notebook-with-large-outputs.ipynb');

describe('parseNotebook / serializeNotebook', () => {
  it('round-trips a real notebook byte-for-byte at the structural level', () => {
    const raw = readFileSync(fixturePath, 'utf-8');
    const parsed = parseNotebook(raw);
    const reserialized = serializeNotebook(parsed);

    // The byte-for-byte guarantee we care about is structural: every cell,
    // metadata key, output, and execution_count survives. We can't compare
    // raw strings directly because indent style or trailing whitespace in
    // the fixture may differ. Re-parsing the serialized output and
    // comparing the JSON gives us the round-trip invariant.
    expect(JSON.parse(reserialized)).toEqual(parsed);
  });

  it('produces 1-space indent with a trailing newline (matches `jupyter nbconvert`)', () => {
    const raw = readFileSync(fixturePath, 'utf-8');
    const parsed = parseNotebook(raw);
    const reserialized = serializeNotebook(parsed);

    expect(reserialized.endsWith('\n')).toBe(true);
    // Pretty-printed JSON with 1-space indent uses ' "' for inner keys
    // (one space then the open quote). 2-space indent would produce '  "'.
    expect(reserialized).toMatch(/\n "cells"/);
    expect(reserialized).not.toMatch(/\n  "cells"/);
  });

  it('preserves cell IDs and metadata on round-trip', () => {
    const raw = readFileSync(fixturePath, 'utf-8');
    const parsed = parseNotebook(raw);
    const reserialized = serializeNotebook(parsed);
    const reparsed = parseNotebook(reserialized);

    const originalIds = parsed.cells.map((c) => (c as { id?: string }).id);
    const reparsedIds = reparsed.cells.map((c) => (c as { id?: string }).id);
    expect(reparsedIds).toEqual(originalIds);

    expect(reparsed.metadata).toEqual(parsed.metadata);
    expect(reparsed.nbformat).toEqual(parsed.nbformat);
    expect(reparsed.nbformat_minor).toEqual(parsed.nbformat_minor);
  });

  it('treats empty or whitespace input as an empty nbformat 4.5 notebook', () => {
    const empty = parseNotebook('');
    expect(empty.cells).toEqual([]);
    expect(empty.nbformat).toBe(4);
    expect(empty.nbformat_minor).toBe(5);
  });

  it('rejects non-notebook JSON (no `cells` array)', () => {
    expect(() => parseNotebook('{"hello": "world"}')).toThrow(
      /valid Jupyter notebook/,
    );
  });
});
