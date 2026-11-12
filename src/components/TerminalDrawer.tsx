import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { diskFolder, isRemotePath, remoteParts } from "../lib/format";
import { invoke, message } from "../lib/platform";
import { dragHeight } from "./DragBar";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";

function termTheme() {
  const style = getComputedStyle(document.documentElement);
  return {
    background: style.getPropertyValue("--editor").trim() || "#000",
    foreground: style.getPropertyValue("--text").trim() || "#ccc",
    cursor: style.getPropertyValue("--accent").trim() || "#fff",
  };
}

export function TerminalDrawer() {
  const open = useApp((state) => state.terminalOpen);
  const height = useApp((state) => state.terminalHeight);
  const setHeight = useApp((state) => state.setTerminalHeight);
  const theme = useApp((state) => state.theme);
  const toggleTerminal = useApp((state) => state.toggleTerminal);
  const activePath = useApp((state) => state.panels[state.active].path);
  const profiles = useApp((state) => state.sftpProfiles);
  const remote = remoteParts(activePath);
  const title = remote ? profiles.find((profile) => profile.id === remote.id)?.label.trim() || "Server" : "Terminal";
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const started = useRef(false);
  const cleanup = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (!open || started.current || !host.current) return;
    started.current = true;
    const node = host.current;
    const terminal = new Terminal({ fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13, cursorBlink: true, theme: termTheme() });
    const addon = new FitAddon();
    terminal.loadAddon(addon);
    terminal.open(node);
    addon.fit();
    term.current = terminal;
    fit.current = addon;
    const folder = useApp.getState().panels[useApp.getState().active].path;
    const path = isRemotePath(folder) ? folder : diskFolder(folder);
    void invoke("terminal_use", { path, cols: terminal.cols, rows: terminal.rows }).catch((error: unknown) => {
      started.current = false;
      toast("error", message(error));
    });
    const typed = terminal.onData((data) => {
      void invoke("terminal_write", { data: Array.from(new TextEncoder().encode(data)) }).catch(() => undefined);
    });
    cleanup.current.push(() => typed.dispose());
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlisten = await listen<string>("term-data", (event) => {
        const binary = atob(event.payload);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        terminal.write(bytes);
      });
      cleanup.current.push(unlisten);
    });
    const observer = new ResizeObserver(() => {
      addon.fit();
      void invoke("terminal_resize", { cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
    });
    observer.observe(node);
    cleanup.current.push(() => observer.disconnect());
  }, [open]);

  useEffect(() => () => {
    cleanup.current.forEach((dispose) => dispose());
    term.current?.dispose();
  }, []);

  useEffect(() => {
    if (term.current) term.current.options.theme = termTheme();
    if (!open || !fit.current || !term.current) return;
    fit.current.fit();
    const terminal = term.current;
    void invoke("terminal_resize", { cols: terminal.cols, rows: terminal.rows }).catch(() => undefined);
  }, [theme, open]);

  return (
    <div className="fp-term shrink-0 flex-col" style={{ display: open ? "flex" : "none", height }}>
      <div
        className="fp-hdrag"
        title="Drag to resize the terminal"
        onDoubleClick={() => setHeight(240)}
        onPointerDown={(event) => {
          const term = event.currentTarget.parentElement;
          if (term instanceof HTMLElement) dragHeight(event, term, 120, window.innerHeight * 0.7, setHeight);
        }}
      />
      <div className="flex h-8 items-center gap-2 px-2">
        <span className="text-xs text-[var(--muted)]">{title}</span>
        <span className="flex-1" />
        <button
          className="btn sm"
          onClick={() => {
            const folder = useApp.getState().panels[useApp.getState().active].path;
            const path = isRemotePath(folder) ? folder : diskFolder(folder);
            const terminal = term.current;
            void invoke("terminal_use", { path, cols: terminal?.cols ?? 80, rows: terminal?.rows ?? 24 }).catch((error: unknown) => toast("error", message(error)));
          }}
        >
          Use this folder
        </button>
        <button className="btn sm" onClick={toggleTerminal}>Close</button>
      </div>
      <div ref={host} className="min-h-0 flex-1" />
    </div>
  );
}
