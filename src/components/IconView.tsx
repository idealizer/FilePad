import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { armDrag, takeDragMenu, useDragSession } from "../lib/drag";
import { FileIcon } from "../lib/fileIcon";
import { parentPath } from "../lib/format";
import { iconColumnsOf } from "../lib/iconSize";
import { fileRows, folderNote, markSet, otherNames, pairMark, parentClick, parentDoubleClick, type Row } from "../lib/rows";
import { holdScrollSync, useLinkedScroll } from "../lib/scrollLock";
import { invoke, message } from "../lib/platform";
import { useApp } from "../stores/appStore";
import { FileName } from "./FileName";
import { SortHead } from "./FileList";
import type { Side } from "../types";

const pictures = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "mp4", "m4v", "webm", "mov", "mkv", "ogv"]);
const thumbs = new Map<string, string>();
const THUMB_CACHE = 2000;
let thumbSeq = 0;

function rememberThumb(key: string, url: string) {
  if (thumbs.has(key)) thumbs.delete(key);
  thumbs.set(key, url);
  while (thumbs.size > THUMB_CACHE) {
    const oldest = thumbs.keys().next().value;
    if (oldest === undefined) break;
    thumbs.delete(oldest);
  }
}

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
  const columns = iconColumnsOf(panel.iconSize);
  const drag = useDragSession();
  const scrollLock = useApp((state) => state.scrollLock);
  const otherEntries = useApp((state) => state.panels[side === "left" ? "right" : "left"].entries);
  const otherFilter = useApp((state) => state.panels[side === "left" ? "right" : "left"].filter);
  const pairs = useMemo(() => (scrollLock ? otherNames(otherEntries, showHidden, otherFilter) : null), [scrollLock, otherEntries, showHidden, otherFilter]);
  const rows = fileRows(panel, showHidden);
  const marks = markSet(panel.marked);
  const parent = useRef<HTMLDivElement>(null);
  useLinkedScroll(side, parent);
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
  const across = columns;
  const nested = rows.some((row) => row.place);
  const cell = width > 0 ? Math.max(1, (width - 12) / across) : 112;
  const metrics = { cell, glyph: Math.round(cell * 0.64), row: Math.round(cell * 0.64) + (nested ? 68 : 52) };
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
      const current = iconColumnsOf(state.panels[side].iconSize);
      state.setIconSize(side, current + (event.deltaY < 0 ? -1 : 1));
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
    <div className="flex min-h-0 flex-1 flex-col">
      <SortHead side={side} />
      <div
        ref={parent}
        className="fp-icons min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
        style={{ "--fp-icon": `${metrics.cell}px`, "--fp-glyph": `${metrics.glyph}px` } as CSSProperties}
      >
      {panel.error && <div className="px-3 py-6 text-center text-[var(--danger)]">{panel.error}</div>}
      {folderNote(panel, rows.length, showHidden) && <div className="px-3 py-6 text-center text-[var(--muted)]">{folderNote(panel, rows.length, showHidden)}</div>}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((line) => (
          <div key={line.key} className="fp-icon-row" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: metrics.row, transform: `translateY(${line.start}px)` }}>
            {rows.slice(line.index * across, line.index * across + across).map((row, offset) => {
              const index = line.index * across + offset;
              const marked = marks.has(row.path);
              return (
                <div
                  key={row.key}
                  className="fp-icon"
                  data-cursor={index === panel.cursor}
                  data-marked={marked}
                  data-pair={pairMark(pairs, row)}
                  data-drop={Boolean(drag && row.isDir && drag.over === row.path)}
                  data-drop-path={row.up ? panel.parent ?? panel.path : row.isDir ? row.path : row.place ? parentPath(row.path) : panel.path}
                  title={row.place ? `${row.name} — ${row.place}` : row.name}
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
                    if ((event.button !== 0 && event.button !== 2) || row.up) return;
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
                    if (takeDragMenu(event)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (row.up) {
                      setActive(side);
                      openContext({ x: event.clientX, y: event.clientY, side, paths: [] });
                      return;
                    }
                    const keep = marks.has(row.path);
                    focusForMenu(side, index, row.path);
                    openContext({ x: event.clientX, y: event.clientY, side, paths: keep ? panel.marked : [row.path] });
                  }}
                >
                  <span className="fp-glyph">{pictures.has(row.extension) && !row.isDir ? <Picture path={row.path} row={row} /> : <FileIcon isDir={row.isDir} extension={row.extension} up={row.up} />}</span>
                  {row.up ? <span className="fp-name">{row.name}</span> : <FileName className="fp-name" name={row.name} path={row.path} isDir={row.isDir} selected={index === panel.cursor} activate="slow" />}
                  {row.place && <span className="fp-place">{row.place}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      </div>
    </div>
  );
}

function Picture({ path, row }: { path: string; row: Row }) {
  const key = `${path}\0${row.modified}`;
  const cached = thumbs.get(key) ?? "";
  const [src, setSrc] = useState(cached);
  useEffect(() => {
    if (thumbs.has(key)) {
      setSrc(thumbs.get(key) ?? "");
      return;
    }
    const id = ++thumbSeq;
    let cancel = false;
    let settled = false;
    void invoke<{ mime: string; dataBase64: string }>("file_thumb", { path, id })
      .then((thumb) => {
        settled = true;
        const url = `data:${thumb.mime};base64,${thumb.dataBase64}`;
        rememberThumb(key, url);
        if (!cancel) setSrc(url);
      })
      .catch((reason: unknown) => {
        settled = true;
        if (cancel || message(reason) === "cancelled") return;
        rememberThumb(key, "");
      });
    return () => {
      cancel = true;
      if (!settled) void invoke("cancel_thumb", { id });
    };
  }, [path, key]);
  if (!src) return <FileIcon isDir={row.isDir} extension={row.extension} />;
  return <img src={src} alt="" draggable={false} />;
}
