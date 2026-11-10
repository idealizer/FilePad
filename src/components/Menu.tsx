import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function Dropdown({
  button,
  children,
  align = "start",
}: {
  button: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = menu.current;
    if (!open || !node) return;
    const margin = 8;
    node.style.left = align === "end" ? "auto" : "0";
    node.style.right = align === "end" ? "0" : "auto";
    node.style.maxWidth = `${window.innerWidth - margin * 2}px`;
    const box = node.getBoundingClientRect();
    if (box.right > window.innerWidth - margin) {
      node.style.left = "auto";
      node.style.right = "0";
    }
    const flipped = node.getBoundingClientRect();
    if (flipped.left < margin && node.parentElement) {
      const parentLeft = node.parentElement.getBoundingClientRect().left;
      node.style.right = "auto";
      node.style.left = `${margin - parentLeft}px`;
    }
  }, [open, align]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
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
      {open && <div ref={menu} className="menu" style={align === "end" ? { right: 0, left: "auto" } : { left: 0, right: "auto" }}>{children(() => setOpen(false))}</div>}
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
    <button className="menu-item" disabled={disabled} onClick={onClick} title={title}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="hint">{hint}</span>}
    </button>
  );
}
