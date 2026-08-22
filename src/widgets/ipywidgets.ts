import * as base from '@jupyter-widgets/base';
import * as controls from '@jupyter-widgets/controls';
import {
  KernelWidgetManager,
  WidgetRenderer,
  output,
} from '@jupyter-widgets/jupyterlab-manager';
import type { RenderMimeRegistry } from '@jupyterlab/rendermime';
import type { SessionContext } from '@jupyterlab/apputils';
import type { Kernel } from '@jupyterlab/services';

import '@jupyter-widgets/base/css/index.css';
import '@jupyter-widgets/controls/css/widgets-base.css';

const WIDGET_MIME = 'application/vnd.jupyter.widget-view+json';

/** Bind ipywidgets output rendering and comms to the notebook's current kernel. */
export class IpywidgetsIntegration {
  private manager: KernelWidgetManager | null = null;

  constructor(
    private readonly sessionContext: SessionContext,
    private readonly rendermime: RenderMimeRegistry,
  ) {
    this.sessionContext.kernelChanged.connect(this.onKernelChanged, this);
    this.attach(this.sessionContext.session?.kernel ?? null);
  }

  dispose(): void {
    this.sessionContext.kernelChanged.disconnect(this.onKernelChanged, this);
    this.rendermime.removeMimeType(WIDGET_MIME);
    this.manager?.dispose();
    this.manager = null;
  }

  private onKernelChanged(
    _sender: SessionContext,
    args: { newValue: Kernel.IKernelConnection | null },
  ): void {
    this.attach(args.newValue);
  }

  private attach(kernel: Kernel.IKernelConnection | null): void {
    this.rendermime.removeMimeType(WIDGET_MIME);
    this.manager?.dispose();
    this.manager = null;
    if (!kernel) return;

    const manager = new KernelWidgetManager(kernel, this.rendermime);
    manager.register({
      name: '@jupyter-widgets/base',
      version: base.JUPYTER_WIDGETS_VERSION,
      exports: base as unknown as Record<string, typeof base.WidgetModel | typeof base.WidgetView>,
    });
    manager.register({
      name: '@jupyter-widgets/controls',
      version: controls.JUPYTER_CONTROLS_VERSION,
      exports: controls as unknown as Record<string, typeof base.WidgetModel | typeof base.WidgetView>,
    });
    manager.register({
      name: '@jupyter-widgets/output',
      version: output.OUTPUT_WIDGET_VERSION,
      exports: { OutputModel: output.OutputModel, OutputView: output.OutputView },
    });
    this.rendermime.addFactory({
      safe: false,
      mimeTypes: [WIDGET_MIME],
      createRenderer: (options) => new WidgetRenderer(options, manager),
    }, -10);
    this.manager = manager;
    void manager.restoreWidgets().catch(() => {
      // A kernel without widget support is valid; normal outputs still work.
    });
  }
}
