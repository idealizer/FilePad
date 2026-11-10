import { ArrowRightLeft, Columns2, Command, Copy, Eye, EyeOff, FolderPlus, Monitor, Moon, Pencil, Sun, Terminal, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { keys } from "../lib/platform";
import { useApp } from "../stores/appStore";
import type { ThemeMode } from "../types";

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
  const terminalOpen = useApp((state) => state.terminalOpen);
  const toggleTerminal = useApp((state) => state.toggleTerminal);
  const askMkdir = useApp((state) => state.askMkdir);
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
    <header className="flex h-11 shrink-0 items-center gap-0.5 border-b border-[var(--border)] bg-[var(--bg)] px-2">
      <span className="px-2 font-semibold">FilePad</span>
      <span className="tb-sep" />
      <button className="tb-btn" data-tip="New folder (F7)" onClick={askMkdir}><FolderPlus /></button>
      <button className="tb-btn" data-tip="Copy to the other panel (F5)" onClick={() => void copyToOther()}><Copy /></button>
      <button className="tb-btn" data-tip="Move to the other panel (F6)" onClick={() => void moveToOther()}><ArrowRightLeft /></button>
      <button className="tb-btn" data-tip="Rename (F2)" onClick={askRename}><Pencil /></button>
      <button className="tb-btn" data-tip="Delete (F8)" onClick={askDelete}><Trash2 /></button>
      <span className="tb-sep" />
      <button className="tb-btn" data-tip="Preview in the other panel (F3)" onClick={previewOther}><Eye /></button>
      <button className="tb-btn" data-active={showHidden} data-tip="Show hidden files" onClick={toggleHidden}>{showHidden ? <Eye /> : <EyeOff />}</button>
      <button className="tb-btn" data-active={terminalOpen} data-tip={`Terminal (${keys("Ctrl+`")})`} onClick={toggleTerminal}><Terminal /></button>
      <span className="flex-1" />
      <button className="tb-btn" data-tip={`Commands (${keys("Ctrl+K")})`} onClick={() => setPalette(true)}><Command /></button>
      <button className="tb-btn" data-tip={`${current.label}. Switch to ${next.label}`} onClick={() => setTheme(next.id)}>{current.icon}</button>
    </header>
  );
}
