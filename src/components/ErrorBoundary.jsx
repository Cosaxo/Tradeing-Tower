import { Component } from "react";

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep a breadcrumb for diagnostics without crashing the console in prod.
    if (typeof console !== "undefined") {
      console.error("[ErrorBoundary]", error, info?.componentStack);
    }
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-6">
          <div className="max-w-xl w-full rounded border border-red-800 bg-red-950 p-4 flex flex-col gap-3">
            <div className="font-syne text-lg text-red-300">Something broke.</div>
            <pre className="text-[10px] font-mono text-red-200 whitespace-pre-wrap overflow-auto max-h-64">
              {String(this.state.error?.stack ?? this.state.error)}
            </pre>
            <div className="flex gap-2">
              <button
                onClick={this.reset}
                className="text-xs font-mono px-3 py-1 rounded border border-emerald-700 bg-emerald-950 text-emerald-300 hover:bg-emerald-900"
              >
                Try again
              </button>
              <button
                onClick={() => {
                  try {
                    window.localStorage.clear();
                  } catch {
                    /* ignore */
                  }
                  window.location.reload();
                }}
                className="text-xs font-mono px-3 py-1 rounded border border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-800"
              >
                Clear storage + reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
