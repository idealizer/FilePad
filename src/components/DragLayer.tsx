import { baseName } from "../lib/format";
import { useDragSession } from "../lib/drag";

export function DragLayer() {
  const drag = useDragSession();
  if (!drag) return null;
  const dest = drag.over ? baseName(drag.over) || drag.over : "";
  const count = drag.paths.length;
  return (
    <div className="fp-drag" style={{ left: drag.x + 14, top: drag.y + 16 }}>
      <div>{drag.move ? "Move" : "Copy"} {count} {count === 1 ? "item" : "items"}</div>
      <div className="truncate text-[var(--muted)]">{dest ? `to ${dest}` : drag.move ? "Release to cancel" : "Hold Shift to move"}</div>
    </div>
  );
}
