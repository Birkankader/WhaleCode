import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackLabel?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 p-8 text-wc-text-secondary min-h-[200px]">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg bg-wc-red-bg text-wc-red">
            !
          </div>
          <p className="text-sm font-medium text-wc-text-primary">
            {this.props.fallbackLabel || 'Something went wrong'}
          </p>
          <p className="text-xs text-center max-w-sm text-wc-text-muted">
            {this.state.error?.message || 'An unexpected error occurred in this view.'}
          </p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="text-xs font-semibold px-4 py-1.5 rounded-lg transition-all bg-wc-accent text-white hover:brightness-110"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="text-xs font-semibold px-4 py-1.5 rounded-lg transition-all bg-wc-surface text-wc-text-secondary border border-wc-border hover:bg-wc-surface-hover"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
