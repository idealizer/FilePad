export type Side = "left" | "right";
export type ViewMode = "files" | "details" | "icons" | "tree" | "preview";
export type ThemeMode = "light" | "dark" | "system" | "retro";
export type SortKey = "name" | "size" | "modified" | "type";
export type ToastKind = "success" | "error" | "warning";

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  extension: string;
  hidden: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: Entry[];
}

export interface Place {
  name: string;
  path: string;
  kind: "place" | "drive";
  role?: string;
}

export interface Panel {
  path: string;
  parent: string | null;
  entries: Entry[];
  cursor: number;
  anchor: number;
  marked: string[];
  view: ViewMode;
  listView: "files" | "details" | "icons";
  filter: string;
  sortKey: SortKey;
  sortAsc: boolean;
  loading: boolean;
  error: string | null;
  treeKids: Record<string, Entry[]>;
  treeExpanded: string[];
  savedView: ViewMode;
  history: string[];
  historyAt: number;
  viewHistory: ViewMode[];
  localPath: string;
  iconSize: number;
}

export interface Clipboard {
  mode: "copy" | "cut";
  paths: string[];
}

export interface TransferProgress {
  done: number;
  total: number;
  current: string;
  label?: string;
}

export interface ConvertReport {
  written: number;
  skipped: number;
  reason: string | null;
}

export interface TransferResult {
  done: number;
  conflicts: string[];
}

export interface PendingTransfer {
  mode: "copy" | "cut";
  sources: string[];
  dest: string;
  note?: string;
}

export interface ItemDetails {
  name: string;
  path: string;
  location: string;
  kind: string;
  isDir: boolean;
  size: number;
  sizeKnown: boolean;
  modified: number;
  created: number;
  accessed: number;
  hidden: boolean;
  readOnly: boolean;
  files: number;
  folders: number;
  counted: boolean;
}

export type ModalState =
  | { type: "delete"; paths: string[] }
  | { type: "mkdir" }
  | { type: "mkfile" }
  | { type: "about" }
  | { type: "colors" }
  | { type: "rename"; path: string; name: string }
  | { type: "renameMany"; items: { path: string; name: string; modified: number; isDir: boolean }[]; taken: string[] }
  | { type: "zip"; paths: string[]; side: Side; name: string }
  | { type: "convert"; paths: string[]; side: Side }
  | { type: "properties"; paths: string[] }
  | { type: "overwrite"; transfer: PendingTransfer; conflicts: string[] }
  | { type: "sftp"; draft?: SftpDraft }
  | { type: "sftpResume"; items: { side: Side; path: string; label: string }[] }
  | { type: "hostKey"; draft: SftpDraft; fingerprint: string; pinned: string | null; status: string }
  | { type: "sftpOffer"; offer: ConnectOffer }
  | { type: "servers" }
  | { type: "mcpTool"; tool: McpTool }
  | { type: "mcpConfirm"; tool: McpTool; values: Record<string, string> };

export interface SftpDraft {
  profileId?: string;
  label: string;
  host: string;
  port: string;
  username: string;
  password: string;
  privateKey: string;
  passphrase: string;
  remotePath: string;
  pendingId?: string;
}

export interface SftpProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
  fingerprint: string;
}

export interface ConnectOffer {
  pendingId: string;
  host: string;
  port: number;
  username: string;
  remotePath: string;
}

export interface McpServerInfo {
  id: string;
  name: string;
  transport: string;
  command: string;
  args: string[];
  envKeys: string[];
  url: string;
  headerKeys: string[];
}

export interface McpTool {
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  schema: { properties?: Record<string, { type?: string | string[]; description?: string }>; required?: string[] };
  readOnly: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  side: Side;
  paths: string[];
}

export interface CmdChunk {
  id: string;
  text: string;
  done: boolean;
  code: number | null;
}

export interface PreviewFile {
  kind: string;
  name: string;
  path: string;
  size: number;
  extension: string;
  truncated: boolean;
  scaled: boolean;
  width: number;
  height: number;
  mime: string | null;
  text: string | null;
  dataBase64: string | null;
  posterMime: string | null;
  posterBase64: string | null;
}
