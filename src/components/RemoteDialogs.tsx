import { useEffect, useState } from "react";
import { invoke, message } from "../lib/platform";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";
import type { McpServerInfo, SftpDraft } from "../types";

const emptyDraft = (): SftpDraft => ({ label: "", host: "", port: "22", username: "", password: "", privateKey: "", passphrase: "", remotePath: "/" });
const suggestedPorts = ["22", "2222"];

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
      <h2 className="text-base font-semibold">{draft.profileId ? "Edit connection" : "Connect with SFTP"}</h2>
      <div className="mt-3 grid min-w-0 gap-2">
        <label className="grid min-w-0 gap-1 text-sm">Connection name<input className="field w-full min-w-0" placeholder="A name you'll recognize" value={draft.label} onChange={(event) => set({ label: event.target.value })} /></label>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
          <label className="grid min-w-0 gap-1 text-sm">Host<input className="field w-full min-w-0" placeholder="Host name or IP address" spellCheck={false} value={draft.host} onChange={(event) => set({ host: event.target.value })} /></label>
          <label className="grid min-w-0 gap-1 text-sm">Port<input className="field w-full min-w-0" list="sftp-ports" inputMode="numeric" placeholder="22" spellCheck={false} value={draft.port} onChange={(event) => set({ port: event.target.value.replace(/[^\d]/g, "").slice(0, 5) })} /></label>
        </div>
        <datalist id="sftp-ports">
          {suggestedPorts.map((port) => <option key={port} value={port} />)}
        </datalist>
        <p className="text-xs text-[var(--muted)]">Pick 22 or 2222, or type another port. Use the SFTP host from the server. A website name on port 22 is often a different service.</p>
        <label className="grid min-w-0 gap-1 text-sm">User<input className="field w-full min-w-0" placeholder="Username on that server" spellCheck={false} value={draft.username} onChange={(event) => set({ username: event.target.value })} /></label>
        <label className="grid min-w-0 gap-1 text-sm">Password<input className="field w-full min-w-0" type="password" placeholder={draft.profileId ? "Leave blank to keep the saved password" : "Leave blank if you use a key"} value={draft.password} onChange={(event) => set({ password: event.target.value })} /></label>
        <label className="grid min-w-0 gap-1 text-sm">Private key<textarea className="field h-20 w-full min-w-0 py-1 font-mono text-xs" placeholder={draft.profileId ? "Leave blank to keep the saved key" : "Paste a PEM key, or leave blank"} value={draft.privateKey} onChange={(event) => set({ privateKey: event.target.value })} /></label>
        <label className="grid min-w-0 gap-1 text-sm">Key passphrase<input className="field w-full min-w-0" type="password" placeholder="Only if the key has one" value={draft.passphrase} onChange={(event) => set({ passphrase: event.target.value })} /></label>
        <label className="grid min-w-0 gap-1 text-sm">Remote folder<input className="field w-full min-w-0" placeholder="/remote/folder" spellCheck={false} value={draft.remotePath} onChange={(event) => set({ remotePath: event.target.value })} /></label>
        {draft.profileId && <p className="text-xs text-[var(--muted)]">A blank password or key keeps the one already saved.</p>}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={() => { setBusy(true); void submitSftp(draft).finally(() => setBusy(false)); }}>{busy ? "Connecting…" : "Connect"}</button>
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

export function SftpResumeDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const confirmSftpResume = useApp((state) => state.confirmSftpResume);
  if (modal?.type !== "sftpResume") return null;
  const many = modal.items.length > 1;
  return (
    <>
      <h2 className="text-base font-semibold">Reconnect to {many ? "these servers" : "this server"}?</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">FilePad was on a server last time. Reconnect, or stay on the Desktop.</p>
      <ul className="mt-3 text-sm">
        {modal.items.map((item) => (
          <li key={item.side} className="truncate">{item.side === "left" ? "Left" : "Right"}: {item.label}</li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={closeModal}>Stay on Desktop</button>
        <button className="btn primary" onClick={() => void confirmSftpResume()}>Reconnect</button>
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

export function ConnectionsDialog() {
  const modal = useApp((state) => state.modal);
  const profiles = useApp((state) => state.sftpProfiles);
  const closeModal = useApp((state) => state.closeModal);
  const askSftp = useApp((state) => state.askSftp);
  const editConnection = useApp((state) => state.editConnection);
  const askForgetSftp = useApp((state) => state.askForgetSftp);
  if (modal?.type !== "connections") return null;
  return (
    <>
      <h2 className="text-base font-semibold">Connections</h2>
      {profiles.length === 0 && <p className="mt-2 text-sm text-[var(--muted)]">No saved connections yet.</p>}
      <ul className="mt-3 max-h-72 overflow-auto">
        {profiles.map((profile) => (
          <li key={profile.id} className="flex items-center gap-2 border-b border-[var(--border)] py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{profile.label}</div>
              <div className="truncate text-xs text-[var(--muted)]">{profile.host}:{profile.port} · {profile.remotePath}</div>
            </div>
            <button className="btn sm" type="button" onClick={() => editConnection(profile.id)}>Edit</button>
            <button className="btn sm" type="button" onClick={() => askForgetSftp(profile.id)}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" type="button" onClick={closeModal}>Close</button>
        <button className="btn primary" type="button" onClick={() => askSftp()}>New connection</button>
      </div>
    </>
  );
}

export function ForgetConnectionDialog() {
  const modal = useApp((state) => state.modal);
  const askConnections = useApp((state) => state.askConnections);
  const confirmForgetSftp = useApp((state) => state.confirmForgetSftp);
  if (modal?.type !== "forgetSftp") return null;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void confirmForgetSftp();
      }}
    >
      <h2 className="text-base font-semibold">Remove {modal.label}?</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">This deletes the saved connection. Panels still on it return to their last local folder.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" type="button" onClick={askConnections}>Cancel</button>
        <button className="btn danger" type="submit" autoFocus>Remove</button>
      </div>
    </form>
  );
}

function splitArgs(text: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'(\S*)'|(\S+)/g;
  for (const match of text.matchAll(pattern)) args.push(match[1] ?? match[2] ?? match[3] ?? "");
  return args.filter(Boolean);
}
