import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import { armDrag, useDragSession } from "../lib/drag";
import { FileIcon } from "../lib/fileIcon";
import { fileRows, type Row } from "../lib/rows";
import { invoke } from "../lib/platform";
import { useApp } from "../stores/appStore";
import type { Side } from "../types";

const CELL = 112;
const ROW = 124;
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
  const openEntry = useApp((state) => state.openEntry);
  const focusForMenu = useApp((state) => state.focusForMenu);
  const openContext = useApp((state) => state.openContext);
  const drag = useDragSession();
  const rows = fileRows(panel, showHidden);
  const parent = useRef<HTMLDivElement>(null);
  const [across, setAcross] = useState(4);
  useEffect(() => {
    const node = parent.current;
    if (!node) return;
    const measure = () => {
      const next = Math.max(1, Math.floor(node.clientWidth / CELL));
      setAcross(next);
      setIconColumns(side, next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [side]);
  const lineCount = Math.ceil(rows.length / across);
  const virtualizer = useVirtualizer({ count: lineCount, getScrollElement: () => parent.current, estimateSize: () => ROW, overscan: 4 });
  useEffect(() => {
    if (rows.length) virtualizer.scrollToIndex(Math.floor(panel.cursor / across), { align: "auto" });
  }, [panel.cursor, rows.length, across, virtualizer]);

  return (
    <div ref={parent} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      {panel.error && <div className="px-3 py-6 text-center text-[var(--danger)]">{panel.error}</div>}
      {!panel.error && panel.loading && <div className="px-3 py-6 text-center text-[var(--muted)]">Reading…</div>}
      {!panel.error && !panel.loading && rows.length === 0 && <div className="px-3 py-6 text-center text-[var(--muted)]">This folder is empty.</div>}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((line) => (
          <div key={line.key} className="fp-icon-row" style={{ position: "absolute", top: 0, left: 0, width: "100%", height: ROW, transform: `translateY(${line.start}px)` }}>
            {rows.slice(line.index * across, line.index * across + across).map((row, offset) => {
              const index = line.index * across + offset;
              const marked = panel.marked.includes(row.path);
              return (
                <div
                  key={row.key}
                  className="fp-icon"
                  data-cursor={index === panel.cursor}
                  data-marked={marked}
                  data-drop={Boolean(drag && row.isDir && drag.over === row.path)}
                  data-drop-path={row.up ? panel.parent ?? panel.path : row.isDir ? row.path : panel.path}
                  title={row.name}
                  onMouseDown={(event) => {
                    setActive(side);
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
  return <img src={src} alt="" />;
}
