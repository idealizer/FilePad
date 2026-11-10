export const ICON_MIN = 72;
export const ICON_MAX = 256;
export const ICON_DEFAULT = 112;

export function iconSizeOf(value: unknown): number {
  const size = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : ICON_DEFAULT;
  return Math.min(ICON_MAX, Math.max(ICON_MIN, size));
}

export function iconMetrics(size: number): { cell: number; glyph: number; row: number } {
  const cell = iconSizeOf(size);
  const glyph = Math.round(cell * 0.64);
  return { cell, glyph, row: glyph + 52 };
}
