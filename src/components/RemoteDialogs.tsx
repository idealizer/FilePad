import { useEffect, useState } from "react";
import { invoke, message } from "../lib/platform";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";
import type { McpServerInfo, SftpDraft } from "../types";

const emptyDraft = (): SftpDraft => ({ label: "", host: "", port: "22", username: "", password: "", privateKey: "", passphrase: "", remotePath: "/" });

export function SftpDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const submitSftp = useApp((state) => state.submitSftp);
  const initial = modal?.type === "sftp" ? modal.draft ?? emptyDraft() : emptyDraft();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  if (modal?.type !== "sftp") return null;
  const set = (patch: Partial<SftpDraft>) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <>
      <h2 className="text-base font-semibold">Connect with SFTP</h2>
      <div className="mt-3 grid gap-2">
        <label className="grid gap-1 text-sm">Label<input className="field" value={draft.label} onChange={(event) => set({ label: event.target.value })} /></label>
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <label className="grid gap-1 text-sm">Host<input className="field" value={draft.host} onChange={(event) => set({ host: event.target.value })} /></label>
          <label className="grid gap-1 text-sm">Port<input className="field" value={draft.port} onChange={(event) => set({ port: event.target.value })} /></label>
        </div>
        <label className="grid gap-1 text-sm">User<input className="field" value={draft.username} onChange={(event) => set({ username: event.target.value })} /></label>
        <label className="grid gap-1 text-sm">Password<input className="field" type="password" value={draft.password} onChange={(event) => set({ password: event.target.value })} /></label>
        <label className="grid gap-1 text-sm">Private key<textarea className="field h-20 py-1 font-mono text-xs" value={draft.privateKey} onChange={(event) => set({ privateKey: event.target.value })} /></label>
        <label className="grid gap-1 text-sm">Key passphrase<input className="field" type="password" value={draft.passphrase} onChange={(event) => set({ passphrase: event.target.value })} /></label>
        <label className="grid gap-1 text-sm">Remote folder<input className="field" value={draft.remotePath} onChange={(event) => set({ remotePath: event.target.value })} /></label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={() => { setBusy(true); void submitSftp(draft).finally(() => setBusy(false)); }}>Connect</button>
      </div>
    </>
  );
}

export function HostKeyDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const submitSftp = useApp((state) => state.submitSftp);
  if (modal?.type !== "hostKey") return null;
  const changed = modal.status === "mismatch";
  return (
    <>
      <h2 className="text-base font-semibold">{changed ? "This server key changed" : "Trust this server key?"}</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">{changed ? "The key no longer matches the one FilePad pinned. Continue only if you expected that." : "FilePad has not seen this server before."}</p>
      <p className="mt-3 break-all font-mono text-xs">{modal.fingerprint}</p>
      {modal.pinned && <p className="mt-2 break-all font-mono text-xs text-[var(--muted)]">Pinned: {modal.pinned}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn primary" onClick={() => void submitSftp(modal.draft, modal.fingerprint, true)}>{changed ? "Pin the new key" : "Trust and connect"}</button>
      </div>
    </>
  );
}

export function SftpOfferDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const submitSftp = useApp((state) => state.submitSftp);
  if (modal?.type !== "sftpOffer") return null;
  const offer = modal.offer;
  const draft: SftpDraft = { ...emptyDraft(), host: offer.host, port: String(offer.port), username: offer.username, remotePath: offer.remotePath, pendingId: offer.pendingId, label: `${offer.username}@${offer.host}` };
  return (
    <>
      <h2 className="text-base font-semibold">Open this server?</h2>
      <p className="mt-2 text-sm">The tool returned an SFTP connection for {offer.username}@{offer.host}:{offer.port}{offer.remotePath}.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={closeModal}>Not now</button>
        <button className="btn primary" onClick={() => void submitSftp(draft)}>Open on this pane</button>
      </div>
    </>
  );
}

export function McpToolDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const runMcp = useApp((state) => state.runMcp);
  const tool = modal?.type === "mcpTool" || modal?.type === "mcpConfirm" ? modal.tool : null;
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => { setValues({}); }, [tool?.serverId, tool?.name]);
  if (!tool || (modal?.type !== "mcpTool" && modal?.type !== "mcpConfirm")) return null;
  const properties = tool.schema.properties ?? {};
  const required = new Set(tool.schema.required ?? []);
  const confirm = modal.type === "mcpConfirm";
  return (
    <>
      <h2 className="text-base font-semibold">{tool.serverName} / {tool.name}</h2>
      {tool.description && <p className="mt-2 text-sm text-[var(--muted)]">{tool.description}</p>}
      {confirm && <p className="mt-2 text-sm">This tool can change something. Run it?</p>}
      {!confirm && (
        <div className="mt-3 grid max-h-80 gap-2 overflow-auto">
          {Object.entries(properties).map(([key, spec]) => {
            const kind = Array.isArray(spec.type) ? spec.type.join(" or ") : spec.type;
            const wide = kind?.includes("object") || kind?.includes("array");
            return (
              <label key={key} className="grid gap-1 text-sm">
                <span>{key}{required.has(key) ? "" : " (optional)"}</span>
                {wide ? (
                  <textarea className="field h-20 py-1 font-mono text-xs" value={values[key] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
                ) : (
                  <input className="field" value={values[key] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))} />
                )}
              </label>
            );
          })}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={closeModal}>Cancel</button>
        {confirm ? (
          <button className="btn primary" onClick={() => void runMcp(tool, modal.values)}>Run</button>
        ) : tool.readOnly ? (
          <button className="btn primary" onClick={() => void runMcp(tool, values)}>Run</button>
        ) : (
          <button className="btn primary" onClick={() => useApp.setState({ modal: { type: "mcpConfirm", tool, values } })}>Continue</button>
        )}
      </div>
    </>
  );
}

export function ServersDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [envText, setEnvText] = useState("");
  const [url, setUrl] = useState("");
  const [headerText, setHeaderText] = useState("");
  const load = async () => {
    try { setServers(await invoke<McpServerInfo[]>("mcp_servers")); } catch (error) { toast("error", message(error)); }
  };
  useEffect(() => { if (modal?.type === "servers") void load(); }, [modal?.type]);
  if (modal?.type !== "servers") return null;
  const fields = (text: string) => text.split(/\r?\n/).flatMap((line) => {
    const cut = line.indexOf("=");
    if (cut <= 0) return [];
    return [{ key: line.slice(0, cut).trim(), value: line.slice(cut + 1) }];
  });
  const save = async () => {
    try {
      await invoke("mcp_save_server", {
        input: { name, transport, command, args: args.trim() ? splitArgs(args) : [], env: fields(envText), url, headers: fields(headerText) },
      });
      setName(""); setCommand(""); setArgs(""); setEnvText(""); setUrl(""); setHeaderText("");
      await load();
      toast("success", "Server saved. Secrets stayed in the credential store.");
    } catch (error) { toast("error", message(error)); }
  };
  return (
    <>
      <h2 className="text-base font-semibold">MCP servers</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">FilePad runs only the servers you add here. A stdio server is a command on this computer.</p>
      <ul className="mt-3 max-h-36 overflow-auto text-sm">
        {servers.map((server) => (
          <li key={server.id} className="flex items-center gap-2 border-b border-[var(--border)] py-1">
            <span className="min-w-0 flex-1 truncate" title={server.transport === "http" ? server.url : `${server.command} ${server.args.join(" ")}`}>{server.name}</span>
            <button className="btn sm" onClick={() => { void invoke("mcp_delete_server", { id: server.id }).then(load).catch((error: unknown) => toast("error", message(error))); }}>Remove</button>
          </li>
        ))}
        {!servers.length && <li className="text-[var(--muted)]">No servers yet.</li>}
      </ul>
      <div className="mt-3 grid gap-2">
        <label className="grid gap-1 text-sm">Name<input className="field" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="flex gap-2 text-sm">
          <button className="btn" data-active={transport === "stdio"} onClick={() => setTransport("stdio")}>Command</button>
          <button className="btn" data-active={transport === "http"} onClick={() => setTransport("http")}>URL</button>
        </div>
        {transport === "stdio" ? (
          <>
            <label className="grid gap-1 text-sm">Command<input className="field" value={command} placeholder="node" onChange={(event) => setCommand(event.target.value)} /></label>
            <label className="grid gap-1 text-sm">Arguments<input className="field" value={args} onChange={(event) => setArgs(event.target.value)} /></label>
            <label className="grid gap-1 text-sm">Environment, one KEY=value per line<textarea className="field h-16 py-1 font-mono text-xs" value={envText} onChange={(event) => setEnvText(event.target.value)} /></label>
          </>
        ) : (
          <>
            <label className="grid gap-1 text-sm">URL<input className="field" value={url} onChange={(event) => setUrl(event.target.value)} /></label>
            <label className="grid gap-1 text-sm">Headers, one Name=value per line<textarea className="field h-16 py-1 font-mono text-xs" value={headerText} onChange={(event) => setHeaderText(event.target.value)} /></label>
          </>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={closeModal}>Close</button>
        <button className="btn primary" onClick={() => void save()}>Save</button>
      </div>
    </>
  );
}

function splitArgs(text: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'(\S*)'|(\S+)/g;
  for (const match of text.matchAll(pattern)) args.push(match[1] ?? match[2] ?? match[3] ?? "");
  return args.filter(Boolean);
}
