import { useEffect, useRef } from "react";
import { CommandLine } from "./components/CommandLine";
import { CommandPalette } from "./components/CommandPalette";
import { ContextMenu } from "./components/ContextMenu";
import { DragLayer } from "./components/DragLayer";
import { KeyBar } from "./components/KeyBar";
import { ModalHost } from "./components/Modal";
import { Panel } from "./components/Panel";
import { StatusBar } from "./components/StatusBar";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { ToastHost } from "./components/Toast";
import { Toolbar } from "./components/Toolbar";
import { iconColumns } from "./components/IconView";
import { inTauri, invoke, isTyping, message, setWindowTitle } from "./lib/platform";
import { actionSide, noteExternalFolder, useApp } from "./stores/appStore";
import type { CmdChunk, ListBatch, ThemeMode, TransferProgress } from "./types";

function SplitPanels() {
  const split = useApp((state) => state.split);
  const setSplit = useApp((state) => state.setSplit);
  const frame = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const ratio = useRef(split);
  return (
    <div ref={frame} className="fp-panes flex min-h-0 min-w-0 flex-1">
      <div ref={left} className="flex min-w-0" style={{ flex: `0 0 ${split * 100}%` }}>
        <Panel side="left" />
      </div>
      <div
        className="fp-split"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize the panels"
        onDoubleClick={() => setSplit(0.5)}
        onPointerDown={(event) => {
          const parent = frame.current;
          const pane = left.current;
          if (!parent || !pane) return;
          event.preventDefault();
          const bounds = parent.getBoundingClientRect();
          const previous = document.body.style.cursor;
          document.body.style.cursor = "col-resize";
          const move = (ev: PointerEvent) => {
            const next = Math.min(0.82, Math.max(0.18, (ev.clientX - bounds.left) / bounds.width));
            ratio.current = next;
            pane.style.flex = `0 0 ${next * 100}%`;
          };
          const stop = () => {
            document.body.style.cursor = previous;
            setSplit(ratio.current);
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", stop);
        }}
      />
      <div className="flex min-w-0 flex-1">
        <Panel side="right" />
      </div>
    </div>
  );
}

function iconStep(store: ReturnType<typeof useApp.getState>, dir: 1 | -1) {
  const side = actionSide(store);
  if (store.panels[side].view !== "icons") return dir;
  return dir * iconColumns(side);
}

function panelView(store: ReturnType<typeof useApp.getState>) {
  return store.panels[actionSide(store)].view;
}

function inTerminal(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(".xterm") !== null;
}

function keepFieldKeys(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".xterm")) return true;
  if (target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLInputElement && (target.type === "range" || target.type === "checkbox" || target.type === "radio");
}

function fileNavKey(key: string): boolean {
  return key === "ArrowDown" || key === "ArrowUp" || key === "PageDown" || key === "PageUp" || key === "Home" || key === "End";
}

function focusFilePanel(store: ReturnType<typeof useApp.getState>) {
  const side = actionSide(store);
  if (store.active !== side) store.setActive(side);
  const panel = document.querySelector<HTMLElement>(`[data-panel="${side}"]`);
  if (panel && document.activeElement !== panel) panel.focus();
}

function resolveTheme(theme: ThemeMode): "light" | "dark" | "retro" | "glass" {
  if (theme === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return theme;
}

export default function App() {
  const boot = useApp((state) => state.boot);
  const persist = useApp((state) => state.persist);
  const theme = useApp((state) => state.theme);
  const pathStyle = useApp((state) => state.pathStyle);
  const ready = useApp((state) => state.ready);
  const leftPath = useApp((state) => state.panels.left.path);
  const rightPath = useApp((state) => state.panels.right.path);
  const leftView = useApp((state) => state.panels.left.view);
  const rightView = useApp((state) => state.panels.right.view);
  const showHidden = useApp((state) => state.showHidden);
  const iconColors = useApp((state) => state.iconColors);
  const leftIconSize = useApp((state) => state.panels.left.iconSize);
  const rightIconSize = useApp((state) => state.panels.right.iconSize);
  const keyBar = useApp((state) => state.keyBar);
  const terminalOpen = useApp((state) => state.terminalOpen);
  const terminalExpanded = useApp((state) => state.terminalExpanded);
  const scrollLock = useApp((state) => state.scrollLock);
  const iconTints = useApp((state) => state.iconTints);
  const leftHistoryAt = useApp((state) => state.panels.left.historyAt);
  const rightHistoryAt = useApp((state) => state.panels.right.historyAt);
  const recent = useApp((state) => state.recent);
  const commandHistory = useApp((state) => state.commandHistory);
  const split = useApp((state) => state.split);
  const outputHeight = useApp((state) => state.outputHeight);
  const terminalHeight = useApp((state) => state.terminalHeight);
  const nameTemplates = useApp((state) => state.nameTemplates);
  const leftNav = useApp((state) => state.leftNav);
  const rightNav = useApp((state) => state.rightNav);
  const pins = useApp((state) => state.pins);
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (useApp.getState().theme === "system") document.documentElement.dataset.theme = media.matches ? "dark" : "light";
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.title = "FilePad";
    void setWindowTitle("FilePad");
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void persist(), 400);
    return () => window.clearTimeout(timer);
  }, [ready, persist, theme, pathStyle, leftPath, rightPath, leftView, rightView, showHidden, iconColors, leftIconSize, rightIconSize, keyBar, scrollLock, iconTints, leftHistoryAt, rightHistoryAt, recent, commandHistory, split, outputHeight, terminalHeight, nameTemplates, leftNav, rightNav, pins]);

  useEffect(() => {
    if (!inTauri()) return;
    let unlistenCmd: (() => void) | undefined;
    let unlistenTransfer: (() => void) | undefined;
    let unlistenDrop: (() => void) | undefined;
    let unlistenBridge: (() => void) | undefined;
    let unlistenFolder: (() => void) | undefined;
    let unlistenList: (() => void) | undefined;
    let cancel = false;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const cmd = await listen<CmdChunk>("cmd-output", (event) => useApp.getState().onCmd(event.payload));
      const transfer = await listen<TransferProgress>("transfer-progress", (event) => useApp.getState().onTransfer(event.payload));
      const bridge = await listen<{ id: string; name: string; arguments?: Record<string, unknown> }>("bridge-request", (event) => {
        void (async () => {
          try {
            const result = await useApp.getState().applyBridge(event.payload.name, event.payload.arguments ?? {});
            await invoke("bridge_reply", { id: event.payload.id, ok: true, result, error: null });
          } catch (error) {
            await invoke("bridge_reply", { id: event.payload.id, ok: false, result: null, error: message(error) });
          }
        })();
      });
      const folder = await listen<string>("open-folder", (event) => noteExternalFolder(event.payload));
      const listed = await listen<ListBatch>("list-batch", (event) => useApp.getState().onListBatch(event.payload));
      const drop = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const state = useApp.getState();
        void state.beginTransfer("copy", event.payload.paths, state.panels[state.active].path);
      });
      if (cancel) {
        cmd();
        transfer();
        drop();
        bridge();
        folder();
        listed();
        return;
      }
      unlistenCmd = cmd;
      unlistenTransfer = transfer;
      unlistenDrop = drop;
      unlistenBridge = bridge;
      unlistenFolder = folder;
      unlistenList = listed;
    })();
    return () => {
      cancel = true;
      unlistenCmd?.();
      unlistenTransfer?.();
      unlistenDrop?.();
      unlistenBridge?.();
      unlistenFolder?.();
      unlistenList?.();
    };
  }, []);

  useEffect(() => {
    let editing = false;
    let pointer = false;
    const onPointer = () => {
      pointer = true;
      window.setTimeout(() => {
        pointer = false;
      }, 300);
    };
    const onBlur = () => {
      const el = document.activeElement;
      editing = el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || el.closest(".xterm") !== null);
    };
    const onFocus = () => {
      const store = useApp.getState();
      if (editing || pointer || store.modal || store.paletteOpen) return;
      focusFilePanel(store);
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const store = useApp.getState();
      if (store.contextMenu && !store.modal && !store.paletteOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          store.closeContext();
        }
        return;
      }
      if (store.paletteOpen || store.modal) {
        if (event.key === "Escape") {
          event.preventDefault();
          store.closeModal();
        } else if (store.modal?.type === "delete" && event.key === "Enter" && !event.repeat && !isTyping(event.target)) {
          const target = event.target;
          if (target instanceof HTMLElement && target.closest("form")) return;
          event.preventDefault();
          void store.confirmDelete();
        }
        return;
      }
      if (event.key === "Tab") {
        if (inTerminal(event.target)) return;
        event.preventDefault();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        store.cyclePanel(event.shiftKey ? -1 : 1);
        return;
      }
      const typing = isTyping(event.target);
      const key = event.key;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod && !event.altKey && fileNavKey(key) && !keepFieldKeys(event.target)) {
        if (isTyping(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        const el = document.activeElement;
        const field = el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
        if (!field) focusFilePanel(store);
        const live = useApp.getState();
        const step = key === "ArrowDown" || key === "ArrowUp" ? iconStep(live, key === "ArrowDown" ? 1 : -1) : key === "PageDown" ? 12 : key === "PageUp" ? -12 : key === "Home" ? -100000 : 100000;
        live.moveCursor(step, event.shiftKey && (key === "ArrowDown" || key === "ArrowUp" || key === "PageDown" || key === "PageUp"));
        return;
      }
      if (key === "F2") { if (isTyping(event.target)) return; event.preventDefault(); store.askRename(); return; }
      if (!inTerminal(event.target)) {
        if (key === "F3") { event.preventDefault(); store.previewOther(); return; }
        if (key === "F4") { event.preventDefault(); void store.openCurrent(); return; }
        if (key === "F5") { event.preventDefault(); void store.copyToOther(); return; }
        if (key === "F6") { event.preventDefault(); void store.moveToOther(); return; }
        if (key === "F7") { event.preventDefault(); if (event.shiftKey) store.askMkfile(); else store.askMkdir(); return; }
        if (key === "F8") { event.preventDefault(); store.askDelete(); return; }
      }
      if (event.altKey && key === "Enter") { event.preventDefault(); store.askProperties(); return; }
      if (event.altKey && !mod && (key === "ArrowLeft" || key === "ArrowRight")) {
        event.preventDefault();
        void store.goHistory(store.active, key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (mod && key.toLowerCase() === "k") { event.preventDefault(); store.setPalette(true); return; }
      if (mod && (key === "`" || event.code === "Backquote")) { event.preventDefault(); store.toggleTerminal(); return; }
      if (key === "Escape") {
        if (isTyping(event.target)) return;
        const side = actionSide(store);
        const selected = store.panels.left.marked.length + store.panels.right.marked.length > 0 || store.panels[side].cursor >= 0;
        if (selected) store.clearMarks();
        else if (store.outputOpen) store.setOutputOpen(false);
        return;
      }
      if (key === "Enter" && !event.altKey && !mod && !event.repeat && !document.querySelector(".menu")) {
        const commit = document.querySelector<HTMLButtonElement>("[data-trim-commit]");
        const inTrim = event.target instanceof HTMLElement && Boolean(event.target.closest(".fp-trim, .fp-frame"));
        if (commit && !commit.disabled && (!typing || inTrim)) {
          event.preventDefault();
          event.stopPropagation();
          commit.click();
          return;
        }
      }
      if (typing) return;
      if (mod && key.toLowerCase() === "a") { event.preventDefault(); store.markAll(); return; }
      if (mod && key.toLowerCase() === "c") { event.preventDefault(); store.copySelection(); return; }
      if (mod && key.toLowerCase() === "x") { event.preventDefault(); store.cutSelection(); return; }
      if (mod && key.toLowerCase() === "v") { event.preventDefault(); void store.paste(); return; }
      if (mod && key.toLowerCase() === "f") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(`[data-panel="${store.active}"] .fp-filter`)?.focus();
        return;
      }
      if (key === "ArrowDown") { event.preventDefault(); store.moveCursor(iconStep(store, 1), event.shiftKey); return; }
      if (key === "ArrowUp") { event.preventDefault(); store.moveCursor(iconStep(store, -1), event.shiftKey); return; }
      if (key === "ArrowLeft" && panelView(store) === "icons") { event.preventDefault(); store.moveCursor(-1, event.shiftKey); return; }
      if (key === "ArrowRight" && panelView(store) === "icons") { event.preventDefault(); store.moveCursor(1, event.shiftKey); return; }
      if (key === "PageDown") { event.preventDefault(); store.moveCursor(12, event.shiftKey); return; }
      if (key === "PageUp") { event.preventDefault(); store.moveCursor(-12, event.shiftKey); return; }
      if (key === "Home") { event.preventDefault(); store.moveCursor(-100000, false); return; }
      if (key === "End") { event.preventDefault(); store.moveCursor(100000, false); return; }
      if (key === " ") {
        event.preventDefault();
        const side = actionSide(store);
        store.toggleMark(side, store.panels[side].cursor, true);
        return;
      }
      if (key === "Enter") { event.preventDefault(); void store.openEntry(); return; }
      if (key === "Backspace") { event.preventDefault(); void store.goParent(); return; }
      if (key === "Delete") { event.preventDefault(); store.askDelete(); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <Toolbar />
      {!(terminalOpen && terminalExpanded) && <SplitPanels />}
      {!(terminalOpen && terminalExpanded) && <CommandLine />}
      <TerminalDrawer />
      {keyBar && <KeyBar />}
      <StatusBar />
      <ToastHost />
      <ModalHost />
      <ContextMenu />
      <DragLayer />
      <CommandPalette />
    </div>
  );
}
