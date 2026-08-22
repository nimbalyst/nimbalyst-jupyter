import {
  CompletionProviderManager,
  ContextCompleterProvider,
  KernelCompleterProvider,
} from '@jupyterlab/completer';
import type { Notebook } from '@jupyterlab/notebook';
import type { RenderMimeRegistry } from '@jupyterlab/rendermime';
import type { SessionContext } from '@jupyterlab/apputils';

/** Kernel-backed Tab completion plus Shift+Tab inspect for a bare Notebook widget. */
export class KernelCodeAssistance {
  private readonly completionManager = new CompletionProviderManager();
  private inspectNode: HTMLDivElement | null = null;

  constructor(
    private readonly notebook: Notebook,
    private sessionContext: SessionContext,
    private readonly rendermime: RenderMimeRegistry,
  ) {
    this.completionManager.setTimeout(5_000);
    this.completionManager.registerProvider(new KernelCompleterProvider());
    this.completionManager.registerProvider(new ContextCompleterProvider());
    this.notebook.activeCellChanged.connect(this.updateCompletionContext, this);
    this.notebook.node.addEventListener('keydown', this.onKeyDown, true);
    void this.updateCompletionContext().catch(() => undefined);
  }

  updateSessionContext(sessionContext: SessionContext): void {
    this.sessionContext = sessionContext;
    void this.updateCompletionContext().catch(() => undefined);
  }

  dispose(): void {
    this.notebook.activeCellChanged.disconnect(this.updateCompletionContext, this);
    this.notebook.node.removeEventListener('keydown', this.onKeyDown, true);
    this.hideInspect();
    // The manager disposes its handler when the notebook widget is disposed.
  }

  private updateCompletionContext = async (): Promise<void> => {
    await this.completionManager.updateCompleter({
      widget: this.notebook,
      editor: this.notebook.activeCell?.editor ?? null,
      session: this.sessionContext.session,
      sanitizer: this.rendermime.sanitizer,
    });
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.hideInspect();
      return;
    }
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    const cell = this.notebook.activeCell;
    if (!cell?.editor || cell.model.type !== 'code') return;
    if (event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      void this.inspect().catch(() => this.hideInspect());
    } else {
      const source = cell.model.sharedModel.getSource();
      const cursor = cell.editor.getOffsetAt(cell.editor.getCursorPosition());
      const linePrefix = source.slice(0, cursor).split('\n').at(-1) ?? '';
      // Preserve CodeMirror's indentation behavior at the start of a line.
      if (linePrefix.trim().length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.hideInspect();
      this.completionManager.invoke(this.notebook.id);
    }
  };

  private async inspect(): Promise<void> {
    const cell = this.notebook.activeCell;
    const kernel = this.sessionContext.session?.kernel;
    const editor = cell?.editor;
    if (!cell || !editor || !kernel || cell.model.type !== 'code') return;
    const code = cell.model.sharedModel.getSource();
    const cursorPos = editor.getOffsetAt(editor.getCursorPosition());
    const reply = await kernel.requestInspect({ code, cursor_pos: cursorPos, detail_level: 0 });
    const content = reply.content;
    if (content.status !== 'ok' || !content.found) {
      this.hideInspect();
      return;
    }
    const text = content.data['text/plain'];
    if (typeof text !== 'string' && !Array.isArray(text)) return;
    this.hideInspect();
    const node = document.createElement('div');
    node.className = 'jupyter-kernel-inspect';
    node.textContent = Array.isArray(text) ? text.join('') : text;
    cell.node.appendChild(node);
    this.inspectNode = node;
  }

  private hideInspect(): void {
    this.inspectNode?.remove();
    this.inspectNode = null;
  }
}
