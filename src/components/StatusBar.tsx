import { fileRows, markSet, previewTarget } from "../lib/rows";
import { formatBytes, formatWhen, typeLabel } from "../lib/format";
import { useApp } from "../stores/appStore";
import type { Side } from "../types";

export function StatusBar() {
  const transfer = useApp((state) => state.transfer);
  if (!transfer) return null;
  const ratio = transfer.total > 0 ? Math.min(1, transfer.done / transfer.total) : null;
  const amount = transfer.total > 0
    ? transfer.bytes
      ? `${formatBytes(transfer.done)} / ${formatBytes(transfer.total)}`
      : `${transfer.done}/${transfer.total}`
    : "…";
  return (
    <div className="fp-chrome flex h-7 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] bg-[var(--bg)] px-3 text-xs text-[var(--muted)]">
      <span className="min-w-0 flex-1 truncate">{transfer.label ?? "Copying"} {amount} {transfer.current}</span>
      <span className="fp-toast-bar w-40 shrink-0" data-busy={ratio == null ? "true" : undefined}>
        <span style={ratio != null ? { width: `${Math.round(ratio * 100)}%` } : undefined} />
      </span>
    </div>
  );
}

export function PanelStatus({ side }: { side: Side }) {
  const panel = useApp((state) => state.panels[side]);
  const showHidden = useApp((state) => state.showHidden);
  const source = useApp((state) => state.panels[side === "left" ? "right" : "left"]);
  if (panel.view === "preview") {
    const sourceRow = source.view === "tree" ? null : fileRows(source, showHidden)[source.cursor];
    if (sourceRow?.up) {
      return (
        <div className="flex h-7 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] px-3 text-xs text-[var(--muted)]">
          <span className="min-w-0 truncate">Parent folder of the other panel</span>
        </div>
      );
    }
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
  const marks = markSet(panel.marked);
  const markedSize = [...panel.entries, ...panel.hits].reduce((sum, entry) => (marks.has(entry.path) ? sum + entry.size : sum), 0);
  const count = `${rows.length} ${rows.length === 1 ? "item" : "items"} · ${formatBytes(total)}`;
  return (
    <div className="flex h-7 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] px-3 text-xs text-[var(--muted)]">
      <span className="shrink-0">{count}</span>
      {panel.searching && <span className="shrink-0">Searching…</span>}
      {!panel.searching && panel.searchLimited && panel.filter.trim().toLowerCase() === panel.searched.trim().toLowerCase() && <span className="shrink-0">First {panel.searchCap} matches</span>}
      {marked > 0 && <span className="shrink-0">{marked} marked · {formatBytes(markedSize)}</span>}
    </div>
  );
}
