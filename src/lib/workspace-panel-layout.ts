export function getWorkspacePanelBounds(viewport: number, sidebar: number) {
  const available = viewport <= 900 ? viewport - 56 : viewport - sidebar - 360;
  const max = Math.max(0, Math.min(960, available));
  return { min: Math.min(380, max), max };
}

export function constrainPanelWidth(width: number, bounds: { min: number; max: number }) {
  return Math.min(bounds.max, Math.max(bounds.min, width));
}
