import { fileRows } from "../lib/rows";
import { formatBytes } from "../lib/format";
import { useApp } from "../stores/appStore";

export function StatusBar() {
  const panels = useApp((state) => state.panels);
  const active = useApp((state) => state.active);
  const showHidden = useApp((state) => state.showHidden);
  const transfer = useApp((state) => state.transfer);
  const panel = panels[active];
  const rows = fileRows(panel, showHidden).filter((row) => !row.up);
  const marked = panel.marked.length;
  const markedSize = panel.entries.filter((entry) => panel.marked.includes(entry.path)).reduce((sum, entry) => sum + entry.size, 0);
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-t border-[var(--border)] bg-[var(--bg)] px-3 text-xs text-[var(--muted)]">
      {transfer ? (
        <span>Copying {transfer.done}/{transfer.total || "…"} {transfer.current}</span>
      ) : (
        <span>{rows.length} items{marked ? ` · ${marked} marked · ${formatBytes(markedSize)}` : ""}</span>
      )}
      <span className="min-w-0 flex-1 truncate" title={panel.path}>{panel.path}</span>
    </div>
  );
}
