import { Component, type ErrorInfo, type ReactNode } from "react";

interface DockPanelErrorBoundaryProps {
  tabId: string;
  children: ReactNode;
}

interface DockPanelErrorBoundaryState {
  error: Error | null;
}

/**
 * 单 panel 内容错误边界：隔离业务渲染异常，避免冒泡到 DockErrorBoundary
 * 把整棵 dockview（含顶栏 / 窗口控制）一起拆掉。
 */
export class DockPanelErrorBoundary extends Component<
  DockPanelErrorBoundaryProps,
  DockPanelErrorBoundaryState
> {
  state: DockPanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): DockPanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[DockPanelErrorBoundary] panel "${this.props.tabId}" crashed`,
      error,
      info,
    );
  }

  componentDidUpdate(prevProps: DockPanelErrorBoundaryProps): void {
    if (prevProps.tabId !== this.props.tabId && this.state.error) {
      this.setState({ error: null });
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="dock-panel-error-boundary">
        <div className="dock-panel-error-boundary__title">面板渲染失败</div>
        <div className="dock-panel-error-boundary__message">
          {error.message || "未知错误"}
        </div>
        <button
          type="button"
          className="dock-panel-error-boundary__action"
          onClick={this.handleRetry}
        >
          重试
        </button>
      </div>
    );
  }
}
