import { useEffect, useMemo, useState } from "react";
import { keys } from "../lib/platform";
import { useApp } from "../stores/appStore";

export function CommandPalette() {
  const open = useApp((state) => state.paletteOpen);
  const setPalette = useApp((state) => state.setPalette);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  const commands = useMemo(() => [
    { id: "copy", label: "Copy to the other panel", hint: "F5", run: () => void useApp.getState().copyToOther() },
    { id: "move", label: "Move to the other panel", hint: "F6", run: () => void useApp.getState().moveToOther() },
    { id: "mkdir", label: "New folder", hint: "F7", run: () => useApp.getState().askMkdir() },
    { id: "delete", label: "Delete", hint: "F8", run: () => useApp.getState().askDelete() },
    { id: "rename", label: "Rename", hint: "F2", run: () => useApp.getState().askRename() },
    { id: "pattern", label: "Rename with a pattern", run: () => useApp.getState().askPattern() },
    { id: "zip", label: "Send to zip", run: () => useApp.getState().askZip() },
    { id: "view", label: "Preview in the other panel", hint: "F3", run: () => useApp.getState().previewOther() },
    { id: "open", label: "Open", hint: "F4", run: () => void useApp.getState().openCurrent() },
    { id: "term", label: "Toggle terminal", hint: keys("Ctrl+`"), run: () => useApp.getState().toggleTerminal() },
    { id: "hidden", label: "Toggle hidden files", run: () => useApp.getState().toggleHidden() },
    { id: "light", label: "Light theme", run: () => useApp.getState().setTheme("light") },
    { id: "dark", label: "Dark theme", run: () => useApp.getState().setTheme("dark") },
    { id: "retro", label: "Retro theme", run: () => useApp.getState().setTheme("retro") },
    { id: "mcp", label: "Run MCP tool", hint: "Later", disabled: true, run: () => undefined },
  ], []);
  if (!open) return null;
  const shown = commands.filter((command) => command.label.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/35 px-6 pt-24" onMouseDown={() => setPalette(false)}>
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
        <input className="field w-full rounded-none border-0 border-b" autoFocus placeholder="Command" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="max-h-80 overflow-auto p-1">
          {shown.map((command) => (
            <button
              key={command.id}
              className="menu-item"
              disabled={command.disabled}
              onClick={() => {
                if (command.disabled) return;
                setPalette(false);
                command.run();
              }}
            >
              <span className="min-w-0 flex-1 truncate">{command.label}</span>
              {command.hint && <span className="hint">{command.hint}</span>}
            </button>
          ))}
          {!shown.length && <div className="px-2 py-3 text-[var(--muted)]">No matching commands</div>}
        </div>
      </div>
    </div>
  );
}
