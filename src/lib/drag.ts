import { useSyncExternalStore } from "react";
import { parentPath } from "./format";
import { invoke, message } from "./platform";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";
import type { Side } from "../types";

export interface DragSession {
  paths: string[];
  x: number;
  y: number;
  move: boolean;
  choose: boolean;
  hint: string;
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
  delete document.body.dataset.drag;
  publish();
}

let suppressMenu = false;

export function takeDragMenu(event: { preventDefault(): void; stopPropagation(): void }): boolean {
  if (!suppressMenu) return false;
  suppressMenu = false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function holdMenu() {
  suppressMenu = true;
  window.setTimeout(() => {
    suppressMenu = false;
  }, 400);
}

function dragAction(dest: string | null, ctrl: boolean, choose: boolean): { move: boolean; hint: string } {
  if (!dest) return { move: false, hint: "Release to cancel" };
  if (choose) return { move: true, hint: "Release to choose" };
  if (ctrl) return { move: false, hint: "Ctrl copies" };
  return { move: true, hint: "Release to move" };
}

function sameFolder(sources: string[], dest: string): boolean {
  const folder = dest.replace(/[\\/]+$/, "").toLowerCase();
  return sources.every((path) => parentPath(path).toLowerCase() === folder);
}

function panelSide(side: string | null): Side {
  if (side === "left" || side === "right") return side;
  return useApp.getState().active;
}

function offerDrop(x: number, y: number, sources: string[], dest: string, side: string | null) {
  holdMenu();
  if (sameFolder(sources, dest)) {
    toast("warning", "Already in this folder.");
    return;
  }
  useApp.getState().openContext({
    x,
    y,
    side: panelSide(side),
    paths: sources,
    drop: { sources, dest },
  });
}

function showSession(next: DragSession) {
  session = next;
  document.body.classList.add("fp-dragging");
  document.body.dataset.drag = next.over ? (next.move ? "move" : "copy") : "none";
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
  if (event.button !== 0 && event.button !== 2) return;
  const choose = event.button === 2;
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
      const place = hit(ev.clientX, ev.clientY);
      showSession({ paths, x: ev.clientX, y: ev.clientY, choose, ...dragAction(place.over, ev.ctrlKey || ev.metaKey, choose), ...place });
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
    const place = hit(ev.clientX, ev.clientY);
    showSession({ ...session, x: ev.clientX, y: ev.clientY, ...dragAction(place.over, ev.ctrlKey || ev.metaKey, session.choose), ...place });
  };

  const menu = (ev: MouseEvent) => {
    if (!active || handedOff || !session) return;
    ev.preventDefault();
    ev.stopPropagation();
    const current = session;
    finish();
    if (!current.over) return;
    offerDrop(ev.clientX, ev.clientY, current.paths, current.over.replace(/[\\/]+$/, ""), current.side);
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
    showSession({ ...session, ...dragAction(session.over, ev.ctrlKey || ev.metaKey, session.choose) });
  };

  const up = (ev: PointerEvent) => {
    const current = session;
    const dropped = active && !handedOff;
    const pick = ev.button === 2 || current?.choose === true;
    finish();
    if (!dropped || !current?.over) return;
    const dest = current.over.replace(/[\\/]+$/, "");
    const sources = current.paths;
    if (pick) {
      offerDrop(ev.clientX, ev.clientY, sources, dest, current.side);
      return;
    }
    if (sameFolder(sources, dest)) {
      toast("warning", "Already in this folder.");
      return;
    }
    const action = dragAction(dest, ev.ctrlKey || ev.metaKey, false);
    void useApp.getState().beginTransfer(action.move ? "cut" : "copy", sources, dest);
  };

  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key);
    window.removeEventListener("keyup", key);
    window.removeEventListener("contextmenu", menu, true);
    window.removeEventListener("blur", finish);
    stopListeners = null;
    clearSession();
  };

  stopListeners = finish;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key);
  window.addEventListener("keyup", key);
  window.addEventListener("contextmenu", menu, true);
  window.addEventListener("blur", finish);
}
