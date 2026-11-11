import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { armDrag, useDragSession } from "../lib/drag";
import { FileIcon } from "../lib/fileIcon";
import { ICON_MAX, iconMetrics } from "../lib/iconSize";
import { fileRows, otherNames, pairMark, parentClick, parentDoubleClick, type Row } from "../lib/rows";
import { holdScrollSync, useLinkedScroll } from "../lib/scrollLock";
import { invoke } from "../lib/platform";
import { useApp } from "../stores/appStore";
import type { Side } from "../types";

const pictures = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "mp4", "m4v", "webm", "mov", "mkv", "ogv"]);
const thumbs = new Map<string, string>();

export function setIconColumns(side: Side, count: number) {
  columns[side] = Math.max(1, count);
}

export function iconColumns(side: Side): number {
  return columns[side] || 1;
}

const columns: Record<Side, number> = { left: 4, right: 4 };

export function IconView({ side }: { side: Side }) {
  const panel = useApp((state) => state.panels[side]);
  const showHidden = useApp((state) => state.showHidden);
  const setActive = useApp((state) => state.setActive);
  const clickEntry = useApp((state) => state.clickEntry);
  const toggleMark = useApp((state) => state.toggleMark);
  const markRange = useApp((state) => state.markRange);
  const openCurrent = useApp((state) => state.openCurrent);
  const focusForMenu = useApp((state) => state.focusForMenu);
  const openContext = useApp((state) => state.openContext);
  const iconSize = panel.iconSize;
  const drag = useDragSession();
  const scrollLock = useApp((state) => state.scrollLock);
  const otherEntries = useApp((state) => state.panels[side === "left" ? "right" : "left"].entries);
  const otherFilter = useApp((state) => state.panels[side === "left" ? "right" : "left"].filter);
  const pairs = useMemo(() => (scrollLock ? otherNames(otherEntries, showHidden, otherFilter) : null), [scrollLock, otherEntries, showHidden, otherFilter]);
  const rows = fileRows(panel, showHidden);
  const parent = useRef<HTMLDivElement>(null);
  useLinkedScroll(side, parent);
  const base = iconMetrics(iconSize);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = parent.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [side]);
  const available = Math.max(base.cell, width - 12);
  const across = Math.max(1, Math.floor(available / (iconSize >= ICON_MAX ? ICON_MAX : base.cell)));
  const cell = iconSize >= ICON_MAX ? available / across : base.cell;
  const metrics = { cell, glyph: Math.round(cell * 0.64), row: Math.round(cell * 0.64) + 52 };
  useEffect(() => {
    setIconColumns(side, across);
  }, [side, across]);
  useEffect(() => {
    const node = parent.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const state = useApp.getState();
      state.setActive(side);
      state.setIconSize(side, state.panels[side].iconSize + (event.deltaY < 0 ? 8 : -8));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [side]);
  const fromPointer = useRef(false);
  const lineCount = Math.ceil(rows.length / across);
  const virtualizer = useVirtualizer({ count: lineCount, getScrollElement: () => parent.current, estimateSize: () => metrics.row, overscan: 4 });
  useEffect(() => {
    virtualizer.measure();
  }, [metrics.row, virtualizer]);
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
    virtualizer.scrollToIndex(Math.floor(panel.cursor / across), { align: "auto" });
  }, [panel.cursor, rows.length, across, virtualizer]);

  return (
    <div
      ref={parent}
      className="fp-icons min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
      style={{ "--fp-icon": `${metrics.cell}px`, "--fp-glyph": `${metrics.glyph}px` } as CSSProperties}
    >
      {panel.error && <div className="px-3 py-6 text-center text-[var(--danger)]">{panel.error}</div>}
      {!panel.error && panel.loading && <div className="px-3 py-6 text-center text-[var(--muted)]">Reading…</div>}
      {!panel.error && !panel.loading && rows.length === 0 && <div className="px-3 py-6 text-center text-[var(--muted)]">This folder is empty.</div>}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((line) => (
          <div key={line.key} className="fp-icon-row" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: metrics.row, transform: `translateY(${line.start}px)` }}>
            {rows.slice(line.index * across, line.index * across + across).map((row, offset) => {
              const index = line.index * across + offset;
              const marked = panel.marked.includes(row.path);
              return (
                <div
                  key={row.key}
                  className="fp-icon"
                  data-cursor={index === panel.cursor}
                  data-marked={marked}
                  data-pair={pairMark(pairs, row)}
                  data-drop={Boolean(drag && row.isDir && drag.over === row.path)}
                  data-drop-path={row.up ? panel.parent ?? panel.path : row.isDir ? row.path : panel.path}
                  title={row.name}
                  onDragStart={(event) => event.preventDefault()}
                  onMouseDown={(event) => {
                    setActive(side);
                    if (panel.cursor !== index) fromPointer.current = true;
                    if (event.button === 0 && row.up && parentClick(`${side}:${row.key}`)) {
                      void useApp.getState().openFolder(side, row.path, row.name, true);
                      return;
                    }
                    if (event.shiftKey) markRange(side, index);
                    else if (event.ctrlKey || event.metaKey) toggleMark(side, index, false);
                    else clickEntry(side, index);
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || row.up) return;
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
                    focusForMenu(side, index, row.path);
                    openContext({ x: event.clientX, y: event.clientY, side, paths: keep ? panel.marked : [row.path] });
                  }}
                >
                  <span className="fp-glyph">{pictures.has(row.extension) && !row.isDir ? <Picture path={row.path} row={row} /> : <FileIcon isDir={row.isDir} extension={row.extension} up={row.up} />}</span>
                  <span>{row.name}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Picture({ path, row }: { path: string; row: Row }) {
  const cached = thumbs.get(path) ?? "";
  const [src, setSrc] = useState(cached);
  useEffect(() => {
    if (thumbs.has(path)) {
      setSrc(thumbs.get(path) ?? "");
      return;
    }
    let cancel = false;
    void invoke<{ mime: string; dataBase64: string }>("file_thumb", { path })
      .then((thumb) => {
        const url = `data:${thumb.mime};base64,${thumb.dataBase64}`;
        if (thumbs.size > 300) thumbs.delete(thumbs.keys().next().value ?? "");
        thumbs.set(path, url);
        if (!cancel) setSrc(url);
      })
      .catch(() => {
        thumbs.set(path, "");
      });
    return () => {
      cancel = true;
    };
  }, [path]);
  if (!src) return <FileIcon isDir={row.isDir} extension={row.extension} />;
  return <img src={src} alt="" draggable={false} />;
}
