// Workspace tabs snap to one of a few fixed widths instead of shrinking
// continuously: continuous flex-shrink recomputes on every pixel of
// available space, which reads as constant micro-jitter. Stepping keeps the
// width fixed within a tier and only changes it when tab count or window
// width crosses a threshold.
export const SESSION_TAB_WIDTH_TIERS = [160, 128, 96, 72] as const;

export const computeSessionTabWidth = (
  availableWidth: number,
  tabCount: number,
  gap = 3,
): number => {
  const tiers = SESSION_TAB_WIDTH_TIERS;
  if (tabCount <= 0 || availableWidth <= 0) return tiers[0];

  for (const tier of tiers) {
    const total = tabCount * tier + (tabCount - 1) * gap;
    if (total <= availableWidth) return tier;
  }
  return tiers[tiers.length - 1];
};
