import { fileRows, previewTarget } from "../lib/rows";
import { formatBytes, formatWhen, typeLabel } from "../lib/format";
import { useApp } from "../stores/appStore";
import type { Side } from "../types";

export function StatusBar() {
  const transfer = useApp((state) => state.transfer);
  if (!transfer) return null;
  return (
    <div className="flex h-7 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] bg-[var(--bg)] px-3 text-xs text-[var(--muted)]">
      <span className="min-w-0 truncate">{transfer.label ?? "Copying"} {transfer.done}/{transfer.total || "…"} {transfer.current}</span>
    </div>
  );
}

export function PanelStatus({ side }: { side: Side }) {
  const panel = useApp((state) => state.panels[side]);
  const showHidden = useApp((state) => state.showHidden);
  const source = useApp((state) => state.panels[side === "left" ? "right" : "left"]);
  if (panel.view === "preview") {
    const row = previewTarget(source, showHidden);
    return (
      <div className="flex h-7 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] px-3 text-xs text-[var(--muted)]">
        {row && <span className="min-w-0 truncate">{row.name}</span>}
        {row && <span className="shrink-0">{typeLabel(row)}</span>}
        {row && !row.isDir && <span className="shrink-0">{formatBytes(row.size)}</span>}
        {row && <span className="shrink-0">{formatWhen(row.modified)}</span>}
      </div>
    );
  }
  const rows = fileRows(panel, showHidden).filter((row) => !row.up);
  const total = rows.reduce((sum, row) => sum + row.size, 0);
  const marked = panel.marked.length;
  const markedSize = panel.entries.filter((entry) => panel.marked.includes(entry.path)).reduce((sum, entry) => sum + entry.size, 0);
  const count = `${rows.length} ${rows.length === 1 ? "item" : "items"} · ${formatBytes(total)}`;
  return (
    <div className="flex h-7 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] px-3 text-xs text-[var(--muted)]">
      <span className="shrink-0">{count}</span>
      {marked > 0 && <span className="shrink-0">{marked} marked · {formatBytes(markedSize)}</span>}
    </div>
  );
}
