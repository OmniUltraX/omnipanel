import { Component, type ErrorInfo, type ReactNode } from "react";

interface PanelErrorBoundaryProps {
  children: ReactNode;
  /** 回退区标题，例如「插件工作台渲染失败」。 */
  title: string;
  retryLabel?: string;
}

interface PanelErrorBoundaryState {
  error: Error | null;
}

/**
 * 路由/面板级错误边界：拦住业务渲染异常，避免整棵应用被卸载。
 * 诊断遮罩点「清除」只摘掉 overlay，不会恢复已崩的 React 树；有了本边界后
 * 外壳（侧栏、顶栏）和工作台回退 UI 会留下来。
 */
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[PanelErrorBoundary]", this.props.title, error, info);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="dock-panel-error-boundary" role="alert">
        <div className="dock-panel-error-boundary__title">{this.props.title}</div>
        <div className="dock-panel-error-boundary__message">{error.message || "未知错误"}</div>
        <button
          type="button"
          className="dock-panel-error-boundary__action"
          onClick={this.handleRetry}
        >
          {this.props.retryLabel ?? "重试"}
        </button>
      </div>
    );
  }
}
