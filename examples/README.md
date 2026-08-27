# Example notebooks

Demo and fixture notebooks for the Nimbalyst Jupyter extension.

**All three ship with their outputs saved**, so they render fully with no kernel attached. That matters for demos and screenshots, and it means the output-rendering and projection paths can be exercised on a machine with no Python runtime configured.

| Notebook | Cells | Shows |
| --- | --- | --- |
| [nimbalyst-integration-demo.ipynb](nimbalyst-integration-demo.ipynb) | 6 | Markdown, stdout, rich HTML + SVG output, and a deliberately bulky output cell |
| [data-analysis-demo.ipynb](data-analysis-demo.ipynb) | 12 | pandas DataFrame HTML tables, an inline matplotlib PNG, a `.style` gradient table |
| [error-recovery-demo.ipynb](error-recovery-demo.ipynb) | 16 | Every way a cell can fail: stderr, warnings, partial output then raise, deep tracebacks, `KeyError`, failed assertion |

## data-analysis-demo.ipynb

The "looks good in a screenshot" one. Six weeks of synthetic deploy telemetry across three services, seeded so the checked-in outputs are reproducible.

Good for exercising:

- `jupyter.preview_dataframe` and `jupyter.inspect_variable` on `frame` / `summary`
- `jupyter.get_cell_output` with `includeImages=true` on the plot cell — the PNG is ~84 KB of base64, which is exactly the payload that should never reach an agent's context inline
- `jupyter.get_notebook_projection`, which currently compresses this file from 99,497 to 4,399 bytes with every cell source intact

## error-recovery-demo.ipynb

Every code cell fails, each in a different way. This is the fixture for error-handling work.

The cell worth looking at first prints three lines of real work and *then* raises — partial output must survive alongside the error, both in the rendered notebook and through `jupyter.get_cell_output`. The last cell succeeds, so the notebook also shows what run-all does after a failure.

Tracebacks carry ANSI colour codes, as IPython produces them.

## Regenerating

The outputs were produced by actually executing the notebooks (via `nbclient` against a Python 3.11 kernel with pandas and matplotlib), not hand-written. To refresh them, run the notebooks and save — or execute them headlessly:

```bash
jupyter nbconvert --execute --inplace --allow-errors examples/error-recovery-demo.ipynb
```

Keep the on-disk format as 1-space-indented JSON with a trailing newline, which is what `services/notebookSerializer.ts` writes and what `nbconvert` produces by default. Otherwise opening and saving in Nimbalyst shows a whole-file diff.
