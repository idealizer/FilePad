import type { PointerEvent as ReactPointerEvent } from "react";

export function dragHeight(event: ReactPointerEvent, target: HTMLElement, min: number, max: number, onCommit: (height: number) => void) {
  event.preventDefault();
  const startY = event.clientY;
  const start = target.getBoundingClientRect().height;
  let next = start;
  const previous = document.body.style.cursor;
  document.body.style.cursor = "row-resize";
  const move = (ev: PointerEvent) => {
    next = Math.min(max, Math.max(min, start + startY - ev.clientY));
    target.style.height = `${next}px`;
  };
  const stop = () => {
    document.body.style.cursor = previous;
    onCommit(next);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
}
