import { useSyncExternalStore } from "react";
import { parentPath } from "./format";
import { invoke, message } from "./platform";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";

export interface DragSession {
  paths: string[];
  x: number;
  y: number;
  move: boolean;
  over: string | null;
  side: string | null;
}

let session: DragSession | null = null;
let stopListeners: (() => void) | null = null;
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

function snapshot(): DragSession | null {
  return session;
}

export function useDragSession(): DragSession | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function clearSession() {
  session = null;
  document.body.classList.remove("fp-dragging");
  publish();
}

type DragStart = {
  button: number;
  clientX: number;
  clientY: number;
  pointerId: number;
  currentTarget: EventTarget | null;
};

export function armDrag(event: DragStart, readPaths: () => string[]) {
  if (event.button !== 0) return;
  const captured = event.currentTarget instanceof Element ? event.currentTarget : null;
  const pointerId = event.pointerId;
  if (captured) {
    try {
      captured.setPointerCapture(pointerId);
    } catch {
      /* the row can still start an inside drag */
    }
  }
  stopListeners?.();
  const startX = event.clientX;
  const startY = event.clientY;
  let active = false;
  let handedOff = false;

  const hit = (clientX: number, clientY: number) => {
    const node = document.elementFromPoint(clientX, clientY);
    const drop = node instanceof Element ? node.closest("[data-drop-path]") : null;
    const panel = node instanceof Element ? node.closest("[data-panel]") : null;
    return {
      over: drop?.getAttribute("data-drop-path") || null,
      side: panel?.getAttribute("data-panel") || null,
    };
  };

  const move = (ev: PointerEvent) => {
    if (!active) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      const paths = readPaths().filter(Boolean);
      if (!paths.length) return;
      active = true;
      document.body.classList.add("fp-dragging");
      const place = hit(ev.clientX, ev.clientY);
      session = { paths, x: ev.clientX, y: ev.clientY, move: ev.shiftKey, ...place };
      publish();
    }
    if (!session) return;
    if (ev.clientX < 0 || ev.clientY < 0 || ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight) {
      const paths = session.paths.slice();
      handedOff = true;
      if (captured?.hasPointerCapture(pointerId)) captured.releasePointerCapture(pointerId);
      finish();
      void invoke("start_file_drag", { paths }).catch((reason: unknown) => toast("error", message(reason)));
      return;
    }
    session = { ...session, x: ev.clientX, y: ev.clientY, move: ev.shiftKey, ...hit(ev.clientX, ev.clientY) };
    publish();
  };

  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      if (active) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      active = false;
      finish();
      return;
    }
    if (!session) return;
    session = { ...session, move: ev.shiftKey };
    publish();
  };

  const up = (ev: PointerEvent) => {
    const current = session;
    const dropped = active && !handedOff;
    finish();
    if (!dropped || !current?.over) return;
    const dest = current.over.replace(/[\\/]+$/, "");
    const sources = current.paths;
    if (sources.every((path) => parentPath(path).toLowerCase() === dest.toLowerCase())) {
      toast("warning", "Already in this folder.");
      return;
    }
    void useApp.getState().beginTransfer(ev.shiftKey ? "cut" : "copy", sources, dest);
  };

  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key);
    window.removeEventListener("blur", finish);
    stopListeners = null;
    clearSession();
  };

  stopListeners = finish;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key);
  window.addEventListener("blur", finish);
}
