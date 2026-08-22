import { describe, expect, it } from 'vitest';

import {
  buildInspectVariableSnippet,
  parseIntrospectionResult,
} from '../src/services/kernelIntrospection';

describe('kernel introspection', () => {
  it('parses the JSON line out of noisy stdout and rejects unsafe paths', () => {
    const parsed = parseIntrospectionResult([
      {
        output_type: 'stream',
        name: 'stdout',
        text: ['FutureWarning: something\n', '{"name": "df", "type": "DataFrame"}\n'],
      },
    ]);

    expect(parsed).toEqual({ ok: true, value: { name: 'df', type: 'DataFrame' } });
    expect(() => buildInspectVariableSnippet('df; import os')).toThrow(/Invalid variable path/);
    expect(buildInspectVariableSnippet('df.columns')).toContain('"df.columns"');
  });
});
