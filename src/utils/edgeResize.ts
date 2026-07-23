// Shared width-drag loop for edge-resizable rails and drawers. During the
// drag the width is handed to `apply` (typically a direct DOM write so large
// subtrees don't reconcile every frame); `commit` fires once on mouse up.
export const beginEdgeDrag = (options: {
  startX: number;
  startWidth: number;
  /** 1 when dragging right widens (left-anchored), -1 when it narrows. */
  direction: 1 | -1;
  clamp: (width: number) => number;
  apply: (width: number) => void;
  commit: (width: number) => void;
}): void => {
  const { startX, startWidth, direction, clamp, apply, commit } = options;
  let pending = startWidth;
  let frameId: number | null = null;

  const frame = () => {
    frameId = null;
    apply(pending);
  };

  const onMouseMove = (ev: MouseEvent) => {
    pending = clamp(startWidth + direction * (ev.clientX - startX));
    if (frameId === null) frameId = requestAnimationFrame(frame);
  };

  const onMouseUp = () => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    if (frameId !== null) cancelAnimationFrame(frameId);
    commit(pending);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
};
