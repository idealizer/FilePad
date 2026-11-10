import { useEffect, useMemo, useState } from "react";
import { isRemotePath } from "../lib/format";
import { keys } from "../lib/platform";
import { useApp } from "../stores/appStore";
import type { McpTool } from "../types";

export function openTool(tool: McpTool) {
  const properties = tool.schema.properties ?? {};
  const needsForm = Object.keys(properties).length > 0;
  if (needsForm) {
    useApp.setState({ paletteOpen: false, modal: { type: "mcpTool", tool } });
    return;
  }
  if (!tool.readOnly) {
    useApp.setState({ paletteOpen: false, modal: { type: "mcpConfirm", tool, values: {} } });
    return;
  }
  void useApp.getState().runMcp(tool, {});
}

export function CommandPalette() {
  const open = useApp((state) => state.paletteOpen);
  const setPalette = useApp((state) => state.setPalette);
  const mcpTools = useApp((state) => state.mcpTools);
  const activePath = useApp((state) => state.panels[state.active].path);
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  const commands = useMemo(() => [
    { id: "copy", label: "Copy to the other panel", hint: "F5", run: () => void useApp.getState().copyToOther() },
    { id: "move", label: "Move to the other panel", hint: "F6", run: () => void useApp.getState().moveToOther() },
    { id: "mkdir", label: "New folder", hint: "F7", run: () => useApp.getState().askMkdir() },
    { id: "mkfile", label: "New file", hint: "Shift+F7", run: () => useApp.getState().askMkfile() },
    { id: "delete", label: "Delete", hint: "F8", run: () => useApp.getState().askDelete() },
    { id: "rename", label: "Rename", hint: "F2", run: (): void => { useApp.getState().askRename(); } },
    { id: "pattern", label: "Rename with a pattern", run: () => useApp.getState().askPattern() },
    { id: "zip", label: "Send to zip", run: () => useApp.getState().askZip() },
    { id: "convert", label: "Convert picture", run: () => useApp.getState().askConvert() },
    { id: "extract", label: "Extract", run: () => void useApp.getState().extractSelection() },
    { id: "properties", label: "Properties", hint: "Alt+Enter", run: () => useApp.getState().askProperties() },
    { id: "view", label: "Preview in the other panel", hint: "F3", run: () => useApp.getState().previewOther() },
    { id: "open", label: "Open", hint: "F4", run: () => void useApp.getState().openCurrent() },
    { id: "term", label: "Toggle terminal", hint: keys("Ctrl+`"), run: () => useApp.getState().toggleTerminal() },
    { id: "hidden", label: "Toggle hidden files", run: () => useApp.getState().toggleHidden() },
    { id: "colors", label: "Icon colors", run: () => useApp.getState().askColors() },
    { id: "light", label: "Light theme", run: () => useApp.getState().setTheme("light") },
    { id: "dark", label: "Dark theme", run: () => useApp.getState().setTheme("dark") },
    { id: "retro", label: "Retro theme", run: () => useApp.getState().setTheme("retro") },
    { id: "about", label: "About FilePad", run: () => useApp.getState().askAbout() },
    { id: "sftp", label: "Connect with SFTP", run: () => useApp.getState().askSftp() },
    { id: "sftp-off", label: "Disconnect SFTP", disabled: !isRemotePath(activePath), run: (): void => { void useApp.getState().disconnectSftp(); } },
    { id: "servers", label: "MCP servers", run: () => useApp.getState().askServers() },
    { id: "mcp-refresh", label: "List MCP tools", hint: "Runs saved servers", run: () => void useApp.getState().refreshMcp().catch(() => undefined) },
    ...mcpTools.map((tool) => ({
      id: `mcp-${tool.serverId}-${tool.name}`,
      label: `${tool.serverName}: ${tool.name}`,
      hint: tool.readOnly ? "Read" : "Confirm",
      run: () => openTool(tool),
    })),
  ], [activePath, mcpTools]);
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
