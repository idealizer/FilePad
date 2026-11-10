import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useEffect, useRef } from "react";
import { armDrag, useDragSession } from "../lib/drag";
import { treeRows } from "../lib/rows";
import { useApp } from "../stores/appStore";
import type { Side } from "../types";

export function DirTree({ side }: { side: Side }) {
  const panel = useApp((state) => state.panels[side]);
  const showHidden = useApp((state) => state.showHidden);
  const setActive = useApp((state) => state.setActive);
  const clickEntry = useApp((state) => state.clickEntry);
  const toggleTree = useApp((state) => state.toggleTree);
  const openEntry = useApp((state) => state.openEntry);
  const openContext = useApp((state) => state.openContext);
  const drag = useDragSession();
  const rows = treeRows(panel, showHidden);
  const parent = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => 28, overscan: 12 });
  useEffect(() => {
    if (rows.length) virtualizer.scrollToIndex(panel.cursor, { align: "auto" });
  }, [panel.cursor, rows.length, virtualizer]);

  return (
    <div ref={parent} className="min-h-0 flex-1 overflow-auto">
      {!rows.length && <div className="px-3 py-6 text-center text-[var(--muted)]">{panel.loading ? "Reading…" : "No folders here."}</div>}
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
                if (event.button !== 0) return;
                if (event.target instanceof Element && event.target.closest("button")) return;
                const path = row.path;
                armDrag(event, () => [path]);
              }}
              onDoubleClick={() => void openEntry()}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setActive(side);
                clickEntry(side, item.index);
                openContext({ x: event.clientX, y: event.clientY, side, paths: [row.path] });
              }}
            >
              <button
                className="tb-btn sm"
                style={{ height: 22, minWidth: 22 }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => void toggleTree(side, row.path)}
                aria-label={row.expanded ? "Collapse" : "Expand"}
              >
                {row.expanded ? <ChevronDown /> : <ChevronRight />}
              </button>
              <Folder />
              <span className="truncate">{row.name}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
