export type Side = "left" | "right";
export type ViewMode = "files" | "details" | "tree" | "preview";
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
}

export interface Panel {
  path: string;
  parent: string | null;
  entries: Entry[];
  cursor: number;
  anchor: number;
  marked: string[];
  view: ViewMode;
  listView: "files" | "details";
  filter: string;
  sortKey: SortKey;
  sortAsc: boolean;
  loading: boolean;
  error: string | null;
  treeKids: Record<string, Entry[]>;
  treeExpanded: string[];
  savedView: ViewMode;
}

export interface Clipboard {
  mode: "copy" | "cut";
  paths: string[];
}

export interface TransferProgress {
  done: number;
  total: number;
  current: string;
}

export interface TransferResult {
  done: number;
  conflicts: string[];
}

export interface PendingTransfer {
  mode: "copy" | "cut";
  sources: string[];
  dest: string;
}

export type ModalState =
  | { type: "delete"; paths: string[] }
  | { type: "mkdir" }
  | { type: "rename"; path: string; name: string }
  | { type: "renameMany"; items: { path: string; name: string; modified: number; isDir: boolean }[]; taken: string[] }
  | { type: "zip"; paths: string[]; side: Side; name: string }
  | { type: "overwrite"; transfer: PendingTransfer; conflicts: string[] };

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
  mime: string | null;
  text: string | null;
  dataBase64: string | null;
}
