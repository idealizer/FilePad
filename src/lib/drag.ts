import { useSyncExternalStore } from "react";
import { isPackedPath, isRemotePath, parentPath, remoteParts } from "./format";
import { invoke, message } from "./platform";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";

export interface DragSession {
  paths: string[];
  x: number;
  y: number;
  move: boolean;
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

function volumeOf(path: string): string | null {
  if (isPackedPath(path)) return null;
  if (isRemotePath(path)) {
    const remote = remoteParts(path);
    return remote ? `sftp:${remote.id}` : null;
  }
  if (path.startsWith("\\\\") || path.startsWith("//")) {
    const parts = path.split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) return null;
    return `unc:${parts[0].toLowerCase()}\\${parts[1].toLowerCase()}`;
  }
  const drive = /^([a-zA-Z]:)/.exec(path);
  return drive ? drive[1].toLowerCase() : null;
}

function sameVolume(paths: string[], dest: string): boolean {
  const from = volumeOf(paths[0] ?? "");
  if (!from) return false;
  return paths.every((path) => volumeOf(path) === from) && volumeOf(dest) === from;
}

function dragAction(paths: string[], dest: string | null, shift: boolean, ctrl: boolean): { move: boolean; hint: string } {
  if (!dest) return { move: false, hint: "Release to cancel" };
  if (ctrl) return { move: false, hint: "Ctrl copies" };
  if (shift) return { move: true, hint: "Shift moves" };
  return sameVolume(paths, dest) ? { move: true, hint: "Same drive" } : { move: false, hint: "Different drive" };
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
      const place = hit(ev.clientX, ev.clientY);
      showSession({ paths, x: ev.clientX, y: ev.clientY, ...dragAction(paths, place.over, ev.shiftKey, ev.ctrlKey || ev.metaKey), ...place });
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
    showSession({ ...session, x: ev.clientX, y: ev.clientY, ...dragAction(session.paths, place.over, ev.shiftKey, ev.ctrlKey || ev.metaKey), ...place });
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
    const place = { over: session.over, side: session.side };
    showSession({ ...session, ...dragAction(session.paths, place.over, ev.shiftKey, ev.ctrlKey || ev.metaKey) });
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
    const action = dragAction(sources, dest, ev.shiftKey, ev.ctrlKey || ev.metaKey);
    void useApp.getState().beginTransfer(action.move ? "cut" : "copy", sources, dest);
  };

  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key);
    window.removeEventListener("keyup", key);
    window.removeEventListener("blur", finish);
    stopListeners = null;
    clearSession();
  };

  stopListeners = finish;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("keydown", key);
  window.addEventListener("keyup", key);
  window.addEventListener("blur", finish);
}
