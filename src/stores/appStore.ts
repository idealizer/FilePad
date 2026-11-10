import { create } from "zustand";
import { baseName, diskFolder, isZipPath, joinPath } from "../lib/format";
import type { NameSource, NameTemplate } from "../lib/names";
import { fileRows, treeRows } from "../lib/rows";
import { inTauri, invoke, message, openExternal } from "../lib/platform";
import { readSession, writeSession } from "../lib/session";
import type { Clipboard, CmdChunk, ContextMenuState, DirListing, ModalState, Panel, PendingTransfer, Place, Side, SortKey, ThemeMode, TransferProgress, TransferResult, ViewMode } from "../types";
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
  };
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
  boot: () => Promise<void>;
  persist: () => Promise<void>;
  loadPlaces: () => Promise<void>;
  setTheme: (theme: ThemeMode) => void;
  setActive: (side: Side) => void;
  cyclePanel: (dir: 1 | -1) => void;
  navigate: (side: Side, path: string) => Promise<void>;
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
  beginTransfer: (mode: "copy" | "cut", sources: string[], dest: string, overwrite?: boolean) => Promise<void>;
  askDelete: () => void;
  askMkdir: () => void;
  askRename: () => void;
  askPattern: () => void;
  askZip: () => void;
  confirmDelete: () => Promise<void>;
  confirmMkdir: (name: string) => Promise<void>;
  confirmRename: (name: string) => Promise<void>;
  confirmRenameMany: (pairs: { path: string; name: string }[]) => Promise<void>;
  confirmZip: (name: string) => Promise<void>;
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
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  theme: "system",
  active: "left",
  panels: { left: emptyPanel(), right: emptyPanel() },
  showHidden: false,
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
    const listView = (view: ViewMode): Panel["listView"] => (view === "files" ? "files" : "details");
    set({
      theme: session.theme,
      showHidden: session.showHidden,
      recent: session.recent,
      commandHistory: session.commandHistory,
      split: clamp(session.split, 0.18, 0.82),
      outputHeight: clamp(session.outputHeight, 72, 800),
      terminalHeight: clamp(session.terminalHeight, 120, 800),
      nameTemplates: storedTemplates(session.nameTemplates),
      places,
      textpad,
      panels: {
        left: { ...emptyPanel(), view: session.leftView, listView: listView(session.leftView) },
        right: { ...emptyPanel(), view: session.rightView, listView: listView(session.rightView) },
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
      set({ places: await invoke<Place[]>("list_places") });
    } catch (error) {
      toast("error", message(error));
    }
  },

  setTheme: (theme) => set({ theme }),
  setActive: (side) => set({ active: side }),
  cyclePanel: (dir) => set({ active: dir === 1 ? "right" : "left" }),

  navigate: async (side, raw) => {
    if (!inTauri()) {
      set((state) => ({ panels: patch(state.panels, side, { loading: false, error: "Open the FilePad window to browse this computer." }) }));
      return;
    }
    set((state) => ({ panels: patch(state.panels, side, { loading: true, error: null }) }));
    try {
      const listing = await invoke<DirListing>("list_dir", { path: raw });
      const recent = [listing.path, ...get().recent.filter((item) => item !== listing.path)].slice(0, 12);
      set((state) => ({
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
        }),
      }));
      if (get().panels[side].view === "tree") await get().ensureTree(side, listing.path);
    } catch (error) {
      set((state) => ({ panels: patch(state.panels, side, { loading: false, error: message(error) }) }));
      toast("error", message(error));
    }
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
      const listView = view === "files" || view === "details" ? view : panel.listView;
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
    if (row.extension === "zip" && !isZipPath(row.path)) {
      await get().navigate(side, `zip:${row.path}|`);
      return;
    }
    if (row.extension === "zip") {
      toast("warning", "Copy this zip out to browse inside it.");
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
    if (paths.some(isZipPath)) {
      toast("warning", "Copy files out of a zip. The archive stays unchanged.");
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

  beginTransfer: async (mode, sources, dest, overwrite = false) => {
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
        const transfer: PendingTransfer = { mode, sources, dest };
        set({ transfer: null, modal: { type: "overwrite", transfer, conflicts: result.conflicts } });
        return;
      }
      if (mode === "cut") set({ clipboard: null });
      set({ transfer: null, modal: null });
      toast("success", mode === "copy" ? "Copied." : "Moved.");
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
    if (paths.some(isZipPath)) {
      toast("warning", "Can't delete files inside a zip.");
      return;
    }
    set({ modal: { type: "delete", paths } });
  },

  askMkdir: () => {
    if (isZipPath(get().panels[get().active].path)) {
      toast("warning", "Can't create a folder inside a zip.");
      return;
    }
    set({ modal: { type: "mkdir" } });
  },

  askRename: () => {
    const found = selectionSources(get());
    if (!found.items.length) {
      toast("warning", "Nothing selected.");
      return;
    }
    if (found.items.some((item) => isZipPath(item.path))) {
      toast("warning", "Can't rename a file inside a zip. Copy it out first.");
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
    if (found.items.some((item) => isZipPath(item.path))) {
      toast("warning", "Can't rename a file inside a zip. Copy it out first.");
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
    if (paths.some(isZipPath) || isZipPath(get().panels[side].path)) {
      toast("warning", "Copy files out of a zip before packing them.");
      return;
    }
    const stem = paths.length === 1 ? baseName(paths[0]).replace(/\.[^.]+$/, "") : "archive";
    set({ contextMenu: null, modal: { type: "zip", paths, side, name: `${stem || "archive"}.zip` } });
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
    const { mode, sources, dest } = modal.transfer;
    set({ modal: null });
    await get().beginTransfer(mode, sources, dest, true);
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
    if (row.isDir) await get().navigate(side, row.path);
    else if (row.extension === "zip" && !isZipPath(row.path)) await get().navigate(side, `zip:${row.path}|`);
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
    const cwd = diskFolder(get().panels[get().active].path);
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
}));

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
