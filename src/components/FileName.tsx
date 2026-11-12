import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { message } from "../lib/platform";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";

const SLOW_CLICK = 500;

export function FileName({
  name,
  path,
  isDir,
  selected,
  activate,
  className = "",
}: {
  name: string;
  path: string;
  isDir: boolean;
  selected: boolean;
  activate: "slow" | "click";
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef(0);
  const pickedAt = useRef(0);
  const closing = useRef(false);

  useEffect(() => {
    if (selected) {
      if (!pickedAt.current) pickedAt.current = performance.now();
    } else {
      pickedAt.current = 0;
      window.clearTimeout(timer.current);
    }
  }, [selected]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useLayoutEffect(() => {
    if (!editing) return;
    closing.current = false;
    const field = input.current;
    if (!field) return;
    field.focus();
    const dot = name.lastIndexOf(".");
    field.setSelectionRange(0, !isDir && dot > 0 ? dot : name.length);
  }, [editing, isDir, name]);

  const begin = () => {
    setDraft(name);
    setEditing(true);
  };

  const commit = async (save: boolean) => {
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
    try {
      await useApp.getState().renamePath(path, next);
      setEditing(false);
    } catch (error) {
      closing.current = false;
      toast("error", message(error));
      input.current?.focus();
    }
  };

  const onMouseDown = (event: MouseEvent) => {
    if (activate !== "slow" || event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey || event.detail > 1) {
      window.clearTimeout(timer.current);
      return;
    }
    if (!selected || performance.now() - pickedAt.current < SLOW_CLICK) return;
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

  const onClick = (event: MouseEvent) => {
    if (activate !== "click") return;
    event.preventDefault();
    event.stopPropagation();
    begin();
  };

  if (editing) {
    return (
      <input
        ref={input}
        className={`fp-name-edit ${className}`}
        value={draft}
        aria-label="File name"
        onChange={(event) => setDraft(event.target.value)}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
        onBlur={() => void commit(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            void commit(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            void commit(false);
          }
        }}
      />
    );
  }

  return (
    <span
      className={className}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={() => window.clearTimeout(timer.current)}
    >
      {name}
    </span>
  );
}
