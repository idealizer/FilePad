import { create } from "zustand";
import { archiveFile, baseName, canExtract, diskFolder, isPackedPath, isRemotePath, isStillImage, joinPath, remoteParts } from "../lib/format";
import type { NameSource, NameTemplate } from "../lib/names";
import { fileRows, treeRows } from "../lib/rows";
import { inTauri, invoke, message, openExternal } from "../lib/platform";
import { readSession, writeSession } from "../lib/session";
import type { Clipboard, CmdChunk, ConnectOffer, ContextMenuState, ConvertReport, DirListing, McpTool, ModalState, Panel, PendingTransfer, Place, SftpDraft, SftpProfile, Side, SortKey, ThemeMode, TransferProgress, TransferResult, ViewMode } from "../types";
import { toast } from "./toastStore";

function emptyPanel(path = ""): Panel {
  return {
    path,
    parent: null,
    entries: [],
    cursor: 0,
    anchor: 0,
    marked: [],
    view: "details",
    listView: "details",
    filter: "",
    sortKey: "name",
    sortAsc: true,
    loading: false,
    error: null,
    treeKids: {},
    treeExpanded: [],
    savedView: "details",
    history: [],
    historyAt: 0,
    localPath: isRemotePath(path) ? "" : path,
  };
}

function isArchiveName(extension: string): boolean {
  return extension === "zip" || extension === "gz" || extension === "gzip" || extension === "tgz";
}

function archiveBrowse(path: string, extension: string): string | null {
  if (isPackedPath(path) || !isArchiveName(extension)) return null;
  return extension === "zip" ? `zip:${path}|` : `gz:${path}|`;
}

function other(side: Side): Side {
  return side === "left" ? "right" : "left";
}

export function actionSide(state: { active: Side; panels: { left: Panel; right: Panel } }): Side {
  if (state.panels[state.active].view !== "preview") return state.active;
  const next = other(state.active);
  return state.panels[next].view === "preview" ? state.active : next;
}

function chosen(state: { showHidden: boolean; panels: { left: Panel; right: Panel } }, side: Side): string[] {
  const panel = state.panels[side];
  if (panel.view === "tree") {
    const row = treeRows(panel, state.showHidden)[panel.cursor];
    return row ? [row.path] : [];
  }
  if (panel.marked.length) return [...panel.marked];
  const row = fileRows(panel, state.showHidden)[panel.cursor];
  if (!row || row.up) return [];
  return [row.path];
}

function patch(panels: { left: Panel; right: Panel }, side: Side, update: Partial<Panel>): { left: Panel; right: Panel } {
  return { ...panels, [side]: { ...panels[side], ...update } };
}

function selectionSources(state: { active: Side; showHidden: boolean; panels: { left: Panel; right: Panel } }): { items: NameSource[]; taken: string[] } {
  const side = actionSide(state);
  const panel = state.panels[side];
  if (panel.view === "tree") {
    const row = treeRows(panel, state.showHidden)[panel.cursor];
    if (!row) return { items: [], taken: [] };
    return { items: [{ path: row.path, name: row.name, modified: 0, isDir: true }], taken: [] };
  }
  const wanted = new Set(chosen(state, side));
  const visible = fileRows(panel, state.showHidden).filter((row) => !row.up && wanted.has(row.path));
  const seen = new Set(visible.map((row) => row.path));
  const extra = panel.entries.filter((entry) => wanted.has(entry.path) && !seen.has(entry.path));
  const items: NameSource[] = [
    ...visible.map((row) => ({ path: row.path, name: row.name, modified: row.modified, isDir: row.isDir })),
    ...extra.map((entry) => ({ path: entry.path, name: entry.name, modified: entry.modified, isDir: entry.isDir })),
  ];
  const taken = panel.entries.filter((entry) => !wanted.has(entry.path)).map((entry) => entry.name);
  return { items, taken };
}

function storedHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).slice(-48);
}

function storedAt(history: string[], value: unknown): number {
  const index = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : history.length - 1;
  if (!history.length) return 0;
  return Math.max(0, Math.min(history.length - 1, index));
}

function storedTints(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const next: Record<string, string> = {};
  for (const [key, color] of Object.entries(value as Record<string, unknown>)) {
    const id = key.toLowerCase();
    if (id !== "folder" && !/^[a-z0-9]{1,12}$/.test(id)) continue;
    if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color)) continue;
    next[id] = color.toLowerCase();
  }
  return next;
}

function storedTemplates(value: NameTemplate[] | undefined): NameTemplate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item.label !== "string" || typeof item.pattern !== "string" || !item.label.trim()) return [];
    return [{
      label: item.label.trim(),
      pattern: item.pattern,
      separator: typeof item.separator === "string" ? item.separator : "_",
      dateFormat: typeof item.dateFormat === "string" ? item.dateFormat : "YYYYMMDD",
    }];
  });
}

interface AppState {
  ready: boolean;
  theme: ThemeMode;
  active: Side;
  panels: { left: Panel; right: Panel };
  showHidden: boolean;
  iconColors: boolean;
  iconTints: Record<string, string>;
  places: Place[];
  recent: string[];
  clipboard: Clipboard | null;
  textpad: boolean;
  command: string;
  commandHistory: string[];
  commandCursor: number;
  commandDraft: string;
  output: string;
  outputOpen: boolean;
  running: boolean;
  runId: string | null;
  terminalOpen: boolean;
  split: number;
  outputHeight: number;
  terminalHeight: number;
  nameTemplates: NameTemplate[];
  transfer: TransferProgress | null;
  modal: ModalState | null;
  contextMenu: ContextMenuState | null;
  paletteOpen: boolean;
  sftpProfiles: SftpProfile[];
  mcpTools: McpTool[];
  boot: () => Promise<void>;
  persist: () => Promise<void>;
  loadPlaces: () => Promise<void>;
  setTheme: (theme: ThemeMode) => void;
  setActive: (side: Side) => void;
  cyclePanel: (dir: 1 | -1) => void;
  navigate: (side: Side, path: string, record?: boolean) => Promise<void>;
  goHistory: (side: Side, dir: -1 | 1) => Promise<void>;
  refresh: (side: Side) => Promise<void>;
  refreshBoth: () => Promise<void>;
  setFilter: (side: Side, filter: string) => void;
  setView: (side: Side, view: ViewMode) => void;
  setSort: (side: Side, key: SortKey) => void;
  moveCursor: (delta: number, mark: boolean) => void;
  toggleMark: (side: Side, index: number, advance: boolean) => void;
  markRange: (side: Side, index: number) => void;
  clickEntry: (side: Side, index: number) => void;
  markAll: () => void;
  clearMarks: () => void;
  openEntry: () => Promise<void>;
  goParent: () => Promise<void>;
  ensureTree: (side: Side, path: string) => Promise<void>;
  toggleTree: (side: Side, path: string) => Promise<void>;
  copySelection: () => void;
  cutSelection: () => void;
  paste: () => Promise<void>;
  copyToOther: () => Promise<void>;
  moveToOther: () => Promise<void>;
  beginTransfer: (mode: "copy" | "cut", sources: string[], dest: string, overwrite?: boolean, note?: string) => Promise<void>;
  askDelete: () => void;
  askMkdir: () => void;
  askMkfile: () => void;
  askAbout: () => void;
  askRename: () => void;
  askPattern: () => void;
  askZip: () => void;
  askConvert: () => void;
  askProperties: (paths?: string[]) => void;
  extractSelection: (paths?: string[]) => Promise<void>;
  confirmDelete: () => Promise<void>;
  confirmMkdir: (name: string) => Promise<void>;
  confirmMkfile: (name: string) => Promise<void>;
  confirmRename: (name: string) => Promise<void>;
  confirmRenameMany: (pairs: { path: string; name: string }[]) => Promise<void>;
  confirmZip: (name: string) => Promise<void>;
  confirmConvert: (format: string, quality: number, background: "white" | "black", replace: boolean) => Promise<void>;
  saveNameTemplate: (template: NameTemplate) => void;
  deleteNameTemplate: (label: string) => void;
  confirmOverwrite: () => Promise<void>;
  closeModal: () => void;
  focusForMenu: (side: Side, index: number, path: string) => void;
  openContext: (menu: ContextMenuState) => void;
  closeContext: () => void;
  openCurrent: () => Promise<void>;
  openInTextpad: () => Promise<void>;
  previewOther: () => void;
  toggleHidden: () => void;
  toggleIconColors: () => void;
  askColors: () => void;
  setIconTint: (id: string, color: string | null) => void;
  resetIconTints: () => void;
  toggleTerminal: () => void;
  setSplit: (split: number) => void;
  setOutputHeight: (height: number) => void;
  setTerminalHeight: (height: number) => void;
  setCommand: (command: string) => void;
  historyStep: (dir: -1 | 1) => void;
  runCommand: () => Promise<void>;
  cancelCommand: () => Promise<void>;
  setOutputOpen: (open: boolean) => void;
  onCmd: (chunk: CmdChunk) => void;
  onTransfer: (progress: TransferProgress) => void;
  setPalette: (open: boolean) => void;
  askSftp: (draft?: SftpDraft) => void;
  submitSftp: (draft: SftpDraft, acceptFingerprint?: string, replacePin?: boolean) => Promise<void>;
  disconnectSftp: (side?: Side) => Promise<void>;
  askServers: () => void;
  refreshMcp: () => Promise<void>;
  runMcp: (tool: McpTool, values: Record<string, string>) => Promise<void>;
  applyBridge: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  theme: "system",
  active: "left",
  panels: { left: emptyPanel(), right: emptyPanel() },
  showHidden: false,
  iconColors: true,
  iconTints: {},
  places: [],
  recent: [],
  clipboard: null,
  textpad: false,
  command: "",
  commandHistory: [],
  commandCursor: -1,
  commandDraft: "",
  output: "",
  outputOpen: false,
  running: false,
  runId: null,
  terminalOpen: false,
  split: 0.5,
  outputHeight: 160,
  terminalHeight: 240,
  nameTemplates: [],
  transfer: null,
  modal: null,
  contextMenu: null,
  paletteOpen: false,
  sftpProfiles: [],
  mcpTools: [],

  boot: async () => {
    const session = await readSession();
    let home = "";
    let places: Place[] = [];
    let textpad = false;
    if (inTauri()) {
      try {
        home = await invoke<string>("home_dir");
        places = await invoke<Place[]>("list_places");
        textpad = await invoke<boolean>("textpad_available");
      } catch (error) {
        toast("error", message(error));
      }
    }
    const listView = (view: ViewMode): Panel["listView"] => (view === "files" || view === "icons" ? view : "details");
    set({
      theme: session.theme,
      showHidden: session.showHidden,
      iconColors: session.iconColors,
      iconTints: storedTints(session.iconTints),
      recent: session.recent,
      commandHistory: session.commandHistory,
      split: clamp(session.split, 0.18, 0.82),
      outputHeight: clamp(session.outputHeight, 72, 800),
      terminalHeight: clamp(session.terminalHeight, 120, 800),
      nameTemplates: storedTemplates(session.nameTemplates),
      places,
      textpad,
      panels: {
        left: {
          ...emptyPanel(),
          view: session.leftView,
          listView: listView(session.leftView),
          history: storedHistory(session.leftHistory),
          historyAt: storedAt(storedHistory(session.leftHistory), session.leftHistoryAt),
        },
        right: {
          ...emptyPanel(),
          view: session.rightView,
          listView: listView(session.rightView),
          history: storedHistory(session.rightHistory),
          historyAt: storedAt(storedHistory(session.rightHistory), session.rightHistoryAt),
        },
      },
    });
    await get().navigate("left", session.leftPath || home);
    await get().navigate("right", session.rightPath || home);
    set({ ready: true });
  },

  persist: async () => {
    const state = get();
    await writeSession({
      theme: state.theme,
      leftPath: state.panels.left.path,
      rightPath: state.panels.right.path,
      leftView: state.panels.left.view,
      rightView: state.panels.right.view,
      showHidden: state.showHidden,
      iconColors: state.iconColors,
      iconTints: state.iconTints,
      leftHistory: state.panels.left.history,
      rightHistory: state.panels.right.history,
      leftHistoryAt: state.panels.left.historyAt,
      rightHistoryAt: state.panels.right.historyAt,
      recent: state.recent,
      commandHistory: state.commandHistory,
      split: state.split,
      outputHeight: state.outputHeight,
      terminalHeight: state.terminalHeight,
      nameTemplates: state.nameTemplates,
    });
  },

  loadPlaces: async () => {
    if (!inTauri()) return;
    try {
      const [places, sftpProfiles] = await Promise.all([
        invoke<Place[]>("list_places"),
        invoke<SftpProfile[]>("sftp_profiles"),
      ]);
      set({ places, sftpProfiles });
    } catch (error) {
      toast("error", message(error));
    }
  },

  setTheme: (theme) => set({ theme }),
  setActive: (side) => set({ active: side }),
  cyclePanel: (dir) => set({ active: dir === 1 ? "right" : "left" }),

  navigate: async (side, raw, record = true) => {
    if (!inTauri()) {
      set((state) => ({ panels: patch(state.panels, side, { loading: false, error: "Open the FilePad window to browse this computer." }) }));
      return;
    }
    set((state) => ({ panels: patch(state.panels, side, { loading: true, error: null }) }));
    try {
      const listing = await invoke<DirListing>("list_dir", { path: raw });
      const recent = [listing.path, ...get().recent.filter((item) => item !== listing.path)].slice(0, 12);
      set((state) => {
        const panel = state.panels[side];
        let history = panel.history;
        let historyAt = panel.historyAt;
        if (record && history[historyAt]?.toLowerCase() !== listing.path.toLowerCase()) {
          history = [...history.slice(0, historyAt + 1), listing.path].slice(-48);
          historyAt = history.length - 1;
        }
        return {
          recent,
          panels: patch(state.panels, side, {
            path: listing.path,
            parent: listing.parent,
            entries: listing.entries,
            cursor: 0,
            anchor: 0,
            marked: [],
            filter: "",
            loading: false,
            error: null,
            treeKids: {},
            treeExpanded: [],
            history,
            historyAt,
            localPath: isRemotePath(listing.path) ? panel.localPath : listing.path,
          }),
        };
      });
      if (get().panels[side].view === "tree") await get().ensureTree(side, listing.path);
    } catch (error) {
      set((state) => ({ panels: patch(state.panels, side, { loading: false, error: message(error) }) }));
      toast("error", message(error));
    }
  },

  goHistory: async (side, dir) => {
    const panel = get().panels[side];
    const next = panel.historyAt + dir;
    const path = panel.history[next];
    if (!path) return;
    const before = panel.path;
    await get().navigate(side, path, false);
    const after = get().panels[side].path;
    if (after.toLowerCase() === before.toLowerCase() && after.toLowerCase() !== path.toLowerCase()) return;
    set((state) => ({ panels: patch(state.panels, side, { historyAt: next }) }));
  },

  refresh: async (side) => {
    const panel = get().panels[side];
    if (!panel.path || !inTauri()) return;
    const currentName = panel.view === "tree"
      ? treeRows(panel, get().showHidden)[panel.cursor]?.name
      : fileRows(panel, get().showHidden)[panel.cursor]?.name;
    try {
      const listing = await invoke<DirListing>("list_dir", { path: panel.path });
      set((state) => {
        const marked = state.panels[side].marked.filter((path) => listing.entries.some((entry) => entry.path === path));
        const next: Panel = { ...state.panels[side], parent: listing.parent, entries: listing.entries, marked, loading: false, error: null, treeKids: {}, treeExpanded: [] };
        const list = next.view === "tree" ? [] : fileRows(next, state.showHidden);
        const index = list.findIndex((row) => row.name === currentName);
        next.cursor = index >= 0 ? index : Math.min(next.cursor, Math.max(0, list.length - 1));
        next.anchor = next.cursor;
        return { panels: { ...state.panels, [side]: next } };
      });
      if (get().panels[side].view === "tree") await get().ensureTree(side, listing.path);
    } catch (error) {
      toast("error", message(error));
    }
  },

  refreshBoth: async () => {
    await get().refresh("left");
    await get().refresh("right");
  },

  setFilter: (side, filter) => set((state) => ({ panels: patch(state.panels, side, { filter, cursor: 0, anchor: 0 }) })),

  setView: (side, view) => {
    set((state) => {
      const panel = state.panels[side];
      const listView = view === "files" || view === "details" || view === "icons" ? view : panel.listView;
      const enteringPreview = view === "preview" && panel.view !== "preview";
      const leavingPreview = panel.view === "preview" && view !== "preview";
      const savedView = enteringPreview ? panel.view : panel.savedView;
      const cursor = enteringPreview || leavingPreview ? panel.cursor : 0;
      return { panels: patch(state.panels, side, { view, listView, savedView, cursor, anchor: cursor }) };
    });
    if (view === "tree") void get().ensureTree(side, get().panels[side].path);
  },

  setSort: (side, key) => set((state) => {
    const panel = state.panels[side];
    const sortAsc = panel.sortKey === key ? !panel.sortAsc : true;
    return { panels: patch(state.panels, side, { sortKey: key, sortAsc }) };
  }),

  moveCursor: (delta, mark) => {
    const state = get();
    const side = actionSide(state);
    const panel = state.panels[side];
    const rows = panel.view === "tree" ? treeRows(panel, state.showHidden) : fileRows(panel, state.showHidden);
    if (!rows.length) return;
    const next = Math.max(0, Math.min(rows.length - 1, panel.cursor + delta));
    if (mark && panel.view !== "tree") {
      const list = fileRows(panel, state.showHidden);
      const lo = Math.min(panel.anchor, next);
      const hi = Math.max(panel.anchor, next);
      const add = list.slice(lo, hi + 1).filter((row) => !row.up).map((row) => row.path);
      set((current) => ({ panels: patch(current.panels, side, { cursor: next, marked: [...new Set([...panel.marked, ...add])] }) }));
      return;
    }
    set((current) => ({ panels: patch(current.panels, side, { cursor: next, anchor: next }) }));
  },

  toggleMark: (side, index, advance) => {
    const state = get();
    const panel = state.panels[side];
    if (panel.view === "tree") {
      const row = treeRows(panel, state.showHidden)[index];
      if (row) void get().toggleTree(side, row.path);
      return;
    }
    const rows = fileRows(panel, state.showHidden);
    const row = rows[index];
    if (!row || row.up) {
      if (advance) get().moveCursor(1, false);
      return;
    }
    const marked = panel.marked.includes(row.path) ? panel.marked.filter((path) => path !== row.path) : [...panel.marked, row.path];
    const cursor = advance ? Math.min(rows.length - 1, index + 1) : index;
    set((current) => ({ panels: patch(current.panels, side, { marked, cursor, anchor: cursor }) }));
  },

  markRange: (side, index) => {
    const state = get();
    const panel = state.panels[side];
    const rows = fileRows(panel, state.showHidden);
    const lo = Math.min(panel.anchor, index);
    const hi = Math.max(panel.anchor, index);
    const add = rows.slice(lo, hi + 1).filter((row) => !row.up).map((row) => row.path);
    set((current) => ({ panels: patch(current.panels, side, { cursor: index, marked: [...new Set([...panel.marked, ...add])] }) }));
  },

  clickEntry: (side, index) => set((state) => ({ panels: patch(state.panels, side, { cursor: index, anchor: index }) })),

  markAll: () => {
    const state = get();
    const side = actionSide(state);
    const paths = fileRows(state.panels[side], state.showHidden).filter((row) => !row.up).map((row) => row.path);
    set((current) => ({ panels: patch(current.panels, side, { marked: paths }) }));
  },

  clearMarks: () => set((state) => ({
    panels: {
      left: { ...state.panels.left, marked: [] },
      right: { ...state.panels.right, marked: [] },
    },
  })),

  openEntry: async () => {
    const state = get();
    const side = actionSide(state);
    const panel = state.panels[side];
    if (panel.view === "tree") {
      const row = treeRows(panel, state.showHidden)[panel.cursor];
      if (!row) return;
      set((current) => ({ panels: patch(current.panels, side, { view: panel.listView }) }));
      await get().navigate(side, row.path);
      return;
    }
    const row = fileRows(panel, state.showHidden)[panel.cursor];
    if (!row) return;
    if (row.up || row.isDir) {
      await get().navigate(side, row.path);
      return;
    }
    const browse = archiveBrowse(row.path, row.extension);
    if (browse) {
      await get().navigate(side, browse);
      return;
    }
    if (isArchiveName(row.extension)) {
      toast("warning", "Copy this archive out to browse inside it.");
      return;
    }
    get().setView(other(side), "preview");
  },

  goParent: async () => {
    const side = actionSide(get());
    const parent = get().panels[side].parent;
    if (parent) await get().navigate(side, parent);
  },

  ensureTree: async (side, path) => {
    if (!path || !inTauri() || get().panels[side].treeKids[path]) return;
    try {
      const listing = await invoke<DirListing>("list_dir", { path });
      set((state) => ({
        panels: patch(state.panels, side, { treeKids: { ...state.panels[side].treeKids, [path]: listing.entries } }),
      }));
    } catch (error) {
      toast("error", message(error));
    }
  },

  toggleTree: async (side, path) => {
    const expanded = get().panels[side].treeExpanded;
    if (expanded.includes(path)) {
      set((state) => ({ panels: patch(state.panels, side, { treeExpanded: expanded.filter((item) => item !== path) }) }));
      return;
    }
    await get().ensureTree(side, path);
    set((state) => ({ panels: patch(state.panels, side, { treeExpanded: [...state.panels[side].treeExpanded, path] }) }));
  },

  copySelection: () => {
    const paths = chosen(get(), actionSide(get()));
    if (!paths.length) {
      toast("warning", "Nothing selected.");
      return;
    }
    set({ clipboard: { mode: "copy", paths } });
    toast("success", paths.length === 1 ? "Copied 1 item." : `Copied ${paths.length} items.`);
  },

  cutSelection: () => {
    const paths = chosen(get(), actionSide(get()));
    if (!paths.length) {
      toast("warning", "Nothing selected.");
      return;
    }
    if (paths.some(isPackedPath)) {
      toast("warning", "Copy files out of an archive. The archive stays unchanged.");
      return;
    }
    set({ clipboard: { mode: "cut", paths } });
    toast("success", paths.length === 1 ? "Ready to move 1 item." : `Ready to move ${paths.length} items.`);
  },

  paste: async () => {
    const clip = get().clipboard;
    if (!clip) {
      toast("warning", "Nothing to paste.");
      return;
    }
    await get().beginTransfer(clip.mode, clip.paths, get().panels[get().active].path);
  },

  copyToOther: async () => {
    const state = get();
    const side = actionSide(state);
    await get().beginTransfer("copy", chosen(state, side), state.panels[other(side)].path);
  },

  moveToOther: async () => {
    const state = get();
    const side = actionSide(state);
    await get().beginTransfer("cut", chosen(state, side), state.panels[other(side)].path);
  },

  beginTransfer: async (mode, sources, dest, overwrite = false, note) => {
    if (!sources.length) {
      toast("warning", "Nothing selected.");
      return;
    }
    if (get().transfer) {
      toast("warning", "Wait for the current copy to finish.");
      return;
    }
    if (!dest) {
      toast("warning", "Choose a destination folder.");
      return;
    }
    set({ transfer: { done: 0, total: 0, current: "Starting" } });
    try {
      const command = mode === "copy" ? "copy_paths" : "move_paths";
      const result = await invoke<TransferResult>(command, { sources, destDir: dest, overwrite });
      if (result.conflicts.length) {
        const transfer: PendingTransfer = { mode, sources, dest, note };
        set({ transfer: null, modal: { type: "overwrite", transfer, conflicts: result.conflicts } });
        return;
      }
      if (mode === "cut") set({ clipboard: null });
      set({ transfer: null, modal: null });
      toast("success", note ?? (mode === "copy" ? "Copied." : "Moved."));
      await get().refreshBoth();
    } catch (error) {
      set({ transfer: null });
      toast("error", message(error));
      await get().refreshBoth();
    }
  },

  askDelete: () => {
    const paths = chosen(get(), actionSide(get()));
    if (!paths.length) {
      toast("warning", "Nothing selected.");
      return;
    }
    if (paths.some(isPackedPath)) {
      toast("warning", "Can't delete files inside an archive.");
      return;
    }
    set({ modal: { type: "delete", paths } });
  },

  askMkdir: () => {
    if (isPackedPath(get().panels[get().active].path)) {
      toast("warning", "Can't create a folder inside an archive.");
      return;
    }
    set({ contextMenu: null, modal: { type: "mkdir" } });
  },

  askMkfile: () => {
    if (isPackedPath(get().panels[get().active].path)) {
      toast("warning", "Can't create a file inside an archive.");
      return;
    }
    set({ contextMenu: null, modal: { type: "mkfile" } });
  },

  askAbout: () => set({ contextMenu: null, paletteOpen: false, modal: { type: "about" } }),

  askRename: () => {
    const found = selectionSources(get());
    if (!found.items.length) {
      toast("warning", "Nothing selected.");
      return;
    }
    if (found.items.some((item) => isPackedPath(item.path))) {
      toast("warning", "Can't rename a file inside an archive. Copy it out first.");
      return;
    }
    if (found.items.length === 1) {
      const item = found.items[0];
      set({ contextMenu: null, modal: { type: "rename", path: item.path, name: item.name } });
      return;
    }
    set({ contextMenu: null, modal: { type: "renameMany", items: found.items, taken: found.taken } });
  },

  askPattern: () => {
    const found = selectionSources(get());
    if (!found.items.length) {
      toast("warning", "Nothing selected.");
      return;
    }
    if (found.items.some((item) => isPackedPath(item.path))) {
      toast("warning", "Can't rename a file inside an archive. Copy it out first.");
      return;
    }
    set({ contextMenu: null, modal: { type: "renameMany", items: found.items, taken: found.taken } });
  },

  askZip: () => {
    const side = actionSide(get());
    const paths = chosen(get(), side);
    if (!paths.length) {
      toast("warning", "Nothing selected.");
      return;
    }
    if (paths.some(isPackedPath) || isPackedPath(get().panels[side].path) || paths.some(isRemotePath) || isRemotePath(get().panels[side].path)) {
      toast("warning", "Copy files to this computer before packing them.");
      return;
    }
    const stem = paths.length === 1 ? baseName(paths[0]).replace(/\.[^.]+$/, "") : "archive";
    set({ contextMenu: null, modal: { type: "zip", paths, side, name: `${stem || "archive"}.zip` } });
  },

  askConvert: () => {
    const side = actionSide(get());
    const paths = chosen(get(), side);
    if (!paths.length) {
      toast("warning", "Nothing selected.");
      return;
    }
    if (paths.some(isPackedPath) || isPackedPath(get().panels[side].path) || paths.some(isRemotePath) || isRemotePath(get().panels[side].path)) {
      toast("warning", "Copy the picture to this computer before converting it.");
      return;
    }
    if (!paths.some(isStillImage)) {
      toast("warning", "Choose a PNG, JPG, WebP, BMP, or GIF.");
      return;
    }
    set({ contextMenu: null, modal: { type: "convert", paths, side } });
  },

  askProperties: (paths) => {
    const side = actionSide(get());
    const picked = paths ?? chosen(get(), side);
    const target = picked.length ? picked : [get().panels[side].path].filter(Boolean);
    if (!target.length) {
      toast("warning", "Nothing selected.");
      return;
    }
    set({ contextMenu: null, modal: { type: "properties", paths: target } });
  },

  extractSelection: async (paths) => {
    const state = get();
    const side = actionSide(state);
    const picked = paths ?? chosen(state, side);
    const source = picked.length ? picked : isPackedPath(state.panels[side].path) ? [state.panels[side].path] : [];
    if (!source.length) {
      toast("warning", "Nothing selected.");
      return;
    }
    if (source.some((path) => !canExtract(path))) {
      toast("warning", "Extract works on a zip or gzip archive, or on files inside one.");
      return;
    }
    if (state.transfer) {
      toast("warning", "Wait for the current copy to finish.");
      return;
    }
    const archives = [...new Set(source.flatMap((path) => {
      const archive = archiveFile(path);
      return archive ? [archive] : [];
    }))];
    const entries = source.filter((path) => isPackedPath(path) && !archiveFile(path));
    const otherPanel = state.panels[other(side)];
    let dest = otherPanel.path;
    if (isPackedPath(dest) || otherPanel.view === "preview") {
      const here = state.panels[side].path;
      dest = isPackedPath(here) ? diskFolder(here) : here;
    }
    if (!dest || isPackedPath(dest) || isRemotePath(dest) || source.some(isRemotePath)) {
      toast("warning", "Extract onto a folder on this computer.");
      return;
    }
    if (archives.length && entries.length) {
      toast("warning", "Extract the archive, or the files inside it, one at a time.");
      return;
    }
    if (archives.length) {
      set({ contextMenu: null, transfer: { done: 0, total: 0, current: "Extracting" } });
      try {
        await invoke<string[]>("extract_archives", { archives, destDir: dest });
        set({ transfer: null });
        toast("success", "Extracted.");
        await get().refreshBoth();
      } catch (error) {
        set({ transfer: null });
        toast("error", message(error));
        await get().refreshBoth();
      }
      return;
    }
    set({ contextMenu: null });
    await get().beginTransfer("copy", entries, dest, false, "Extracted.");
  },

  confirmDelete: async () => {
    const modal = get().modal;
    if (modal?.type !== "delete") return;
    try {
      await invoke("delete_paths", { paths: modal.paths });
      set({ modal: null });
      toast("success", modal.paths.length === 1 ? "Deleted 1 item." : `Deleted ${modal.paths.length} items.`);
      await get().refreshBoth();
    } catch (error) {
      toast("error", message(error));
    }
  },

  confirmMkdir: async (name) => {
    const side = get().active;
    try {
      const path = await invoke<string>("make_dir", { parent: get().panels[side].path, name });
      set({ modal: null });
      toast("success", "Folder created.");
      await get().refresh(side);
      const index = fileRows(get().panels[side], get().showHidden).findIndex((row) => row.path === path);
      if (index >= 0) set((state) => ({ panels: patch(state.panels, side, { cursor: index, anchor: index }) }));
    } catch (error) {
      toast("error", message(error));
    }
  },

  confirmMkfile: async (name) => {
    const side = get().active;
    try {
      const path = await invoke<string>("make_file", { parent: get().panels[side].path, name });
      set({ modal: null });
      toast("success", "File created.");
      await get().refresh(side);
      const index = fileRows(get().panels[side], get().showHidden).findIndex((row) => row.path === path);
      if (index >= 0) set((state) => ({ panels: patch(state.panels, side, { cursor: index, anchor: index }) }));
    } catch (error) {
      toast("error", message(error));
    }
  },

  confirmRename: async (name) => {
    const modal = get().modal;
    if (modal?.type !== "rename") return;
    try {
      const path = await invoke<string>("rename_path", { path: modal.path, name });
      set({ modal: null });
      toast("success", "Renamed.");
      await get().refreshBoth();
      for (const side of ["left", "right"] as const) {
        const index = fileRows(get().panels[side], get().showHidden).findIndex((row) => row.path === path);
        if (index >= 0) set((state) => ({ panels: patch(state.panels, side, { cursor: index, anchor: index }) }));
      }
    } catch (error) {
      toast("error", message(error));
    }
  },

  confirmRenameMany: async (pairs) => {
    const modal = get().modal;
    if (modal?.type !== "renameMany" || !pairs.length) return;
    try {
      const count = await invoke<number>("rename_many", { items: pairs });
      set({ modal: null });
      toast("success", count ? `Renamed ${count} ${count === 1 ? "item" : "items"}.` : "Those names are already in place.");
      await get().refreshBoth();
    } catch (error) {
      toast("error", message(error));
    }
  },

  confirmZip: async (name) => {
    const modal = get().modal;
    if (modal?.type !== "zip") return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const file = trimmed.toLowerCase().endsWith(".zip") ? trimmed : `${trimmed}.zip`;
    const dest = joinPath(get().panels[modal.side].path, file);
    try {
      await invoke("zip_paths", { sources: modal.paths, dest });
      set({ modal: null });
      toast("success", "Zip created.");
      await get().refresh(modal.side);
      const index = fileRows(get().panels[modal.side], get().showHidden).findIndex((row) => row.name.toLowerCase() === file.toLowerCase());
      if (index >= 0) set((state) => ({ panels: patch(state.panels, modal.side, { cursor: index, anchor: index }) }));
    } catch (error) {
      toast("error", message(error));
    }
  },

  confirmConvert: async (format, quality, background, replace) => {
    const modal = get().modal;
    if (modal?.type !== "convert") return;
    if (get().transfer) {
      toast("warning", "Wait for the current copy to finish.");
      return;
    }
    const { paths, side } = modal;
    set({ modal: null, transfer: { done: 0, total: paths.length, current: "pictures", label: "Converting" } });
    try {
      const result = await invoke<ConvertReport>("convert_images", { paths, format, quality, background, replace });
      set({ transfer: null });
      if (result.written) toast("success", result.written === 1 ? "Converted 1 picture." : `Converted ${result.written} pictures.`);
      if (result.skipped) toast("warning", result.reason ? `Skipped ${result.skipped}. ${result.reason}` : `Skipped ${result.skipped}.`);
      if (!result.written && !result.skipped) toast("warning", "Nothing to convert.");
      await get().refresh(side);
    } catch (error) {
      set({ transfer: null });
      toast("error", message(error));
    }
  },

  saveNameTemplate: (template) => {
    const label = template.label.trim();
    if (!label) return;
    set((state) => ({
      nameTemplates: [...state.nameTemplates.filter((item) => item.label !== label), { ...template, label }],
    }));
    toast("success", "Template saved.");
  },

  deleteNameTemplate: (label) => {
    set((state) => ({ nameTemplates: state.nameTemplates.filter((item) => item.label !== label) }));
  },

  confirmOverwrite: async () => {
    const modal = get().modal;
    if (modal?.type !== "overwrite") return;
    const { mode, sources, dest, note } = modal.transfer;
    set({ modal: null });
    await get().beginTransfer(mode, sources, dest, true, note);
  },

  closeModal: () => set({ modal: null, paletteOpen: false, contextMenu: null }),

  focusForMenu: (side, index, path) => set((state) => {
    const panel = state.panels[side];
    const keep = panel.marked.includes(path);
    return { active: side, panels: patch(state.panels, side, { cursor: index, anchor: index, marked: keep ? panel.marked : [] }) };
  }),

  openContext: (menu) => set({ contextMenu: menu, active: menu.side }),

  closeContext: () => set({ contextMenu: null }),

  openCurrent: async () => {
    const state = get();
    const side = actionSide(state);
    const panel = state.panels[side];
    if (panel.view === "tree") {
      await get().openEntry();
      return;
    }
    const row = fileRows(panel, state.showHidden)[panel.cursor];
    if (!row || row.up) return;
    const browse = !row.isDir ? archiveBrowse(row.path, row.extension) : null;
    if (row.isDir) await get().navigate(side, row.path);
    else if (browse) await get().navigate(side, browse);
    else {
      try {
        await openExternal(row.path);
      } catch (error) {
        toast("error", message(error));
      }
    }
  },

  openInTextpad: async () => {
    const paths = chosen(get(), actionSide(get()));
    if (paths.length !== 1) {
      toast("warning", "Select one file.");
      return;
    }
    try {
      await invoke("open_in_textpad", { path: paths[0] });
    } catch (error) {
      toast("error", message(error));
    }
  },

  previewOther: () => {
    const side = other(get().active);
    const panel = get().panels[side];
    if (panel.view === "preview") {
      const back = panel.savedView !== "preview" ? panel.savedView : panel.listView;
      get().setView(side, back);
      return;
    }
    get().setView(side, "preview");
  },

  toggleHidden: () => set((state) => ({ showHidden: !state.showHidden })),
  toggleIconColors: () => set((state) => ({ iconColors: !state.iconColors })),
  askColors: () => set({ paletteOpen: false, contextMenu: null, modal: { type: "colors" } }),
  setIconTint: (id, color) => set((state) => {
    const key = id.toLowerCase();
    const iconTints = { ...state.iconTints };
    if (!color) delete iconTints[key];
    else iconTints[key] = color.toLowerCase();
    return { iconTints };
  }),
  resetIconTints: () => set({ iconTints: {} }),
  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen })),
  setSplit: (split) => set({ split: clamp(split, 0.18, 0.82) }),
  setOutputHeight: (outputHeight) => set({ outputHeight: clamp(outputHeight, 72, 800) }),
  setTerminalHeight: (terminalHeight) => set({ terminalHeight: clamp(terminalHeight, 120, 800) }),
  setCommand: (command) => set({ command, commandCursor: -1 }),

  historyStep: (dir) => {
    const history = get().commandHistory;
    if (!history.length) return;
    const cursor = get().commandCursor;
    if (dir === 1 && cursor === -1) return;
    if (cursor === -1) {
      set({ commandDraft: get().command, commandCursor: history.length - 1, command: history[history.length - 1] });
      return;
    }
    const next = cursor + dir;
    if (next >= history.length) {
      set({ commandCursor: -1, command: get().commandDraft });
      return;
    }
    if (next < 0) return;
    set({ commandCursor: next, command: history[next] });
  },

  runCommand: async () => {
    const command = get().command.trim();
    if (!command || get().running) return;
    const here = get().panels[get().active].path;
    if (isRemotePath(here)) {
      toast("warning", "Commands run on this computer. Open a local folder.");
      return;
    }
    const cwd = diskFolder(here);
    if (!cwd) {
      toast("warning", "Open a folder first.");
      return;
    }
    const id = crypto.randomUUID();
    const commandHistory = [...get().commandHistory.filter((item) => item !== command), command].slice(-50);
    set({ command: "", commandHistory, commandCursor: -1, commandDraft: "", output: `> ${command}\n`, outputOpen: true, running: true, runId: id });
    try {
      await invoke("run_command", { id, cwd, command });
    } catch (error) {
      set({ running: false });
      toast("error", message(error));
    }
  },

  cancelCommand: async () => {
    const id = get().runId;
    if (!id) return;
    try {
      await invoke("cancel_command", { id });
    } catch (error) {
      toast("error", message(error));
    }
  },

  setOutputOpen: (outputOpen) => set({ outputOpen }),

  onCmd: (chunk) => {
    if (chunk.id !== get().runId) return;
    if (chunk.text) set({ output: (get().output + chunk.text).slice(-200_000), outputOpen: true });
    if (chunk.done) {
      set({ running: false });
      if (chunk.code) toast("error", `Command exited with code ${chunk.code}.`);
    }
  },

  onTransfer: (transfer) => set({ transfer }),
  setPalette: (paletteOpen) => set({ paletteOpen }),

  askSftp: (draft) => set({ contextMenu: null, paletteOpen: false, modal: { type: "sftp", draft } }),

  askServers: () => set({ contextMenu: null, paletteOpen: false, modal: { type: "servers" } }),

  submitSftp: async (draft, acceptFingerprint, replacePin) => {
    try {
      const result = await invoke<{ status: string; path: string | null; fingerprint: string; pinned: string | null; username: string; host: string }>("sftp_open", {
        request: {
          profileId: draft.profileId ?? null,
          label: draft.label,
          host: draft.host,
          port: Number(draft.port) || 22,
          username: draft.username,
          password: draft.password || null,
          privateKey: draft.privateKey || null,
          passphrase: draft.passphrase || null,
          remotePath: draft.remotePath || "/",
          acceptFingerprint: acceptFingerprint ?? null,
          pendingId: draft.pendingId ?? null,
          replacePin: replacePin === true,
        },
      });
      if (result.status === "ready" && result.path) {
        const side = actionSide(get());
        set({ modal: null });
        await get().navigate(side, result.path);
        await get().loadPlaces();
        toast("success", `Connected to ${result.username}@${result.host}.`);
        return;
      }
      set({ modal: { type: "hostKey", draft, fingerprint: result.fingerprint, pinned: result.pinned, status: result.status } });
    } catch (error) {
      toast("error", message(error));
    }
  },

  disconnectSftp: async (side) => {
    const target = side ?? actionSide(get());
    const remote = remoteParts(get().panels[target].path);
    if (!remote) {
      toast("warning", "This panel is already on this computer.");
      return;
    }
    try {
      await invoke("sftp_disconnect", { id: remote.id });
      const local = get().panels[target].localPath;
      const next = local || await invoke<string>("home_dir");
      await get().navigate(target, next);
      toast("success", "Disconnected.");
    } catch (error) {
      toast("error", message(error));
    }
  },

  refreshMcp: async () => {
    try {
      const servers = await invoke<{ id: string; name: string; transport: string; command: string; args: string[]; url: string }[]>("mcp_servers");
      const lines = servers.map((server) => server.transport === "http" ? `${server.name}: ${server.url}` : `${server.name}: ${server.command} ${server.args.join(" ")}`.trim());
      if (lines.length) set({ output: `About to run:\n${lines.join("\n")}`, outputOpen: true });
      const tools: McpTool[] = [];
      for (const server of servers) {
        const listed = await invoke<McpTool[]>("mcp_tools", { serverId: server.id });
        tools.push(...listed);
      }
      set({ mcpTools: tools });
      toast("success", tools.length ? `Found ${tools.length} tools.` : "No tools on the saved servers.");
    } catch (error) {
      toast("error", message(error));
    }
  },

  runMcp: async (tool, values) => {
    const arguments_: Record<string, unknown> = {};
    const properties = tool.schema.properties ?? {};
    for (const [key, spec] of Object.entries(properties)) {
      const raw = values[key] ?? "";
      if (!raw.trim()) continue;
      const kind = Array.isArray(spec.type) ? spec.type[0] : spec.type;
      if (kind === "number" || kind === "integer") arguments_[key] = Number(raw);
      else if (kind === "boolean") arguments_[key] = raw === "true";
      else if (kind === "object" || kind === "array") {
        try { arguments_[key] = JSON.parse(raw); } catch { throw new Error(`${key} needs JSON.`); }
      } else arguments_[key] = raw;
    }
    try {
      const outcome = await invoke<{ text: string; isError: boolean; offer: ConnectOffer | null }>("mcp_call", {
        serverId: tool.serverId,
        name: tool.name,
        arguments: arguments_,
      });
      set({
        output: outcome.text,
        outputOpen: true,
        modal: outcome.offer ? { type: "sftpOffer", offer: outcome.offer } : null,
        paletteOpen: false,
      });
      if (outcome.isError) toast("error", `${tool.name} reported an error.`);
      else if (!outcome.offer) toast("success", `${tool.name} finished.`);
    } catch (error) {
      toast("error", message(error));
    }
  },

  applyBridge: async (name, args) => {
    const side: Side = args.side === "right" ? "right" : "left";
    if (name === "get_state") {
      const profiles = await invoke<SftpProfile[]>("sftp_profiles");
      const pane = (which: Side) => ({ path: get().panels[which].path, selected: chosen(get(), which) });
      return { active: get().active, left: pane("left"), right: pane("right"), profiles };
    }
    if (name === "navigate") {
      await get().navigate(side, String(args.path ?? ""));
      return { path: get().panels[side].path };
    }
    if (name === "list_dir") {
      await get().refresh(side);
      const panel = get().panels[side];
      return { path: panel.path, parent: panel.parent, entries: panel.entries };
    }
    if (name === "disconnect") {
      await get().disconnectSftp(side);
      return { path: get().panels[side].path };
    }
    if (name === "copy_to_other" || name === "move_to_other") {
      set({ active: side });
      if (name === "copy_to_other") await get().copyToOther();
      else await get().moveToOther();
      return { ok: true };
    }
    if (name === "mkdir") {
      const created = await invoke<string>("make_dir", { parent: get().panels[side].path, name: String(args.name ?? "") });
      await get().refresh(side);
      return { path: created };
    }
    if (name === "rename") {
      const renamed = await invoke<string>("rename_path", { path: String(args.path ?? ""), name: String(args.name ?? "") });
      await get().refreshBoth();
      return { path: renamed };
    }
    if (name === "delete") {
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      await invoke("delete_paths", { paths });
      await get().refreshBoth();
      return { ok: true };
    }
    throw new Error("FilePad doesn't know that tool.");
  },
}));

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
