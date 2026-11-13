import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef } from "react";
import { armDrag, takeDragMenu, useDragSession } from "../lib/drag";
import { FileIcon } from "../lib/fileIcon";
import { folderNote, treeRows } from "../lib/rows";
import { holdScrollSync, useLinkedScroll } from "../lib/scrollLock";
import { useApp } from "../stores/appStore";
import type { Side } from "../types";
import { FileName } from "./FileName";
import { SortHead } from "./FileList";

export function DirTree({ side }: { side: Side }) {
  const panel = useApp((state) => state.panels[side]);
  const showHidden = useApp((state) => state.showHidden);
  const setActive = useApp((state) => state.setActive);
  const clickEntry = useApp((state) => state.clickEntry);
  const toggleTree = useApp((state) => state.toggleTree);
  const openCurrent = useApp((state) => state.openCurrent);
  const openContext = useApp((state) => state.openContext);
  const drag = useDragSession();
  const rows = treeRows(panel, showHidden);
  const parent = useRef<HTMLDivElement>(null);
  useLinkedScroll(side, parent);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 28, overscan: 12 });
  useEffect(() => {
    if (panel.cursor < 0 || !rows.length) return;
    holdScrollSync();
    virtualizer.scrollToIndex(panel.cursor, { align: "auto" });
  }, [panel.cursor, rows.length, virtualizer]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SortHead side={side} />
      <div ref={parent} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
      {panel.error && <div className="px-3 py-6 text-center text-[var(--danger)]">{panel.error}</div>}
      {folderNote(panel, rows.length, showHidden) && <div className="px-3 py-6 text-center text-[var(--muted)]">{folderNote(panel, rows.length, showHidden)}</div>}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <div
              key={row.key}
              className="fp-row"
              data-cursor={item.index === panel.cursor}
              data-drop={Boolean(drag && drag.over === row.path)}
              data-drop-path={row.path}
              title={row.path}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)`, paddingLeft: 8 + row.depth * 16 }}
              onMouseDown={() => {
                setActive(side);
                clickEntry(side, item.index);
              }}
              onPointerDown={(event) => {
                if (event.button !== 0 && event.button !== 2) return;
                if (event.target instanceof Element && event.target.closest("button")) return;
                const path = row.path;
                armDrag(event, () => [path]);
              }}
              onDoubleClick={() => void openCurrent()}
              onContextMenu={(event) => {
                if (takeDragMenu(event)) return;
                event.preventDefault();
                event.stopPropagation();
                setActive(side);
                clickEntry(side, item.index);
                openContext({ x: event.clientX, y: event.clientY, side, paths: [row.path] });
              }}
            >
              {row.isDir ? (
                <button
                  className="tb-btn sm"
                  style={{ height: 22, minWidth: 22 }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={() => void toggleTree(side, row.path)}
                  aria-label={row.expanded ? "Collapse" : "Expand"}
                >
                  {row.expanded ? <ChevronDown /> : <ChevronRight />}
                </button>
              ) : (
                <span style={{ width: 22, minWidth: 22 }} />
              )}
              <FileIcon isDir={row.isDir} extension={row.extension} />
              <FileName className={row.place ? "max-w-[50%] truncate" : "min-w-0 flex-1 truncate"} name={row.name} path={row.path} isDir={row.isDir} selected={item.index === panel.cursor} activate="slow" />
              {row.place && <span className="fp-place">{row.place}</span>}
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}
