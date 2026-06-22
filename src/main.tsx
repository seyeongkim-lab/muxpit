import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/linear.css";
import { App } from "./App";
import { installNavigatorLocaleFallback } from "./utils/locale";

type BootErrorBoundaryProps = {
  children: ReactNode;
};

type BootErrorBoundaryState = {
  error: unknown;
};

class BootErrorBoundary extends Component<BootErrorBoundaryProps, BootErrorBoundaryState> {
  state: BootErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BootErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error("[wmux] render failed:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 16,
          color: "#f38ba8",
          font: "13px monospace",
          whiteSpace: "pre-wrap",
        }}>
          {`[wmux render error] ${this.state.error instanceof Error ? this.state.error.message : String(this.state.error)}`}
        </div>
      );
    }

    return this.props.children;
  }
}

installNavigatorLocaleFallback();

const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);

root.render(
  <BootErrorBoundary>
    <App />
  </BootErrorBoundary>,
);
