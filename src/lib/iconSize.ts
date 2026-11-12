export const ICON_COLUMNS_MIN = 1;
export const ICON_COLUMNS_MAX = 12;
export const ICON_COLUMNS_DEFAULT = 8;

// Old sessions stored a pixel cell size. Twelve of the old minimum (72px) fit a row.
const LEGACY_ROW = 864;

export function iconColumnsOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return ICON_COLUMNS_DEFAULT;
  const size = Math.round(value);
  if (size >= ICON_COLUMNS_MIN && size <= ICON_COLUMNS_MAX) return size;
  if (size > ICON_COLUMNS_MAX) return Math.min(ICON_COLUMNS_MAX, Math.max(ICON_COLUMNS_MIN, Math.round(LEGACY_ROW / size)));
  return ICON_COLUMNS_DEFAULT;
}

/** Slider position. The left end is 12 icons and the right end is 1. */
export function iconZoomOf(columns: number): number {
  return ICON_COLUMNS_MAX + ICON_COLUMNS_MIN - iconColumnsOf(columns);
}

export function iconColumnsFromZoom(zoom: number): number {
  return iconColumnsOf(ICON_COLUMNS_MAX + ICON_COLUMNS_MIN - zoom);
}
