import { baseName } from "../lib/format";
import { useDragSession } from "../lib/drag";

export function DragLayer() {
  const drag = useDragSession();
  if (!drag) return null;
  const dest = drag.over ? baseName(drag.over) || drag.over : "";
  const count = drag.paths.length;
  const mode = !drag.over ? "none" : drag.choose ? "choose" : drag.move ? "move" : "copy";
  const verb = mode === "none" ? "No drop" : mode === "choose" ? "Drop" : mode === "move" ? "Move" : "Copy";
  return (
    <div className="fp-drag" data-mode={mode} style={{ left: drag.x + 14, top: drag.y + 16 }}>
      <span className="fp-drag-mark">{mode === "copy" ? "+" : mode === "none" ? "" : "→"}</span>
      <div className="min-w-0">
        <div>{mode === "none" ? verb : `${verb} ${count} ${count === 1 ? "item" : "items"}`}</div>
        <div className="truncate text-[var(--muted)]">{dest ? `to ${dest} · ${drag.hint}` : drag.hint}</div>
      </div>
    </div>
  );
}
