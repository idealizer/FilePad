import { Archive, ClipboardPaste, Copy, Eye, FolderOpen, FolderPlus, MoveRight, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "../stores/appStore";

export function ContextMenu() {
  const menu = useApp((state) => state.contextMenu);
  const clipboard = useApp((state) => state.clipboard);
  const closeContext = useApp((state) => state.closeContext);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu?.x ?? 0, y: menu?.y ?? 0 });

  useLayoutEffect(() => {
    if (!menu) return;
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8)),
    });
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      closeContext();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeContext();
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", closeContext);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", closeContext);
    };
  }, [menu, closeContext]);

  if (!menu) return null;
  const count = menu.paths.length;
  const run = (action: () => void) => {
    closeContext();
    action();
  };
  const store = () => useApp.getState();

  return (
    <div ref={ref} className="menu fp-context" style={{ left: pos.x, top: pos.y }} onMouseDown={(event) => event.stopPropagation()}>
      <button className="menu-item" disabled={count !== 1} onClick={() => run(() => void store().openCurrent())}><FolderOpen />Open<span className="hint">F4</span></button>
      <button className="menu-item" disabled={!count} onClick={() => run(() => store().previewOther())}><Eye />Preview<span className="hint">F3</span></button>
      <div className="menu-sep" />
      <button className="menu-item" disabled={!count} onClick={() => run(() => void store().copyToOther())}><Copy />Copy to the other panel<span className="hint">F5</span></button>
      <button className="menu-item" disabled={!count} onClick={() => run(() => void store().moveToOther())}><MoveRight />Move to the other panel<span className="hint">F6</span></button>
      <button className="menu-item" disabled={!count} onClick={() => run(() => store().askRename())}><Pencil />Rename<span className="hint">F2</span></button>
      {count === 1 && <button className="menu-item" onClick={() => run(() => store().askPattern())}>Rename with a pattern</button>}
      <div className="menu-sep" />
      <button className="menu-item" onClick={() => run(() => store().askMkdir())}><FolderPlus />New folder<span className="hint">F7</span></button>
      <button className="menu-item" disabled={!count} onClick={() => run(() => store().askZip())}><Archive />Send to zip</button>
      <button className="menu-item" disabled={!clipboard} onClick={() => run(() => void store().paste())}><ClipboardPaste />Paste</button>
      <button className="menu-item" onClick={() => run(() => void store().refresh(menu.side))}><RefreshCw />Refresh</button>
      <div className="menu-sep" />
      <button className="menu-item" disabled={!count} onClick={() => run(() => store().askDelete())}><Trash2 />Delete<span className="hint">F8</span></button>
    </div>
  );
}
