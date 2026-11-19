import { create } from "zustand";
import { archiveFile, baseName, canExtract, diskFolder, isPackedPath, isRemotePath, isStillImage, joinPath, pathKey, remoteParts } from "../lib/format";
import { ICON_COLUMNS_DEFAULT, iconColumnsOf } from "../lib/iconSize";
import type { NameSource, NameTemplate } from "../lib/names";
import { fileRows, hasLocalMatch, treeRows } from "../lib/rows";
import { alignScroll, holdScrollSync, setScrollLock } from "../lib/scrollLock";
import { inTauri, invoke, message, openExternal } from "../lib/platform";
import { readSession, writeSession, type SessionData, type SessionTab } from "../lib/session";
import type { ChromeMode, Clipboard, CmdChunk, ConnectOffer, ContextMenuState, ConvertReport, DirListing, ListBatch, McpTool, ModalState, NavPin, Panel, PathStyle, PendingTransfer, Place, SearchListing, SftpDraft, SftpProfile, Side, SortKey, ThemeMode, TransferProgress, TransferResult, ViewMode, WorkTab } from "../types";
import { jobCancel, jobFinish, jobStart, jobUpdate, toast } from "./toastStore";

const TAB_LIMIT = 12;

let deleting = false;
let transferJob: string | null = null;
let externalFolder = "";
let listSeq = 0;
let tabGen = 0;
const listActive: Record<Side, number> = { left: 0, right: 0 };
const listJobs = new Map<number, ListJob>();

type ListJob = {
  side: Side;
  mode: "open" | "refresh";
  record: boolean;
  opened: boolean;
  settled: boolean;
  pinned: string | null;
};

export function takeListId(): number {
  listSeq += 1;
  return listSeq;
}

function beginList(side: Side, mode: ListJob["mode"], record: boolean): number {
  const prev = listActive[side];
  if (prev) void invoke("cancel_list", { id: prev });
  const id = takeListId();
  listActive[side] = id;
  listJobs.set(id, { side, mode, record, opened: false, settled: false, pinned: null });
  return id;
}

function listStopped(side: Side, id: number, error: unknown): boolean {
  return listActive[side] !== id || message(error) === "cancelled";
}

function applyOpen(side: Side, listing: DirListing, record: boolean, loading: boolean) {
  useApp.setState((state) => {
    const panel = state.panels[side];
    let history = panel.history;
    let historyAt = panel.historyAt;
    let viewHistory = panel.viewHistory ?? [];
    if (record && history[historyAt]?.toLowerCase() !== listing.path.toLowerCase()) {
      const prior = viewHistory.length === history.length ? viewHistory : history.map(() => panel.view);
      history = [...history.slice(0, historyAt + 1), listing.path].slice(-48);
      viewHistory = [...prior.slice(0, historyAt + 1), panel.view].slice(-48);
      historyAt = history.length - 1;
    }
    const recent = [listing.path, ...state.recent.filter((item) => item !== listing.path)].slice(0, 12);
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
        hits: [],
        searching: false,
        searched: "",
        searchLimited: false,
        searchCap: 0,
        loading,
        error: null,
        treeKids: panel.view === "tree" ? { [listing.path]: listing.entries } : {},
        treeExpanded: [],
        history,
        historyAt,
        viewHistory,
        localPath: isRemotePath(listing.path) ? panel.localPath : listing.path,
      }),
    };
  });
}

function appendListed(side: Side, batch: ListBatch, pinned: string | null) {
  useApp.setState((state) => {
    const panel = state.panels[side];
    const entries = panel.entries.concat(batch.entries);
    let cursor = panel.cursor;
    let anchor = panel.anchor;
    if (pinned) {
      const rows = fileRows({ ...panel, entries, path: batch.path, parent: batch.parent }, state.showHidden);
      const index = rows.findIndex((row) => row.path === pinned);
      if (index >= 0) {
        cursor = index;
        anchor = index;
      }
    }
    const treeKids = panel.view === "tree" ? { ...panel.treeKids, [batch.path]: entries } : panel.treeKids;
    return {
      panels: patch(state.panels, side, {
        path: batch.path,
        parent: batch.parent,
        entries,
        loading: !batch.done,
        error: null,
        cursor,
        anchor,
        treeKids,
      }),
    };
  });
}

function settleOpen(side: Side, listing: DirListing, pinned: string | null) {
  useApp.setState((state) => {
    const panel = state.panels[side];
    let cursor = panel.cursor;
    let anchor = panel.anchor;
    if (pinned) {
      const rows = fileRows({ ...panel, entries: listing.entries, path: listing.path, parent: listing.parent }, state.showHidden);
      const index = rows.findIndex((row) => row.path === pinned);
      if (index >= 0) {
        cursor = index;
        anchor = index;
      }
    }
    const treeKids = panel.view === "tree" ? { ...panel.treeKids, [listing.path]: listing.entries } : panel.treeKids;
    return {
      panels: patch(state.panels, side, {
        path: listing.path,
        parent: listing.parent,
        entries: listing.entries,
        loading: false,
        error: null,
        cursor,
        anchor,
        treeKids,
      }),
    };
  });
}

export function noteExternalFolder(path: string) {
  const clean = path.trim();
  if (!clean) return;
  if (useApp.getState().ready) void useApp.getState().openLaunchedFolder(clean);
  else externalFolder = clean;
}

function startTransferJob(text: string) {
  if (transferJob) jobCancel(transferJob);
  transferJob = jobStart(text);
}

function finishTransferJob(kind: "success" | "error" | "warning", text: string) {
  if (!transferJob) {
    toast(kind, text);
    return;
  }
  jobFinish(transferJob, kind, text);
  transferJob = null;
}

function cancelTransferJob() {
  if (!transferJob) return;
  jobCancel(transferJob);
  transferJob = null;
}

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
    hits: [],
    searching: false,
    searched: "",
    searchLimited: false,
    searchCap: 0,
    sortKey: "name",
    sortAsc: true,
    loading: false,
    error: null,
    treeKids: {},
    treeExpanded: [],
    savedView: "details",
    history: [],
    historyAt: 0,
    viewHistory: [],
    localPath: isRemotePath(path) ? "" : path,
    iconSize: ICON_COLUMNS_DEFAULT,
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

function matchedFolder(panel: Panel, name: string, up: boolean): string | null {
  if (panel.view === "preview" || panel.view === "tree") return null;
  if (up) return panel.parent;
  const key = name.toLowerCase();
  return panel.entries.find((entry) => entry.isDir && entry.name.toLowerCase() === key)?.path ?? null;
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

const searchTimer: Record<Side, number> = { left: 0, right: 0 };
const searchToken: Record<Side, number> = { left: 0, right: 0 };

function stopSearch(side: Side) {
  window.clearTimeout(searchTimer[side]);
  searchToken[side] += 1;
  if (useApp.getState().panels[side].searching) void invoke("cancel_search").catch(() => undefined);
}

function clearResume() {
  if (useApp.getState().modal?.type === "sftpResume") useApp.setState({ modal: null });
}

function haltPanels() {
  stopSearch("left");
  stopSearch("right");
  for (const side of ["left", "right"] as const) {
    const prev = listActive[side];
    if (!prev) continue;
    const job = listJobs.get(prev);
    if (job) job.settled = true;
    listJobs.delete(prev);
    listActive[side] = 0;
    void invoke("cancel_list", { id: prev }).catch(() => undefined);
  }
}

function scheduleSearch(side: Side) {
  window.clearTimeout(searchTimer[side]);
  searchTimer[side] = window.setTimeout(() => {
    const state = useApp.getState();
    const panel = state.panels[side];
    if (!panel.filter.trim() || hasLocalMatch(panel, state.showHidden)) return;
    void runSearch(side, false);
  }, 200);
}

async function runSearch(side: Side, asked: boolean) {
  window.clearTimeout(searchTimer[side]);
  const token = ++searchToken[side];
  const state = useApp.getState();
  const panel = state.panels[side];
  const query = panel.filter.trim();
  if (!query || !panel.path) return;
  if (isRemotePath(panel.path) || isPackedPath(panel.path)) {
    if (searchToken[side] !== token) return;
    useApp.setState((current) => ({ panels: patch(current.panels, side, { hits: [], searching: false, searched: query, searchLimited: false, searchCap: 0 }) }));
    if (asked) toast("warning", "Search looks through folders on this computer.");
    return;
  }
  useApp.setState((current) => ({ panels: patch(current.panels, side, { searching: true }) }));
  try {
    const found = await invoke<SearchListing>("search_dir", { path: panel.path, query, showHidden: state.showHidden });
    if (searchToken[side] !== token) return;
    const now = useApp.getState().panels[side];
    if (now.filter.trim().toLowerCase() !== query.toLowerCase() || pathKey(now.path) !== pathKey(panel.path)) return;
    useApp.setState((current) => ({
      panels: patch(current.panels, side, { hits: found.entries, searching: false, searched: query, searchLimited: found.limited, searchCap: found.cap }),
    }));
  } catch (error) {
    if (searchToken[side] !== token) return;
    useApp.setState((current) => ({ panels: patch(current.panels, side, { searching: false, searched: query, hits: [], searchLimited: false, searchCap: 0 }) }));
    toast("error", message(error));
  }
}

function selectionSources(state: { active: Side; showHidden: boolean; panels: { left: Panel; right: Panel } }): { items: NameSource[]; taken: string[] } {
  const side = actionSide(state);
  const panel = state.panels[side];
  if (panel.view === "tree") {
    const row = treeRows(panel, state.showHidden)[panel.cursor];
    if (!row) return { items: [], taken: [] };
    return { items: [{ path: row.path, name: row.name, modified: row.modified, isDir: row.isDir }], taken: [] };
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

function storedPins(value: unknown, places: Place[]): NavPin[] {
  if (!Array.isArray(value)) {
    const desktop = places.find((place) => place.role === "desktop");
    return desktop ? [{ name: desktop.name, path: desktop.path }] : [];
  }
  const seen = new Set<string>();
  const pins: NavPin[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as { name?: unknown; path?: unknown };
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!path || !name) continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    pins.push({ name, path });
  }
  return pins;
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

function storedView(value: unknown): ViewMode {
  return value === "files" || value === "details" || value === "icons" || value === "tree" || value === "preview" ? value : "details";
}

function panelShell(path: string, view: ViewMode, iconSize: unknown, history: unknown, historyAt: unknown): Panel {
  const listView: Panel["listView"] = view === "files" || view === "icons" ? view : "details";
  const hist = storedHistory(history);
  return {
    ...emptyPanel(path),
    view,
    listView,
    savedView: view === "preview" ? listView : view,
    iconSize: iconColumnsOf(iconSize),
    history: hist,
    historyAt: storedAt(hist, historyAt),
    viewHistory: hist.map(() => view),
  };
}

function tabFromRow(row: Partial<SessionTab>, id: string): WorkTab {
  const leftView = storedView(row.leftView);
  const rightView = storedView(row.rightView);
  return {
    id,
    name: typeof row.name === "string" ? row.name.trim().slice(0, 80) : "",
    opened: false,
    active: row.active === "right" ? "right" : "left",
    split: clamp(typeof row.split === "number" ? row.split : 0.5, 0.18, 0.82),
    leftNav: row.leftNav === true,
    rightNav: row.rightNav === true,
    panels: {
      left: panelShell(typeof row.leftPath === "string" ? row.leftPath : "", leftView, row.leftIconSize, row.leftHistory, row.leftHistoryAt),
      right: panelShell(typeof row.rightPath === "string" ? row.rightPath : "", rightView, row.rightIconSize, row.rightHistory, row.rightHistoryAt),
    },
  };
}

function legacyTab(session: SessionData): WorkTab {
  return tabFromRow({
    id: "main",
    name: "",
    active: "left",
    split: session.split,
    leftNav: session.leftNav,
    rightNav: session.rightNav,
    leftPath: session.leftPath,
    rightPath: session.rightPath,
    leftView: session.leftView,
    rightView: session.rightView,
    leftIconSize: session.leftIconSize,
    rightIconSize: session.rightIconSize,
    leftHistory: session.leftHistory,
    rightHistory: session.rightHistory,
    leftHistoryAt: session.leftHistoryAt,
    rightHistoryAt: session.rightHistoryAt,
  }, "main");
}

function storedWorkTabs(session: SessionData): WorkTab[] {
  if (!Array.isArray(session.tabs)) return [legacyTab(session)];
  const tabs: WorkTab[] = [];
  for (const item of session.tabs) {
    if (tabs.length >= TAB_LIMIT) break;
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<SessionTab>;
    const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : crypto.randomUUID();
    if (tabs.some((tab) => tab.id === id)) continue;
    tabs.push(tabFromRow(row, id));
  }
  return tabs.length ? tabs : [legacyTab(session)];
}

function resting(panel: Panel): Panel {
  return panel.loading || panel.searching ? { ...panel, loading: false, searching: false } : panel;
}

function captureTab(state: { active: Side; split: number; leftNav: boolean; rightNav: boolean; panels: { left: Panel; right: Panel } }, tab: WorkTab): WorkTab {
  const layout = {
    active: state.active,
    split: state.split,
    leftNav: state.leftNav,
    rightNav: state.rightNav,
  };
  if (!tab.opened) return { ...tab, ...layout };
  const busy = state.panels.left.loading || state.panels.right.loading;
  return {
    ...tab,
    ...layout,
    opened: !busy,
    panels: { left: resting(state.panels.left), right: resting(state.panels.right) },
  };
}

function applyTab(tab: WorkTab) {
  return {
    active: tab.active,
    split: clamp(tab.split, 0.18, 0.82),
    leftNav: tab.leftNav,
    rightNav: tab.rightNav,
    panels: tab.panels,
  };
}

function clonedPanel(panel: Panel): Panel {
  return {
    ...emptyPanel(panel.path),
    view: panel.view,
    listView: panel.listView,
    savedView: panel.savedView,
    sortKey: panel.sortKey,
    sortAsc: panel.sortAsc,
    iconSize: panel.iconSize,
    localPath: panel.localPath,
  };
}

function folderTabName(path: string): string {
  const remote = remoteParts(path);
  const name = baseName(remote?.remote || path).trim();
  if (!name || name === "/" || name === "\\") return "Files";
  return name;
}

function nextTabName(tabs: { name: string }[]): string {
  const taken = new Set(tabs.map((tab) => tab.name));
  let count = tabs.length + 1;
  let name = `Tab ${count}`;
  while (taken.has(name)) {
    count += 1;
    name = `Tab ${count}`;
  }
  return name;
}

function toSessionTab(tab: WorkTab): SessionTab {
  return {
    id: tab.id,
    name: tab.name,
    active: tab.active,
    split: tab.split,
    leftNav: tab.leftNav,
    rightNav: tab.rightNav,
    leftPath: tab.panels.left.path,
    rightPath: tab.panels.right.path,
    leftView: tab.panels.left.view,
    rightView: tab.panels.right.view,
    leftIconSize: tab.panels.left.iconSize,
    rightIconSize: tab.panels.right.iconSize,
    leftHistory: tab.panels.left.history,
    rightHistory: tab.panels.right.history,
    leftHistoryAt: tab.panels.left.historyAt,
    rightHistoryAt: tab.panels.right.historyAt,
  };
}

async function openRemembered(side: Side, saved: string, home: string, profiles: SftpProfile[], resume: { side: Side; path: string; label: string }[], still: () => boolean) {
  if (!still()) return;
  if (!isRemotePath(saved)) {
    await useApp.getState().navigate(side, saved || home);
    return;
  }
  const desktop = useApp.getState().places.find((place) => place.role === "desktop")?.path || home;
  const remote = remoteParts(saved);
  const profile = profiles.find((item) => item.id === remote?.id);
  const where = remote?.remote || "/";
  resume.push({ side, path: saved, label: profile?.label ? `${profile.label} (${where})` : where });
  if (!still()) return;
  await useApp.getState().navigate(side, desktop, false);
  if (!still()) return;
  const shown = useApp.getState().panels[side].path || desktop;
  useApp.setState((state) => ({ panels: patch(state.panels, side, { history: [shown], historyAt: 0, viewHistory: [state.panels[side].view] }) }));
}

async function finishCold(id: string, gen: number) {
  const still = () => gen === tabGen && useApp.getState().activeTab === id;
  const tab = useApp.getState().tabs.find((item) => item.id === id);
  if (!tab || !still()) return;
  const leftPath = tab.panels.left.path;
  const rightPath = tab.panels.right.path;
  const resume: { side: Side; path: string; label: string }[] = [];
  let profiles: SftpProfile[] = [];
  if (inTauri() && (isRemotePath(leftPath) || isRemotePath(rightPath))) {
    try {
      profiles = await invoke<SftpProfile[]>("sftp_profiles");
    } catch {
      profiles = [];
    }
  }
  if (!still()) return;
  let home = "";
  if (inTauri()) {
    try {
      home = await invoke<string>("home_dir");
    } catch {
      home = "";
    }
  }
  await openRemembered("left", leftPath, home, profiles, resume, still);
  if (!still()) return;
  await openRemembered("right", rightPath, home, profiles, resume, still);
  if (!still()) return;
  useApp.setState((state) => {
    if (state.activeTab !== id) return {};
    return {
      tabs: state.tabs.map((item) => item.id === id ? { ...item, opened: true } : item),
      ...(resume.length && (!state.modal || state.modal.type === "sftpResume") ? { modal: { type: "sftpResume" as const, items: resume } } : {}),
    };
  });
}

interface AppState {
  ready: boolean;
  theme: ThemeMode;
  chrome: ChromeMode;
  pathStyle: PathStyle;
  active: Side;
  panels: { left: Panel; right: Panel };
  tabs: WorkTab[];
  activeTab: string;
  showHidden: boolean;
  iconColors: boolean;
  keyBar: boolean;
  scrollLock: boolean;
  iconTints: Record<string, string>;
  places: Place[];
  recent: string[];
  leftNav: boolean;
  rightNav: boolean;
  pins: NavPin[];
  clipboard: Clipboard | null;
  textpad: boolean;
  folderAppSupported: boolean;
  folderApp: boolean;
  command: string;
  commandHistory: string[];
  commandCursor: number;
  commandDraft: string;
  output: string;
  outputOpen: boolean;
  running: boolean;
  runId: string | null;
  terminalOpen: boolean;
  terminalExpanded: boolean;
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
  toggleNav: (side: Side) => void;
  pinPath: (path: string, name: string) => void;
  unpinPath: (path: string) => void;
  movePin: (from: number, to: number) => void;
  setTheme: (theme: ThemeMode) => void;
  setChrome: (chrome: ChromeMode) => void;
  setPathStyle: (pathStyle: PathStyle) => void;
  setActive: (side: Side) => void;
  cyclePanel: (dir: 1 | -1) => void;
  newTab: () => Promise<void>;
  switchTab: (id: string) => Promise<void>;
  cycleTab: (dir: 1 | -1) => void;
  renameTab: (id: string, name: string) => void;
  closeTab: (id: string) => void;
  navigate: (side: Side, path: string, record?: boolean) => Promise<void>;
  goHistory: (side: Side, dir: -1 | 1) => Promise<void>;
  refresh: (side: Side) => Promise<void>;
  refreshBoth: () => Promise<void>;
  setFilter: (side: Side, filter: string) => void;
  searchDeeper: (side: Side) => void;
  setView: (side: Side, view: ViewMode) => void;
  setSort: (side: Side, key: SortKey) => void;
  moveCursor: (delta: number, mark: boolean) => void;
  toggleMark: (side: Side, index: number, advance: boolean) => void;
  markRange: (side: Side, index: number) => void;
  clickEntry: (side: Side, index: number) => void;
  markAll: () => void;
  clearMarks: () => void;
  openEntry: () => Promise<void>;
  openFolder: (side: Side, path: string, name: string, up: boolean) => Promise<void>;
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
  setFolderApp: (enabled: boolean) => Promise<void>;
  openLaunchedFolder: (path: string, side?: Side) => Promise<void>;
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
  renamePath: (path: string, name: string) => Promise<void>;
  confirmRenameMany: (pairs: { path: string; name: string }[]) => Promise<void>;
  confirmZip: (name: string) => Promise<void>;
  confirmConvert: (format: string, quality: number, background: "white" | "black", replace: boolean) => Promise<void>;
  saveNameTemplate: (template: NameTemplate) => void;
  deleteNameTemplate: (label: string) => void;
  confirmOverwrite: () => Promise<void>;
  closeModal: () => void;
  confirmSftpResume: () => Promise<void>;
  focusForMenu: (side: Side, index: number, path: string) => void;
  openContext: (menu: ContextMenuState) => void;
  closeContext: () => void;
  openCurrent: () => Promise<void>;
  openInTextpad: () => Promise<void>;
  previewOther: () => void;
  toggleHidden: () => void;
  setIconSize: (side: Side, size: number) => void;
  toggleIconColors: () => void;
  askColors: () => void;
  setIconTint: (id: string, color: string | null) => void;
  resetIconTints: () => void;
  toggleTerminal: () => void;
  expandTerminal: () => void;
  restoreTerminal: () => void;
  toggleKeyBar: () => void;
  toggleScrollLock: () => void;
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
  onListBatch: (batch: ListBatch) => void;
  setPalette: (open: boolean) => void;
  clearRecent: () => void;
  forgetRecent: (path: string) => void;
  askSftp: (draft?: SftpDraft) => void;
  askConnections: () => void;
  editConnection: (id: string) => void;
  askForgetSftp: (id: string) => void;
  confirmForgetSftp: () => Promise<void>;
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
  chrome: "classic",
  pathStyle: "breadcrumb",
  active: "left",
  panels: { left: emptyPanel(), right: emptyPanel() },
  tabs: [{
    id: "main",
    name: "",
    opened: false,
    active: "left" as Side,
    split: 0.5,
    leftNav: false,
    rightNav: false,
    panels: { left: emptyPanel(), right: emptyPanel() },
  }],
  activeTab: "main",
  showHidden: false,
  iconColors: true,
  keyBar: true,
  scrollLock: false,
  iconTints: {},
  places: [],
  recent: [],
  leftNav: false,
  rightNav: false,
  pins: [],
  clipboard: null,
  textpad: false,
  folderAppSupported: false,
  folderApp: false,
  command: "",
  commandHistory: [],
  commandCursor: -1,
  commandDraft: "",
  output: "",
  outputOpen: false,
  running: false,
  runId: null,
  terminalOpen: false,
  terminalExpanded: false,
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
    let folderAppSupported = false;
    let folderApp = false;
    if (inTauri()) {
      try {
        home = await invoke<string>("home_dir");
        places = await invoke<Place[]>("list_places");
        textpad = await invoke<boolean>("textpad_available");
      } catch (error) {
        toast("error", message(error));
      }
      try {
        const status = await invoke<{ supported: boolean; enabled: boolean }>("folder_app_status");
        folderAppSupported = status.supported;
        folderApp = status.enabled;
      } catch {
        folderAppSupported = false;
      }
    }
    setScrollLock(session.scrollLock);
    const workTabs = storedWorkTabs(session);
    const activeId = workTabs.some((tab) => tab.id === session.activeTab) ? session.activeTab ?? workTabs[0].id : workTabs[0].id;
    const activeTab = workTabs.find((tab) => tab.id === activeId) ?? workTabs[0];
    const gen = ++tabGen;
    const still = () => gen === tabGen;
    set({
      theme: session.theme,
      chrome: session.chrome === "modern" ? "modern" : "classic",
      pathStyle: session.pathStyle === "text" ? "text" : "breadcrumb",
      showHidden: session.showHidden,
      iconColors: session.iconColors,
      keyBar: session.keyBar,
      scrollLock: session.scrollLock,
      iconTints: storedTints(session.iconTints),
      recent: session.recent,
      commandHistory: session.commandHistory,
      split: activeTab.split,
      outputHeight: clamp(session.outputHeight, 72, 800),
      terminalHeight: clamp(session.terminalHeight, 120, 800),
      nameTemplates: storedTemplates(session.nameTemplates),
      leftNav: activeTab.leftNav,
      rightNav: activeTab.rightNav,
      active: activeTab.active,
      pins: storedPins(session.pins, places),
      places,
      textpad,
      folderAppSupported,
      folderApp,
      tabs: workTabs,
      activeTab: activeId,
      panels: activeTab.panels,
    });
    let launch = "";
    if (inTauri()) {
      try {
        launch = (await invoke<string | null>("take_launch_folder")) ?? "";
      } catch {
        launch = "";
      }
    }
    if (externalFolder) {
      launch = externalFolder;
      externalFolder = "";
    }
    const leftPath = launch || activeTab.panels.left.path;
    const rightPath = activeTab.panels.right.path;
    const resume: { side: Side; path: string; label: string }[] = [];
    let profiles: SftpProfile[] = [];
    if (inTauri() && (isRemotePath(leftPath) || isRemotePath(rightPath))) {
      try {
        profiles = await invoke<SftpProfile[]>("sftp_profiles");
      } catch {
        profiles = [];
      }
    }
    await openRemembered("left", leftPath, home, profiles, resume, still);
    if (still() && launch && get().panels.left.view === "preview") get().setView("left", get().panels.left.listView);
    if (still()) await openRemembered("right", rightPath, home, profiles, resume, still);
    if (!still()) {
      set({ ready: true });
    } else {
      set((state) => ({
        ready: true,
        tabs: state.tabs.map((tab) => tab.id === activeId ? { ...captureTab(state, { ...tab, opened: true }), opened: true } : tab),
        ...(resume.length ? { modal: { type: "sftpResume" as const, items: resume } } : {}),
      }));
    }
    if (externalFolder) {
      const late = externalFolder;
      externalFolder = "";
      await get().openLaunchedFolder(late);
    }
  },

  persist: async () => {
    const state = get();
    const savedTabs = state.tabs.map((tab) => toSessionTab(tab.id === state.activeTab ? captureTab(state, tab) : tab));
    const active = savedTabs.find((tab) => tab.id === state.activeTab) ?? savedTabs[0];
    await writeSession({
      theme: state.theme,
      chrome: state.chrome,
      pathStyle: state.pathStyle,
      leftPath: active?.leftPath ?? state.panels.left.path,
      rightPath: active?.rightPath ?? state.panels.right.path,
      leftView: active?.leftView ?? state.panels.left.view,
      rightView: active?.rightView ?? state.panels.right.view,
      showHidden: state.showHidden,
      iconColors: state.iconColors,
      iconSize: active?.leftIconSize ?? state.panels.left.iconSize,
      leftIconSize: active?.leftIconSize ?? state.panels.left.iconSize,
      rightIconSize: active?.rightIconSize ?? state.panels.right.iconSize,
      keyBar: state.keyBar,
      scrollLock: state.scrollLock,
      iconTints: state.iconTints,
      leftHistory: active?.leftHistory ?? state.panels.left.history,
      rightHistory: active?.rightHistory ?? state.panels.right.history,
      leftHistoryAt: active?.leftHistoryAt ?? state.panels.left.historyAt,
      rightHistoryAt: active?.rightHistoryAt ?? state.panels.right.historyAt,
      recent: state.recent,
      commandHistory: state.commandHistory,
      split: active?.split ?? state.split,
      outputHeight: state.outputHeight,
      terminalHeight: state.terminalHeight,
      nameTemplates: state.nameTemplates,
      leftNav: active?.leftNav ?? state.leftNav,
      rightNav: active?.rightNav ?? state.rightNav,
      pins: state.pins,
      activeTab: state.activeTab,
      tabs: savedTabs,
    });
  },

  toggleNav: (side) => set((state) => (side === "left" ? { leftNav: !state.leftNav } : { rightNav: !state.rightNav })),

  pinPath: (path, name) => {
    const cleanPath = path.trim();
    const cleanName = name.trim() || baseName(cleanPath);
    if (!cleanPath || !cleanName) return;
    const key = pathKey(cleanPath);
    set((state) => {
      if (state.pins.some((pin) => pathKey(pin.path) === key)) return state;
      return { pins: [...state.pins, { name: cleanName, path: cleanPath }] };
    });
  },

  unpinPath: (path) => {
    const key = pathKey(path);
    set((state) => ({ pins: state.pins.filter((pin) => pathKey(pin.path) !== key) }));
  },

  movePin: (from, to) => set((state) => {
    if (from === to || from < 0 || to < 0 || from >= state.pins.length || to >= state.pins.length) return state;
    const pins = [...state.pins];
    const [item] = pins.splice(from, 1);
    if (!item) return state;
    pins.splice(to, 0, item);
    return { pins };
  }),

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
  setChrome: (chrome) => set({ chrome }),
  setPathStyle: (pathStyle) => set({ pathStyle }),
  setActive: (side) => set({ active: side }),
  cyclePanel: (dir) => set({ active: dir === 1 ? "right" : "left" }),

  newTab: async () => {
    const state = get();
    if (!state.ready) return;
    if (state.tabs.length >= TAB_LIMIT) {
      toast("warning", "FilePad keeps up to 12 tabs.");
      return;
    }
    const gen = ++tabGen;
    clearResume();
    haltPanels();
    const id = crypto.randomUUID();
    const current = state.tabs.find((tab) => tab.id === state.activeTab);
    const currentName = current?.name.trim() ? current.name : folderTabName(state.panels.left.path);
    const kept = state.tabs.map((tab) => tab.id === state.activeTab ? { ...captureTab(state, tab), name: currentName } : tab);
    const fresh: WorkTab = {
      id,
      name: nextTabName(kept),
      opened: false,
      active: state.active,
      split: state.split,
      leftNav: state.leftNav,
      rightNav: state.rightNav,
      panels: { left: clonedPanel(state.panels.left), right: clonedPanel(state.panels.right) },
    };
    const leftPath = fresh.panels.left.path;
    const rightPath = fresh.panels.right.path;
    set({ tabs: [...kept, fresh], activeTab: id, ...applyTab(fresh), contextMenu: null });
    const still = () => gen === tabGen && get().activeTab === id;
    await get().navigate("left", leftPath);
    if (!still()) return;
    await get().navigate("right", rightPath);
    if (!still()) return;
    set((now) => ({ tabs: now.tabs.map((tab) => tab.id === id ? { ...tab, opened: true } : tab) }));
  },

  switchTab: async (id) => {
    const state = get();
    if (!state.ready || state.activeTab === id) return;
    const target = state.tabs.find((tab) => tab.id === id);
    if (!target) return;
    const gen = ++tabGen;
    clearResume();
    haltPanels();
    const tabs = state.tabs.map((tab) => tab.id === state.activeTab ? captureTab(state, tab) : tab);
    const next = tabs.find((tab) => tab.id === id) ?? target;
    set({ tabs, activeTab: id, ...applyTab(next), contextMenu: null });
    if (!next.opened) await finishCold(id, gen);
  },

  cycleTab: (dir) => {
    const state = get();
    if (!state.ready || state.tabs.length < 2) return;
    const index = state.tabs.findIndex((tab) => tab.id === state.activeTab);
    const at = index < 0 ? 0 : index;
    const next = (at + dir + state.tabs.length) % state.tabs.length;
    void get().switchTab(state.tabs[next].id);
  },

  renameTab: (id, name) => {
    const next = name.trim().slice(0, 80);
    if (!next) return;
    set((state) => ({ tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, name: next } : tab) }));
  },

  closeTab: (id) => {
    const state = get();
    if (!state.ready || state.tabs.length < 2) return;
    const index = state.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (state.activeTab !== id) {
      set({ tabs: state.tabs.filter((tab) => tab.id !== id), contextMenu: null });
      return;
    }
    const gen = ++tabGen;
    clearResume();
    haltPanels();
    const tabs = state.tabs.filter((tab) => tab.id !== id);
    const next = tabs[Math.min(index, tabs.length - 1)];
    set({ tabs, activeTab: next.id, ...applyTab(next), contextMenu: null });
    if (!next.opened) void finishCold(next.id, gen);
  },

  navigate: async (side, raw, record = true) => {
    stopSearch(side);
    if (!inTauri()) {
      set((state) => ({ panels: patch(state.panels, side, { loading: false, error: "Open the FilePad window to browse this computer." }) }));
      return;
    }
    const id = beginList(side, "open", record);
    const before = get().panels[side];
    const shown = raw.trim() || before.path;
    if (before.view === "preview" && before.path && pathKey(shown) !== pathKey(before.path)) {
      const back = before.savedView !== "preview" ? before.savedView : before.listView;
      get().setView(side, back);
    }
    set((state) => ({
      panels: patch(state.panels, side, {
        loading: true,
        error: null,
        path: shown,
        entries: pathKey(shown) === pathKey(before.path) ? before.entries : [],
        cursor: 0,
        anchor: 0,
        marked: [],
      }),
    }));
    try {
      const listing = await invoke<DirListing>("list_dir", { path: raw, id });
      if (listActive[side] !== id) return;
      const job = listJobs.get(id);
      if (job) job.settled = true;
      if (!job?.opened) applyOpen(side, listing, record, false);
      else settleOpen(side, listing, job.pinned);
      listJobs.delete(id);
      if (get().panels[side].view === "tree") await get().ensureTree(side, listing.path);
    } catch (error) {
      listJobs.delete(id);
      if (listStopped(side, id, error)) return;
      set((state) => ({
        panels: patch(state.panels, side, state.panels[side].path === shown
          ? { loading: false, error: message(error), path: before.path, entries: before.entries, cursor: before.cursor, anchor: before.anchor, marked: before.marked }
          : { loading: false, error: message(error) }),
      }));
      toast("error", message(error));
    }
  },

  goHistory: async (side, dir) => {
    const panel = get().panels[side];
    const next = panel.historyAt + dir;
    const path = panel.history[next];
    if (!path) return;
    const view = panel.viewHistory?.[next];
    const leavingPreview = panel.view === "preview";
    const before = panel.path;
    await get().navigate(side, path, false);
    const after = get().panels[side].path;
    if (after.toLowerCase() === before.toLowerCase() && after.toLowerCase() !== path.toLowerCase()) return;
    set((state) => ({ panels: patch(state.panels, side, { historyAt: next }) }));
    if (view && view !== get().panels[side].view && !(leavingPreview && view === "preview")) get().setView(side, view);
  },

  refresh: async (side) => {
    const panel = get().panels[side];
    if (!panel.path || !inTauri()) return;
    const currentName = panel.view === "tree"
      ? treeRows(panel, get().showHidden)[panel.cursor]?.name
      : fileRows(panel, get().showHidden)[panel.cursor]?.name;
    const id = beginList(side, "refresh", false);
    try {
      const listing = await invoke<DirListing>("list_dir", { path: panel.path, id });
      if (listActive[side] !== id) return;
      const job = listJobs.get(id);
      if (job) job.settled = true;
      listJobs.delete(id);
      set((state) => {
        const marked = state.panels[side].marked.filter((path) => listing.entries.some((entry) => entry.path === path));
        const next: Panel = {
          ...state.panels[side],
          path: listing.path,
          parent: listing.parent,
          entries: listing.entries,
          marked,
          loading: false,
          error: null,
          treeKids: state.panels[side].view === "tree" ? { [listing.path]: listing.entries } : {},
          treeExpanded: [],
        };
        const list = next.view === "tree" ? treeRows(next, state.showHidden) : fileRows(next, state.showHidden);
        const index = list.findIndex((row) => row.name === currentName);
        next.cursor = index >= 0 ? index : Math.min(next.cursor, Math.max(0, list.length - 1));
        next.anchor = next.cursor;
        return { panels: { ...state.panels, [side]: next } };
      });
      if (get().panels[side].view === "tree") await get().ensureTree(side, listing.path);
      const next = get().panels[side];
      if (next.filter.trim() && (next.searched.trim() || !hasLocalMatch(next, get().showHidden))) void runSearch(side, false);
    } catch (error) {
      listJobs.delete(id);
      if (listStopped(side, id, error)) return;
      toast("error", message(error));
    }
  },

  refreshBoth: async () => {
    await get().refresh("left");
    await get().refresh("right");
  },

  setFilter: (side, filter) => {
    stopSearch(side);
    set((state) => ({ panels: patch(state.panels, side, { filter, cursor: 0, anchor: 0, hits: [], searching: false, searched: "", searchLimited: false, searchCap: 0 }) }));
    if (filter.trim()) scheduleSearch(side);
  },

  searchDeeper: (side) => {
    if (!get().panels[side].filter.trim()) return;
    void runSearch(side, true);
  },

  setView: (side, view) => {
    if (get().panels[side].view === view) return;
    set((state) => {
      const panel = state.panels[side];
      const listView = view === "files" || view === "details" || view === "icons" ? view : panel.listView;
      const enteringPreview = view === "preview" && panel.view !== "preview";
      const leavingPreview = panel.view === "preview" && view !== "preview";
      const savedView = enteringPreview ? panel.view : panel.savedView;
      const cursor = enteringPreview || leavingPreview ? panel.cursor : 0;
      const viewHistory = [...(panel.viewHistory ?? [])];
      while (viewHistory.length < panel.history.length) viewHistory.push(panel.view);
      if (panel.history.length) viewHistory[panel.historyAt] = view;
      return { panels: patch(state.panels, side, { view, listView, savedView, cursor, anchor: cursor, viewHistory }) };
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
    const active = actionSide(state);
    const sides: Side[] = state.scrollLock ? ["left", "right"] : [active];
    set((current) => {
      let panels = current.panels;
      for (const side of sides) {
        const panel = panels[side];
        const rows = panel.view === "tree" ? treeRows(panel, current.showHidden) : fileRows(panel, current.showHidden);
        if (!rows.length) continue;
        const next = Math.max(0, Math.min(rows.length - 1, panel.cursor + delta));
        if (mark && side === active && panel.view !== "tree") {
          const list = fileRows(panel, current.showHidden);
          const lo = Math.min(panel.anchor, next);
          const hi = Math.max(panel.anchor, next);
          const add = list.slice(lo, hi + 1).filter((row) => !row.up).map((row) => row.path);
          panels = patch(panels, side, { cursor: next, marked: [...new Set([...panel.marked, ...add])] });
        } else {
          panels = patch(panels, side, { cursor: next, anchor: next });
        }
      }
      return { panels };
    });
  },

  toggleMark: (side, index, advance) => {
    const state = get();
    const panel = state.panels[side];
    if (panel.view === "tree") {
      const row = treeRows(panel, state.showHidden)[index];
      if (row?.isDir) void get().toggleTree(side, row.path);
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

  clearMarks: () => set((state) => {
    const side = actionSide(state);
    const bare = (panel: Panel, clearCursor: boolean): Panel => ({ ...panel, marked: [], ...(clearCursor ? { cursor: -1, anchor: -1 } : {}) });
    return { panels: { left: bare(state.panels.left, side === "left"), right: bare(state.panels.right, side === "right") } };
  }),

  openEntry: async () => {
    const state = get();
    const side = actionSide(state);
    const panel = state.panels[side];
    if (panel.view === "tree") {
      const row = treeRows(panel, state.showHidden)[panel.cursor];
      if (!row) return;
      if (row.isDir) {
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
      return;
    }
    const row = fileRows(panel, state.showHidden)[panel.cursor];
    if (!row) return;
    if (row.up || row.isDir) {
      await get().openFolder(side, row.path, row.name, row.up);
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
    if (parent) await get().openFolder(side, parent, "..", true);
  },

  openFolder: async (side, path, name, up) => {
    const state = get();
    const mirror = state.scrollLock ? matchedFolder(state.panels[other(side)], name, up) : null;
    await get().navigate(side, path);
    if (mirror) await get().navigate(other(side), mirror);
  },

  ensureTree: async (side, path) => {
    if (!path || !inTauri() || get().panels[side].treeKids[path]) return;
    try {
      const listing = await invoke<DirListing>("list_dir", { path, id: 0 });
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
    const label = mode === "copy" ? "Copying" : "Moving";
    set({ transfer: { done: 0, total: 0, current: "Starting", label } });
    startTransferJob(`${label}…`);
    try {
      const command = mode === "copy" ? "copy_paths" : "move_paths";
      const result = await invoke<TransferResult>(command, { sources, destDir: dest, overwrite });
      if (result.conflicts.length) {
        const transfer: PendingTransfer = { mode, sources, dest, note };
        cancelTransferJob();
        set({ transfer: null, modal: { type: "overwrite", transfer, conflicts: result.conflicts } });
        return;
      }
      if (mode === "cut") set({ clipboard: null });
      set({ transfer: null, modal: null });
      finishTransferJob("success", note ?? (mode === "copy" ? "Copied." : "Moved."));
      await get().refreshBoth();
    } catch (error) {
      set({ transfer: null });
      finishTransferJob("error", message(error));
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

  setFolderApp: async (enabled) => {
    try {
      await invoke("set_folder_app", { enabled });
      set({ folderApp: enabled });
      toast("success", enabled ? "Folders open in FilePad." : "Folders open in File Explorer.");
    } catch (error) {
      toast("error", message(error));
    }
  },

  openLaunchedFolder: async (path, side) => {
    const target = side ?? get().active;
    const panel = get().panels[target];
    if (panel.view === "preview") get().setView(target, panel.listView);
    set({ active: target });
    await get().navigate(target, path);
  },

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
      set({ contextMenu: null, transfer: { done: 0, total: 0, current: "Extracting", label: "Extracting" } });
      startTransferJob("Extracting…");
      try {
        await invoke<string[]>("extract_archives", { archives, destDir: dest });
        set({ transfer: null });
        finishTransferJob("success", "Extracted.");
        await get().refreshBoth();
      } catch (error) {
        set({ transfer: null });
        finishTransferJob("error", message(error));
        await get().refreshBoth();
      }
      return;
    }
    set({ contextMenu: null });
    await get().beginTransfer("copy", entries, dest, false, "Extracted.");
  },

  confirmDelete: async () => {
    const modal = get().modal;
    if (modal?.type !== "delete" || deleting) return;
    deleting = true;
    const paths = modal.paths.slice();
    try {
      await invoke("delete_paths", { paths });
      set({ modal: null });
      toast("success", paths.length === 1 ? "Deleted 1 item." : `Deleted ${paths.length} items.`);
      await get().refreshBoth();
    } catch (error) {
      toast("error", message(error));
    } finally {
      deleting = false;
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
      await get().renamePath(modal.path, name);
      set({ modal: null });
    } catch (error) {
      toast("error", message(error));
    }
  },

  renamePath: async (path, name) => {
    const renamed = await invoke<string>("rename_path", { path, name });
    toast("success", "Renamed.");
    await get().refreshBoth();
    const hidden = get().showHidden;
    for (const side of ["left", "right"] as const) {
      const panel = get().panels[side];
      const rows = panel.view === "tree" ? treeRows(panel, hidden) : fileRows(panel, hidden);
      const index = rows.findIndex((row) => row.path === renamed);
      if (index >= 0) set((state) => ({ panels: patch(state.panels, side, { cursor: index, anchor: index }) }));
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
    const job = jobStart("Creating zip…");
    try {
      await invoke("zip_paths", { sources: modal.paths, dest });
      set({ modal: null });
      jobFinish(job, "success", "Zip created.");
      await get().refresh(modal.side);
      const index = fileRows(get().panels[modal.side], get().showHidden).findIndex((row) => row.name.toLowerCase() === file.toLowerCase());
      if (index >= 0) set((state) => ({ panels: patch(state.panels, modal.side, { cursor: index, anchor: index }) }));
    } catch (error) {
      jobFinish(job, "error", message(error));
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
    startTransferJob("Converting…");
    try {
      const result = await invoke<ConvertReport>("convert_images", { paths, format, quality, background, replace });
      set({ transfer: null });
      if (result.written) finishTransferJob("success", result.written === 1 ? "Converted 1 picture." : `Converted ${result.written} pictures.`);
      else if (result.skipped) finishTransferJob("warning", result.reason ? `Skipped ${result.skipped}. ${result.reason}` : `Skipped ${result.skipped}.`);
      else finishTransferJob("warning", "Nothing to convert.");
      if (result.written && result.skipped) toast("warning", result.reason ? `Skipped ${result.skipped}. ${result.reason}` : `Skipped ${result.skipped}.`);
      await get().refresh(side);
    } catch (error) {
      set({ transfer: null });
      finishTransferJob("error", message(error));
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

  confirmSftpResume: async () => {
    const modal = get().modal;
    if (modal?.type !== "sftpResume") return;
    const items = modal.items;
    set({ modal: null });
    for (const item of items) await get().navigate(item.side, item.path);
  },

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
      const row = treeRows(panel, state.showHidden)[panel.cursor];
      if (!row) return;
      if (row.isDir) {
        await get().navigate(side, row.path);
        return;
      }
      const browse = archiveBrowse(row.path, row.extension);
      if (browse) {
        await get().navigate(side, browse);
        return;
      }
      try {
        await openExternal(row.path);
      } catch (error) {
        toast("error", message(error));
      }
      return;
    }
    const row = fileRows(panel, state.showHidden)[panel.cursor];
    if (!row) return;
    const browse = !row.up && !row.isDir ? archiveBrowse(row.path, row.extension) : null;
    if (row.up || row.isDir) await get().openFolder(side, row.path, row.name, row.up);
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

  setIconSize: (side, size) => {
    holdScrollSync();
    set((state) => ({ panels: patch(state.panels, side, { iconSize: iconColumnsOf(size) }) }));
  },
  toggleHidden: () => {
    set((state) => ({ showHidden: !state.showHidden }));
    const showHidden = get().showHidden;
    for (const side of ["left", "right"] as const) {
      const panel = get().panels[side];
      if (!panel.filter.trim()) continue;
      if (panel.searched.trim() || !hasLocalMatch(panel, showHidden)) void runSearch(side, false);
    }
  },
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
  toggleTerminal: () => set((state) => ({ terminalOpen: !state.terminalOpen, terminalExpanded: state.terminalOpen ? false : state.terminalExpanded })),
  expandTerminal: () => set({ terminalOpen: true, terminalExpanded: true }),
  restoreTerminal: () => set({ terminalExpanded: false }),
  toggleKeyBar: () => set((state) => ({ keyBar: !state.keyBar })),
  toggleScrollLock: () => {
    const scrollLock = !get().scrollLock;
    setScrollLock(scrollLock);
    set({ scrollLock });
    if (scrollLock) alignScroll(get().active);
  },
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
    const cwd = isRemotePath(here) ? here : diskFolder(here);
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

  onListBatch: (batch) => {
    const job = listJobs.get(batch.id);
    if (!job || job.settled || listActive[job.side] !== batch.id) return;
    if (job.mode === "refresh") {
      set((state) => {
        const panel = state.panels[job.side];
        const entries = batch.seq === 0 ? batch.entries : panel.entries.concat(batch.entries);
        const treeKids = panel.view === "tree" ? { ...panel.treeKids, [batch.path]: entries } : panel.treeKids;
        return { panels: patch(state.panels, job.side, { path: batch.path, parent: batch.parent, entries, treeKids, loading: !batch.done, error: null }) };
      });
      return;
    }
    const listing: DirListing = { path: batch.path, parent: batch.parent, entries: batch.entries };
    if (!job.opened) {
      job.opened = true;
      applyOpen(job.side, listing, job.record, !batch.done);
      return;
    }
    const state = get();
    const panel = state.panels[job.side];
    if (panel.cursor > 0) {
      const row = fileRows(panel, state.showHidden)[panel.cursor];
      if (row && !row.up) job.pinned = row.path;
    }
    appendListed(job.side, batch, job.pinned);
  },

  onTransfer: (incoming) => {
    const label = incoming.label ?? get().transfer?.label;
    const transfer = { ...incoming, label };
    set({ transfer });
    if (!transferJob) return;
    const ratio = transfer.total > 0 ? Math.min(1, transfer.done / transfer.total) : null;
    const head = ratio == null ? `${label ?? "Copying"}…` : `${label ?? "Copying"} ${Math.round(ratio * 100)}%`;
    const name = transfer.current && transfer.current !== "Starting" ? transfer.current : "";
    jobUpdate(transferJob, ratio, name ? `${head} · ${name}` : head);
  },
  setPalette: (paletteOpen) => set({ paletteOpen }),

  clearRecent: () => set({ recent: [] }),
  forgetRecent: (path) => set((state) => ({ recent: state.recent.filter((item) => pathKey(item) !== pathKey(path)) })),

  askSftp: (draft) => set({ contextMenu: null, paletteOpen: false, modal: { type: "sftp", draft } }),

  askConnections: () => set({ contextMenu: null, paletteOpen: false, modal: { type: "connections" } }),

  editConnection: (id) => {
    const profile = get().sftpProfiles.find((item) => item.id === id);
    if (!profile) return;
    set({
      contextMenu: null,
      paletteOpen: false,
      modal: {
        type: "sftp",
        draft: {
          profileId: profile.id,
          label: profile.label,
          host: profile.host,
          port: String(profile.port),
          username: profile.username,
          password: "",
          privateKey: "",
          passphrase: "",
          remotePath: profile.remotePath,
        },
      },
    });
  },

  askForgetSftp: (id) => {
    const profile = get().sftpProfiles.find((item) => item.id === id);
    if (!profile) return;
    set({ contextMenu: null, modal: { type: "forgetSftp", id: profile.id, label: profile.label } });
  },

  confirmForgetSftp: async () => {
    const modal = get().modal;
    if (modal?.type !== "forgetSftp") return;
    try {
      await invoke("sftp_forget", { id: modal.id });
      for (const side of ["left", "right"] as Side[]) {
        const remote = remoteParts(get().panels[side].path);
        if (remote?.id !== modal.id) continue;
        const local = get().panels[side].localPath;
        const next = local || await invoke<string>("home_dir");
        await get().navigate(side, next);
      }
      await get().loadPlaces();
      set({ modal: { type: "connections" } });
      toast("success", "Removed that connection.");
    } catch (error) {
      toast("error", message(error));
    }
  },

  askServers: () => set({ contextMenu: null, paletteOpen: false, modal: { type: "servers" } }),

  submitSftp: async (draft, acceptFingerprint, replacePin) => {
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast("warning", "Enter a port from 1 to 65535.");
      return;
    }
    try {
      const result = await invoke<{ status: string; path: string | null; fingerprint: string; pinned: string | null; username: string; host: string }>("sftp_open", {
        request: {
          profileId: draft.profileId ?? null,
          label: draft.label,
          host: draft.host,
          port: Number(draft.port),
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
