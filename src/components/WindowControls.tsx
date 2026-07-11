interface WindowControlsProps {
  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;
}

export const WindowControls = ({
  onMinimize,
  onMaximize,
  onClose,
}: WindowControlsProps) => (
  <div className="wmux-window-controls" onDoubleClick={(event) => event.stopPropagation()}>
    <button
      type="button"
      className="wmux-titlebar-btn"
      onClick={onMinimize}
      title="Minimize"
      aria-label="Minimize"
    >
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <path d="M2.5 7.5h9" />
      </svg>
    </button>
    <button
      type="button"
      className="wmux-titlebar-btn"
      onClick={onMaximize}
      title="Maximize"
      aria-label="Maximize"
    >
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <rect x="2.75" y="2.75" width="8.5" height="8.5" />
      </svg>
    </button>
    <button
      type="button"
      className="wmux-titlebar-btn wmux-titlebar-close"
      onClick={onClose}
      title="Close"
      aria-label="Close"
    >
      <svg viewBox="0 0 14 14" aria-hidden="true">
        <path d="m3 3 8 8M11 3l-8 8" />
      </svg>
    </button>
  </div>
);
