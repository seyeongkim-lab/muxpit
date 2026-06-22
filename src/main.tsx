import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/linear.css";
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

type TauriRuntimeHost = {
  __TAURI_INTERNALS__?: unknown;
};

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" &&
  typeof (window as TauriRuntimeHost).__TAURI_INTERNALS__ === "object";

const appModule = isTauriRuntime()
  ? import("./App").then(({ App }) => ({ Component: App }))
  : import("./WebApp").then(({ WebApp }) => ({ Component: WebApp }));

void appModule
  .then(({ Component }) => {
    root.render(
      <BootErrorBoundary>
        <Component />
      </BootErrorBoundary>,
    );
  })
  .catch((error) => {
    console.error("[wmux] boot failed:", error);
    rootElement.textContent = `[wmux boot error] ${error instanceof Error ? error.message : String(error)}`;
    rootElement.style.cssText = "padding:16px;color:#f38ba8;font:13px monospace;white-space:pre-wrap;";
  });
