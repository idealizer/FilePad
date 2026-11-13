import { AppWindow, ArrowRightLeft, Columns2, Command, Copy, Eye, FilePlus, FolderOpen, FolderPlus, Ghost, Keyboard, Link2, Minus, Monitor, Moon, Palette, Pencil, Plus, Square, SquareTerminal, Sun, Terminal, Trash2, Unlink, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { inTauri, isWindows, keys } from "../lib/platform";
import { useApp } from "../stores/appStore";
import type { ThemeMode } from "../types";
import { Dropdown, MenuItem } from "./Menu";

function RestoreMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4.25" y="1.75" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <rect x="2.25" y="4.75" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function WindowCaption() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!inTauri()) return;
    let stop = () => {};
    let cancel = false;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const paint = () => {
        void win.isMaximized().then((value) => {
          if (!cancel) setMaximized(value);
        });
      };
      paint();
      const unlisten = await win.onResized(paint);
      if (cancel) unlisten();
      else stop = unlisten;
    })();
    return () => {
      cancel = true;
      stop();
    };
  }, []);
  const run = (action: "minimize" | "toggle" | "close") => {
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      if (action === "minimize") await win.minimize();
      else if (action === "toggle") await win.toggleMaximize();
      else await win.close();
    })();
  };
  return (
    <div className="fp-caption">
      <button type="button" data-tip="Minimize" data-tip-align="end" aria-label="Minimize" onClick={() => run("minimize")}><Minus /></button>
      <button type="button" data-tip={maximized ? "Restore" : "Maximize"} data-tip-align="end" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => run("toggle")}>{maximized ? <RestoreMark /> : <Square />}</button>
      <button type="button" data-close data-tip="Close" data-tip-align="end" aria-label="Close" onClick={() => run("close")}><X /></button>
    </div>
  );
}

const themes: { id: ThemeMode; label: string; icon: ReactNode }[] = [
  { id: "light", label: "Light", icon: <Sun /> },
  { id: "dark", label: "Dark", icon: <Moon /> },
  { id: "retro", label: "Retro", icon: <Columns2 /> },
  { id: "green", label: "Green", icon: <SquareTerminal /> },
  { id: "system", label: "System", icon: <Monitor /> },
];

export function Toolbar() {
  const theme = useApp((state) => state.theme);
  const setTheme = useApp((state) => state.setTheme);
  const chrome = useApp((state) => state.chrome);
  const setChrome = useApp((state) => state.setChrome);
  const showHidden = useApp((state) => state.showHidden);
  const toggleHidden = useApp((state) => state.toggleHidden);
  const iconColors = useApp((state) => state.iconColors);
  const askColors = useApp((state) => state.askColors);
  const terminalOpen = useApp((state) => state.terminalOpen);
  const toggleTerminal = useApp((state) => state.toggleTerminal);
  const keyBar = useApp((state) => state.keyBar);
  const toggleKeyBar = useApp((state) => state.toggleKeyBar);
  const scrollLock = useApp((state) => state.scrollLock);
  const toggleScrollLock = useApp((state) => state.toggleScrollLock);
  const split = useApp((state) => state.split);
  const askMkdir = useApp((state) => state.askMkdir);
  const askMkfile = useApp((state) => state.askMkfile);
  const askAbout = useApp((state) => state.askAbout);
  const folderAppSupported = useApp((state) => state.folderAppSupported);
  const folderApp = useApp((state) => state.folderApp);
  const setFolderApp = useApp((state) => state.setFolderApp);
  const pathStyle = useApp((state) => state.pathStyle);
  const setPathStyle = useApp((state) => state.setPathStyle);
  const askRename = useApp((state) => state.askRename);
  const askDelete = useApp((state) => state.askDelete);
  const copyToOther = useApp((state) => state.copyToOther);
  const moveToOther = useApp((state) => state.moveToOther);
  const previewOther = useApp((state) => state.previewOther);
  const setPalette = useApp((state) => state.setPalette);
  const index = Math.max(0, themes.findIndex((item) => item.id === theme));
  const current = themes[index];
  const next = themes[(index + 1) % themes.length];
  const caption = isWindows && inTauri();
  return (
    <header
      className="fp-chrome relative flex h-11 shrink-0 items-center gap-0.5 border-b border-[var(--border)] bg-[var(--bg)] px-2"
      onMouseDown={(event) => {
        if (!caption || event.button !== 0) return;
        const target = event.target;
        if (!(target instanceof HTMLElement) || target.closest("button, a, input, select, textarea")) return;
        if (event.detail === 2) {
          void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().toggleMaximize());
          return;
        }
        void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().startDragging());
      }}
    >
      {isWindows ? (
        <Dropdown
          button={({ open, toggle }) => (
            <button className="tb-btn font-semibold text-[var(--text)]" data-active={open} data-tip="FilePad" onClick={toggle}>FilePad</button>
          )}
        >
          {(close) => (
            <>
              {folderAppSupported && (
                <MenuItem
                  icon={<FolderOpen />}
                  label="Open folders in FilePad"
                  hint={folderApp ? "On" : "Off"}
                  title="Folders from the desktop, File Explorer, and Win+E open in FilePad. Open and Save windows still use File Explorer."
                  onClick={() => { close(); void setFolderApp(!folderApp); }}
                />
              )}
              <MenuItem
                label="Breadcrumb path"
                hint={pathStyle === "breadcrumb" ? "On" : "Off"}
                title="Each folder in the path opens the folders inside it. Off shows the path as text."
                onClick={() => { close(); setPathStyle(pathStyle === "breadcrumb" ? "text" : "breadcrumb"); }}
              />
              <MenuItem label="About" onClick={() => { close(); askAbout(); }} />
            </>
          )}
        </Dropdown>
      ) : (
        <button className="tb-btn font-semibold text-[var(--text)]" data-tip="About FilePad" onClick={askAbout}>FilePad</button>
      )}
      <span className="tb-sep" />
      <Dropdown
        button={({ open, toggle }) => (
          <button className="tb-btn" data-active={open} data-tip="New" onClick={toggle}><Plus />New</button>
        )}
      >
        {(close) => (
          <>
            <MenuItem icon={<FolderPlus />} label="Folder" hint="F7" onClick={() => { close(); askMkdir(); }} />
            <MenuItem icon={<FilePlus />} label="File" hint={keys("Shift+F7")} onClick={() => { close(); askMkfile(); }} />
          </>
        )}
      </Dropdown>
      <button className="tb-btn" data-tip="Copy to the other panel (F5)" onClick={() => void copyToOther()}><Copy /></button>
      <button className="tb-btn" data-tip="Move to the other panel (F6)" onClick={() => void moveToOther()}><ArrowRightLeft /></button>
      <button className="tb-btn" data-tip="Rename (F2)" onClick={askRename}><Pencil /></button>
      <button className="tb-btn" data-tip="Delete (F8)" onClick={askDelete}><Trash2 /></button>
      <span className="tb-sep" />
      <button className="tb-btn" data-tip="Preview in the other panel (F3)" onClick={previewOther}><Eye /></button>
      <button className="tb-btn" data-active={showHidden} data-tip={showHidden ? "Hidden files are visible" : "Hidden files are off"} onClick={toggleHidden}><Ghost /></button>
      <button className="tb-btn" data-tip={iconColors ? "Icon colors" : "Icon colors are off"} onClick={askColors}><span className={iconColors ? undefined : "fp-strike"}><Palette /></span></button>
      <button className="tb-btn" data-active={terminalOpen} data-tip={`Terminal (${keys("Ctrl+`")})`} onClick={toggleTerminal}><Terminal /></button>
      <button className="tb-btn" data-tip={keyBar ? "Hide function keys" : "Show function keys"} onClick={toggleKeyBar}><span className={keyBar ? undefined : "fp-strike"}><Keyboard /></span></button>
      <span className="flex-1" />
      <button
        className="tb-btn fp-scroll-lock"
        style={{ left: `calc(var(--frame-gap) + ${split} * (100% - 2 * var(--frame-gap)) + var(--split-size) / 2)` }}
        data-active={scrollLock}
        data-tip={scrollLock ? "Unlock scroll" : "Lock scroll"}
        aria-pressed={scrollLock}
        onClick={toggleScrollLock}
      >
        {scrollLock ? <Link2 /> : <Unlink />}
      </button>
      <button className="tb-btn" data-tip={`Commands (${keys("Ctrl+K")})`} onClick={() => setPalette(true)}><Command /></button>
      <button className="tb-btn" data-tip={`${current.label}. Switch to ${next.label}`} onClick={() => setTheme(next.id)}>{current.icon}</button>
      <button className="tb-btn" data-active={chrome === "modern"} data-tip={chrome === "modern" ? "Modern. Switch to Classic" : "Classic. Switch to Modern"} onClick={() => setChrome(chrome === "modern" ? "classic" : "modern")}><AppWindow /></button>
      {caption && <span className="tb-sep" />}
      {caption && <WindowCaption />}
    </header>
  );
}
