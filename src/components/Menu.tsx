import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Dropdown({
  button,
  children,
  align = "start",
  menuClass = "",
}: {
  button: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
  menuClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = menu.current;
    const host = root.current;
    if (!open || !node || !host) return;
    const place = () => {
      const margin = 8;
      const anchor = host.getBoundingClientRect();
      const spaceBelow = window.innerHeight - anchor.bottom - 4 - margin;
      const spaceAbove = anchor.top - 4 - margin;
      const openUp = spaceBelow < 160 && spaceAbove > spaceBelow;
      node.style.position = "fixed";
      node.style.visibility = "visible";
      node.style.right = "auto";
      node.style.bottom = "auto";
      node.style.maxWidth = `${Math.max(160, window.innerWidth - margin * 2)}px`;
      node.style.maxHeight = `${Math.max(120, openUp ? spaceAbove : spaceBelow)}px`;
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const limit = Math.max(margin, window.innerWidth - width - margin);
      const preferred = align === "end" ? anchor.right - width : anchor.left;
      const left = Math.min(Math.max(margin, preferred), limit);
      const top = openUp ? Math.max(margin, anchor.top - 4 - height) : anchor.bottom + 4;
      node.style.left = `${Math.round(left)}px`;
      node.style.top = `${Math.round(top)}px`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (root.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={root} className="relative inline-flex">
      {button({ open, toggle: () => setOpen((value) => !value) })}
      {open && createPortal(
        <div ref={menu} className={menuClass ? `menu ${menuClass}` : "menu"} style={{ position: "fixed", visibility: "hidden" }}>
          {children(() => setOpen(false))}
        </div>,
        document.body,
      )}
    </div>
  );
}

export function MenuItem({ icon, label, hint, disabled, onClick, title }: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: string;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      className="menu-item"
      disabled={disabled}
      title={title}
      onMouseDown={(event) => {
        if (disabled || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      onClick={(event) => {
        if (event.detail !== 0) {
          event.preventDefault();
          return;
        }
        onClick();
      }}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="hint">{hint}</span>}
    </button>
  );
}
