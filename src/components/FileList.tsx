import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { armDrag, useDragSession } from "../lib/drag";
import { FileIcon } from "../lib/fileIcon";
import { formatBytes, formatWhen, typeLabel } from "../lib/format";
import { fileRows, type Row } from "../lib/rows";
import { useApp } from "../stores/appStore";
import type { Side } from "../types";

export function FileList({ side }: { side: Side }) {
  const panel = useApp((state) => state.panels[side]);
  const showHidden = useApp((state) => state.showHidden);
  const setActive = useApp((state) => state.setActive);
  const clickEntry = useApp((state) => state.clickEntry);
  const toggleMark = useApp((state) => state.toggleMark);
  const markRange = useApp((state) => state.markRange);
  const openEntry = useApp((state) => state.openEntry);
  const setSort = useApp((state) => state.setSort);
  const focusForMenu = useApp((state) => state.focusForMenu);
  const openContext = useApp((state) => state.openContext);
  const drag = useDragSession();
  const rows = fileRows(panel, showHidden);
  const parent = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => (panel.view === "details" ? 30 : 28), overscan: 16 });
  useEffect(() => {
    if (rows.length) virtualizer.scrollToIndex(panel.cursor, { align: "auto" });
  }, [panel.cursor, rows.length, virtualizer]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {panel.view === "details" && (
        <div className="fp-head fp-details px-2">
          <button data-active={panel.sortKey === "name"} onClick={() => setSort(side, "name")}>Name{panel.sortKey === "name" ? (panel.sortAsc ? " ↑" : " ↓") : ""}</button>
          <button data-active={panel.sortKey === "size"} onClick={() => setSort(side, "size")}>Size</button>
          <button data-active={panel.sortKey === "modified"} onClick={() => setSort(side, "modified")}>Modified</button>
          <button data-active={panel.sortKey === "type"} onClick={() => setSort(side, "type")}>Type</button>
        </div>
      )}
      <div ref={parent} className="min-h-0 flex-1 overflow-auto">
        {panel.error && <div className="px-3 py-6 text-center text-[var(--danger)]">{panel.error}</div>}
        {!panel.error && panel.loading && <div className="px-3 py-6 text-center text-[var(--muted)]">Reading…</div>}
        {!panel.error && !panel.loading && rows.length === 0 && <div className="px-3 py-6 text-center text-[var(--muted)]">This folder is empty.</div>}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const marked = panel.marked.includes(row.path);
            const dropPath = dropTarget(row, panel.path, panel.parent);
            return (
              <div
                key={row.key}
                className={panel.view === "details" ? "fp-row fp-details" : "fp-row"}
                data-cursor={item.index === panel.cursor}
                data-marked={marked}
                data-drop={Boolean(drag && row.isDir && drag.over === row.path)}
                data-drop-path={dropPath}
                title={row.path}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
                onMouseDown={(event) => {
                  setActive(side);
                  if (event.shiftKey) markRange(side, item.index);
                  else if (event.ctrlKey || event.metaKey) toggleMark(side, item.index, false);
                  else clickEntry(side, item.index);
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0 || row.up) return;
                  if (event.target instanceof Element && event.target.closest("button, input, a")) return;
                  const path = row.path;
                  armDrag(event, () => {
                    const markedPaths = useApp.getState().panels[side].marked;
                    return markedPaths.includes(path) ? markedPaths : [path];
                  });
                }}
                onDoubleClick={() => void openEntry()}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (row.up) {
                    setActive(side);
                    openContext({ x: event.clientX, y: event.clientY, side, paths: [] });
                    return;
                  }
                  const keep = panel.marked.includes(row.path);
                  focusForMenu(side, item.index, row.path);
                  openContext({ x: event.clientX, y: event.clientY, side, paths: keep ? panel.marked : [row.path] });
                }}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <FileIcon isDir={row.isDir} extension={row.extension} up={row.up} />
                  <span className="truncate">{row.name}</span>
                </span>
                {panel.view === "details" && (
                  <>
                    <span>{row.up || row.isDir ? "" : formatBytes(row.size)}</span>
                    <span>{row.up ? "" : formatWhen(row.modified)}</span>
                    <span>{row.up ? "" : typeLabel(row)}</span>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function dropTarget(row: Row, folder: string, parent: string | null): string {
  if (row.up) return parent ?? folder;
  if (row.isDir) return row.path;
  return folder;
}
