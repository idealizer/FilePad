import { toast } from "../stores/toastStore";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function keys(combo: string): string {
  if (!isMac) return combo;
  return combo.replaceAll("Ctrl+", "⌘").replaceAll("Alt+", "⌥").replaceAll("Shift+", "⇧");
}

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(command, args);
}

export function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function openExternal(path: string): Promise<void> {
  if (!inTauri()) {
    toast("warning", "Open works in the desktop app.");
    return;
  }
  await invoke("open_item", { path });
}

export async function setWindowTitle(title: string): Promise<void> {
  if (!inTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTitle(title);
}

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable || target.closest(".xterm") !== null;
}
