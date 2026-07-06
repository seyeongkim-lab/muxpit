import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/linear.css";
import { logError, logInfo } from "./utils/appLog";
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
    logError("render failed", error);
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

window.addEventListener("error", (event) => {
  logError(
    `window error: ${event.message || "unknown"}`,
    event.error ?? `${event.filename}:${event.lineno}:${event.colno}`,
  );
});

window.addEventListener("unhandledrejection", (event) => {
  logError("unhandled promise rejection", event.reason);
});

const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);

logInfo("frontend boot");

void import("./App")
  .then(({ App }) => {
    root.render(
      <BootErrorBoundary>
        <App />
      </BootErrorBoundary>,
    );
  })
  .catch((error) => {
    console.error("[wmux] boot failed:", error);
    logError("boot failed", error);
    rootElement.textContent = `[wmux boot error] ${error instanceof Error ? error.message : String(error)}`;
    rootElement.style.cssText = "padding:16px;color:#f38ba8;font:13px monospace;white-space:pre-wrap;";
  });
