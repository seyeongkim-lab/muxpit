import { useEffect } from "react";
import { createPortal } from "react-dom";

interface ConfirmDialogProps {
  open: boolean;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmDialog = ({
  open,
  message,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) => {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  // Portal to document.body so ancestor stacking contexts / overflow can't
  // clip or offset the modal — it must center to the viewport.
  return createPortal(
    <div style={styles.overlay} onClick={onCancel}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div style={styles.message}>{message}</div>
        <div style={styles.actions}>
          <button style={styles.cancelBtn} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            style={{ ...styles.confirmBtn, ...(destructive ? styles.confirmDestructive : {}) }}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    backgroundColor: "rgba(0,0,0,0.65)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  panel: {
    minWidth: 320,
    maxWidth: 480,
    // Solid color (not the theme var, which can be semi-transparent and lets
    // the terminal grid bleed through the dialog).
    backgroundColor: "#1e1e2e",
    border: "1px solid #45475a",
    borderRadius: 8,
    padding: "20px 22px 16px",
    boxShadow: "0 10px 40px rgba(0,0,0,0.7)",
  },
  message: {
    color: "var(--wmux-text, #cdd6f4)",
    fontSize: 13,
    lineHeight: 1.5,
    marginBottom: 18,
    whiteSpace: "pre-wrap" as const,
  },
  actions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
  },
  cancelBtn: {
    background: "transparent",
    border: "1px solid var(--wmux-hairline-strong, #45475a)",
    borderRadius: 4,
    color: "var(--wmux-subtext, #a6adc8)",
    fontSize: 12,
    padding: "5px 14px",
    cursor: "pointer",
  },
  confirmBtn: {
    background: "var(--wmux-accent, #89b4fa)",
    border: "none",
    borderRadius: 4,
    color: "var(--wmux-bg, #1e1e2e)",
    fontSize: 12,
    fontWeight: 600,
    padding: "5px 14px",
    cursor: "pointer",
  },
  confirmDestructive: {
    background: "#f38ba8",
  },
};
