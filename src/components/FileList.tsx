import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";
import { armDrag, useDragSession } from "../lib/drag";
import { FileIcon } from "../lib/fileIcon";
import { formatBytes, formatWhen, typeLabel } from "../lib/format";
import { fileRows, otherNames, pairMark, parentClick, parentDoubleClick, type Row } from "../lib/rows";
import { holdScrollSync, useLinkedScroll } from "../lib/scrollLock";
import { useApp } from "../stores/appStore";
import type { Side } from "../types";
import { FileName } from "./FileName";

export function SortHead({ side }: { side: Side }) {
  const sortKey = useApp((state) => state.panels[side].sortKey);
  const sortAsc = useApp((state) => state.panels[side].sortAsc);
  const setSort = useApp((state) => state.setSort);
  const mark = (key: typeof sortKey) => (sortKey === key ? (sortAsc ? " ↑" : " ↓") : "");
  return (
    <div className="fp-head fp-details px-2">
      <button data-active={sortKey === "name"} onClick={() => setSort(side, "name")}>Name{mark("name")}</button>
      <button data-active={sortKey === "size"} onClick={() => setSort(side, "size")}>Size{mark("size")}</button>
      <button data-active={sortKey === "modified"} onClick={() => setSort(side, "modified")}>Modified{mark("modified")}</button>
      <button data-active={sortKey === "type"} onClick={() => setSort(side, "type")}>Type{mark("type")}</button>
    </div>
  );
}

export function FileList({ side }: { side: Side }) {
  const panel = useApp((state) => state.panels[side]);
  const showHidden = useApp((state) => state.showHidden);
  const setActive = useApp((state) => state.setActive);
  const clickEntry = useApp((state) => state.clickEntry);
  const toggleMark = useApp((state) => state.toggleMark);
  const markRange = useApp((state) => state.markRange);
  const openCurrent = useApp((state) => state.openCurrent);
  const focusForMenu = useApp((state) => state.focusForMenu);
  const openContext = useApp((state) => state.openContext);
  const drag = useDragSession();
  const scrollLock = useApp((state) => state.scrollLock);
  const otherEntries = useApp((state) => state.panels[side === "left" ? "right" : "left"].entries);
  const otherFilter = useApp((state) => state.panels[side === "left" ? "right" : "left"].filter);
  const pairs = useMemo(() => (scrollLock ? otherNames(otherEntries, showHidden, otherFilter) : null), [scrollLock, otherEntries, showHidden, otherFilter]);
  const rows = fileRows(panel, showHidden);
  const parent = useRef<HTMLDivElement>(null);
  useLinkedScroll(side, parent);
  const fromPointer = useRef(false);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 28, overscan: 16 });
  useEffect(() => {
    fromPointer.current = false;
    parent.current?.scrollTo({ top: 0 });
  }, [panel.path]);
  useEffect(() => {
    if (fromPointer.current) {
      fromPointer.current = false;
      return;
    }
    if (panel.cursor < 0 || !rows.length) return;
    holdScrollSync();
    virtualizer.scrollToIndex(panel.cursor, { align: "auto" });
  }, [panel.cursor, rows.length, virtualizer]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SortHead side={side} />
      <div ref={parent} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
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
                data-pair={pairMark(pairs, row)}
                data-drop={Boolean(drag && row.isDir && drag.over === row.path)}
                data-drop-path={dropPath}
                title={row.path}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
                onMouseDown={(event) => {
                  setActive(side);
                  if (panel.cursor !== item.index) fromPointer.current = true;
                  if (event.button === 0 && row.up && parentClick(`${side}:${row.key}`)) {
                    void useApp.getState().openFolder(side, row.path, row.name, true);
                    return;
                  }
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
                onDoubleClick={() => {
                  if (row.up) {
                    if (parentDoubleClick()) void useApp.getState().openFolder(side, row.path, row.name, true);
                    return;
                  }
                  void openCurrent();
                }}
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
                  {row.up ? <span className="truncate">{row.name}</span> : <FileName className="min-w-0 flex-1 truncate" name={row.name} path={row.path} isDir={row.isDir} selected={item.index === panel.cursor} activate="slow" />}
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
