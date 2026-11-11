import { ArrowRightLeft, Columns2, Command, Copy, Eye, FilePlus, FolderPlus, Ghost, Keyboard, Link2, Monitor, Moon, Palette, Pencil, Plus, Sun, Terminal, Trash2, Unlink } from "lucide-react";
import type { ReactNode } from "react";
import { keys } from "../lib/platform";
import { useApp } from "../stores/appStore";
import type { ThemeMode } from "../types";
import { Dropdown, MenuItem } from "./Menu";

const themes: { id: ThemeMode; label: string; icon: ReactNode }[] = [
  { id: "light", label: "Light", icon: <Sun /> },
  { id: "dark", label: "Dark", icon: <Moon /> },
  { id: "retro", label: "Retro", icon: <Columns2 /> },
  { id: "system", label: "System", icon: <Monitor /> },
];

export function Toolbar() {
  const theme = useApp((state) => state.theme);
  const setTheme = useApp((state) => state.setTheme);
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
  const askRename = useApp((state) => state.askRename);
  const askDelete = useApp((state) => state.askDelete);
  const copyToOther = useApp((state) => state.copyToOther);
  const moveToOther = useApp((state) => state.moveToOther);
  const previewOther = useApp((state) => state.previewOther);
  const setPalette = useApp((state) => state.setPalette);
  const index = Math.max(0, themes.findIndex((item) => item.id === theme));
  const current = themes[index];
  const next = themes[(index + 1) % themes.length];
  return (
    <header className="relative flex h-11 shrink-0 items-center gap-0.5 border-b border-[var(--border)] bg-[var(--bg)] px-2">
      <button className="tb-btn font-semibold text-[var(--text)]" data-tip="About FilePad" onClick={askAbout}>FilePad</button>
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
        style={{ left: `calc(4px + ${split} * (100% - 8px) + 5px)` }}
        data-active={scrollLock}
        data-tip={scrollLock ? "Unlock scroll" : "Lock scroll"}
        aria-pressed={scrollLock}
        onClick={toggleScrollLock}
      >
        {scrollLock ? <Link2 /> : <Unlink />}
      </button>
      <button className="tb-btn" data-tip={`Commands (${keys("Ctrl+K")})`} onClick={() => setPalette(true)}><Command /></button>
      <button className="tb-btn" data-tip={`${current.label}. Switch to ${next.label}`} onClick={() => setTheme(next.id)}>{current.icon}</button>
    </header>
  );
}
