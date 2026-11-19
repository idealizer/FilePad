import { X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";

const SLOW_CLICK = 500;

function TabLabel({ id, name, active }: { id: string; name: string; active: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef(0);
  const pickedAt = useRef(0);
  const closing = useRef(false);

  useEffect(() => {
    if (active) {
      if (!pickedAt.current) pickedAt.current = performance.now();
    } else {
      pickedAt.current = 0;
      window.clearTimeout(timer.current);
      setEditing(false);
    }
  }, [active]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!editing) return;
    closing.current = false;
    const field = input.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(0, name.length);
  }, [editing, name]);

  const begin = () => {
    setDraft(name);
    setEditing(true);
  };

  const commit = (save: boolean) => {
    if (closing.current) return;
    const next = draft.trim();
    if (!save || next === name) {
      closing.current = true;
      setEditing(false);
      return;
    }
    if (!next) {
      toast("warning", "Type a name.");
      input.current?.focus();
      return;
    }
    closing.current = true;
    useApp.getState().renameTab(id, next);
    setEditing(false);
  };

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.detail > 1) {
      window.clearTimeout(timer.current);
      return;
    }
    if (!active || performance.now() - pickedAt.current < SLOW_CLICK) return;
    window.clearTimeout(timer.current);
    const startX = event.clientX;
    const startY = event.clientY;
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
      window.clearTimeout(timer.current);
      window.removeEventListener("pointermove", move);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", () => window.removeEventListener("pointermove", move), { once: true });
    timer.current = window.setTimeout(begin, SLOW_CLICK);
  };

  if (editing) {
    return (
      <input
        ref={input}
        className="fp-name-edit fp-tab-edit"
        value={draft}
        aria-label="Tab name"
        onChange={(event) => setDraft(event.target.value)}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onBlur={() => commit(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            commit(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            commit(false);
          }
        }}
      />
    );
  }

  return (
    <span className="fp-tab-name" title={name} onMouseDown={onMouseDown} onDoubleClick={() => window.clearTimeout(timer.current)}>
      {name}
    </span>
  );
}

export function TabBar() {
  const ready = useApp((state) => state.ready);
  const tabs = useApp((state) => state.tabs);
  const activeTab = useApp((state) => state.activeTab);
  const switchTab = useApp((state) => state.switchTab);
  const closeTab = useApp((state) => state.closeTab);
  if (!ready || tabs.length < 2) return null;
  return (
    <div className="fp-tabs" role="tablist" aria-label="Panel sets">
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        const label = tab.name.trim() || "Files";
        return (
          <div
            key={tab.id}
            className="fp-tab"
            role="tab"
            aria-selected={active}
            data-active={active}
            onMouseDown={(event) => {
              if (event.button !== 0) return;
              const target = event.target;
              if (target instanceof HTMLElement && target.closest("button, input")) return;
              if (!active) void switchTab(tab.id);
            }}
          >
            <TabLabel id={tab.id} name={label} active={active} />
            <button
              type="button"
              className="fp-tab-x"
              aria-label={`Close ${label}`}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => closeTab(tab.id)}
            >
              <X />
            </button>
          </div>
        );
      })}
    </div>
  );
}
