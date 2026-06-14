import { Component, type ErrorInfo, type ReactNode } from "react";

interface DockErrorBoundaryProps {
  children: ReactNode;
  /** 错误时显示的回退内容；不传则使用内置"工作区布局重置"提示 */
  fallback?: (reset: () => void, error: Error) => ReactNode;
}

interface DockErrorBoundaryState {
  error: Error | null;
}

/**
 * 包裹 dockview 容器，捕获 fromJSON / ReactPart 生命周期抛出的
 * "resource already disposed" 等不可恢复错误，避免整个 React 树崩溃。
 * 触发后展示"重置布局"按钮，让用户点一次即可清除 localStorage 中的脏 layout。
 */
export class DockErrorBoundary extends Component<
  DockErrorBoundaryProps,
  DockErrorBoundaryState
> {
  state: DockErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): DockErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[DockErrorBoundary] dockview crashed", error, info);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const fallback = this.props.fallback;
    if (fallback) return fallback(this.handleReset, error);
    return (
      <div className="dock-error-boundary">
        <div className="dock-error-boundary__title">工作区布局加载失败</div>
        <div className="dock-error-boundary__message">
          已自动从旧版本恢复；点击下方按钮重新打开当前工作区。
        </div>
        <button
          type="button"
          className="dock-error-boundary__action"
          onClick={this.handleReset}
        >
          重新打开
        </button>
      </div>
    );
  }
}
