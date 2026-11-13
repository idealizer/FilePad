import { pathKey, relativePlace, typeLabel } from "./format";
import type { Entry, Panel } from "../types";

const markSets = new WeakMap<string[], Set<string>>();

export function markSet(paths: string[]): Set<string> {
  const found = markSets.get(paths);
  if (found) return found;
  const set = new Set(paths);
  markSets.set(paths, set);
  return set;
}

const rowCache: { panel: Panel; hidden: boolean; rows: Row[] }[] = [];
const treeCache: { panel: Panel; hidden: boolean; rows: TreeRow[] }[] = [];

function cachedRows(panel: Panel, showHidden: boolean): Row[] | null {
  for (let index = rowCache.length - 1; index >= 0; index -= 1) {
    const hit = rowCache[index];
    if (hit.panel === panel && hit.hidden === showHidden) return hit.rows;
  }
  return null;
}

function cachedTree(panel: Panel, showHidden: boolean): TreeRow[] | null {
  for (let index = treeCache.length - 1; index >= 0; index -= 1) {
    const hit = treeCache[index];
    if (hit.panel === panel && hit.hidden === showHidden) return hit.rows;
  }
  return null;
}

export interface Row {
  key: string;
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  extension: string;
  up: boolean;
  place: string;
}

export interface TreeRow {
  key: string;
  name: string;
  path: string;
  depth: number;
  expanded: boolean;
  isDir: boolean;
  size: number;
  modified: number;
  extension: string;
  place: string;
}

export function hasLocalMatch(panel: Panel, showHidden: boolean): boolean {
  const query = panel.filter.trim().toLowerCase();
  return panel.entries.some((entry) => (showHidden || !entry.hidden) && (!query || entry.name.toLowerCase().includes(query)));
}

export function folderNote(panel: Panel, shown: number, showHidden: boolean): string | null {
  if (panel.error || shown > 0) return null;
  if (panel.loading) return "Reading…";
  const query = panel.filter.trim();
  if (!query) return "This folder is empty.";
  if (hasLocalMatch(panel, showHidden)) return null;
  if (panel.searching || panel.searched.trim().toLowerCase() !== query.toLowerCase()) return "Searching…";
  if (panel.searchLimited) return "Nothing in the first part of this folder.";
  return "No matches.";
}

export function fileRows(panel: Panel, showHidden: boolean): Row[] {
  const hit = cachedRows(panel, showHidden);
  if (hit) return hit;
  const rows = buildFileRows(panel, showHidden);
  rowCache.push({ panel, hidden: showHidden, rows });
  if (rowCache.length > 8) rowCache.shift();
  return rows;
}

function buildFileRows(panel: Panel, showHidden: boolean): Row[] {
  const query = panel.filter.trim().toLowerCase();
  const entries = matching(panel.entries, showHidden, query).sort((left, right) => compareEntries(left, right, panel.sortKey, panel.sortAsc));
  const rows = entries.map((entry) => toRow(entry, ""));
  if (query && panel.searched.trim().toLowerCase() === query) {
    const seen = new Set(rows.map((row) => pathKey(row.path)));
    const extra = matching(panel.hits, showHidden, query)
      .filter((entry) => !seen.has(pathKey(entry.path)))
      .sort((left, right) => compareEntries(left, right, panel.sortKey, panel.sortAsc));
    for (const entry of extra) rows.push(toRow(entry, relativePlace(panel.path, entry.path)));
  }
  if (panel.parent && !query) {
    rows.unshift({ key: `up:${panel.path}`, name: "..", path: panel.parent, isDir: true, size: 0, modified: 0, extension: "", up: true, place: "" });
  }
  return rows;
}

export function previewTarget(panel: Panel, showHidden: boolean): Row | TreeRow | null {
  if (panel.view === "tree") return treeRows(panel, showHidden)[panel.cursor] ?? null;
  const row = fileRows(panel, showHidden)[panel.cursor];
  if (!row || row.up) return null;
  return row;
}

export function treeRows(panel: Panel, showHidden: boolean): TreeRow[] {
  const hit = cachedTree(panel, showHidden);
  if (hit) return hit;
  const rows = buildTreeRows(panel, showHidden);
  treeCache.push({ panel, hidden: showHidden, rows });
  if (treeCache.length > 8) treeCache.shift();
  return rows;
}

function buildTreeRows(panel: Panel, showHidden: boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const query = panel.filter.trim().toLowerCase();
  const walk = (path: string, depth: number) => {
    const kids = (panel.treeKids[path] ?? []).filter((entry) => showHidden || !entry.hidden);
    kids.sort((left, right) => compareEntries(left, right, panel.sortKey, panel.sortAsc));
    for (const kid of kids) {
      const open = kid.isDir && panel.treeExpanded.includes(kid.path);
      const matches = !query || kid.name.toLowerCase().includes(query);
      if (matches || open) {
        rows.push({
          key: kid.path,
          name: kid.name,
          path: kid.path,
          depth,
          expanded: open,
          isDir: kid.isDir,
          size: kid.size,
          modified: kid.modified,
          extension: kid.extension,
          place: "",
        });
      }
      if (open) walk(kid.path, depth + 1);
    }
  };
  walk(panel.path, 0);
  if (query && panel.searched.trim().toLowerCase() === query) {
    const seen = new Set(rows.map((row) => pathKey(row.path)));
    const extra = matching(panel.hits, showHidden, query)
      .filter((entry) => !seen.has(pathKey(entry.path)))
      .sort((left, right) => compareEntries(left, right, panel.sortKey, panel.sortAsc));
    for (const entry of extra) {
      rows.push({
        key: entry.path,
        name: entry.name,
        path: entry.path,
        depth: 0,
        expanded: false,
        isDir: entry.isDir,
        size: entry.size,
        modified: entry.modified,
        extension: entry.extension,
        place: relativePlace(panel.path, entry.path),
      });
    }
  }
  return rows;
}

function matching(entries: Entry[], showHidden: boolean, query: string): Entry[] {
  return entries.filter((entry) => (showHidden || !entry.hidden) && (!query || entry.name.toLowerCase().includes(query)));
}

export function otherNames(entries: Entry[], showHidden: boolean, filter: string): Set<string> {
  const query = filter.trim().toLowerCase();
  const names = new Set<string>();
  for (const entry of entries) {
    if (!showHidden && entry.hidden) continue;
    const name = entry.name.toLowerCase();
    if (query && !name.includes(query)) continue;
    names.add(name);
  }
  return names;
}

export function pairMark(names: Set<string> | null, row: { up: boolean; name: string }): "same" | "only" | undefined {
  if (!names || row.up) return undefined;
  return names.has(row.name.toLowerCase()) ? "same" : "only";
}

function toRow(entry: Entry, place: string): Row {
  return { key: entry.path, name: entry.name, path: entry.path, isDir: entry.isDir, size: entry.size, modified: entry.modified, extension: entry.extension, up: false, place };
}

let lastUpClick = { key: "", at: 0 };
let climbedAt = 0;

export function parentClick(key: string): boolean {
  const now = performance.now();
  if (lastUpClick.key === key && now - lastUpClick.at < 500) {
    lastUpClick = { key: "", at: 0 };
    return takeClimb(now);
  }
  lastUpClick = { key, at: now };
  return false;
}

export function parentDoubleClick(): boolean {
  lastUpClick = { key: "", at: 0 };
  return takeClimb(performance.now());
}

function takeClimb(now: number): boolean {
  if (now - climbedAt < 450) return false;
  climbedAt = now;
  return true;
}

function compareEntries(left: Entry, right: Entry, key: Panel["sortKey"], asc: boolean): number {
  if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
  let order = 0;
  if (key === "size") order = left.size - right.size;
  else if (key === "modified") order = left.modified - right.modified;
  else if (key === "type") order = typeLabel(left).localeCompare(typeLabel(right));
  else order = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  if (order === 0) order = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  return asc ? order : -order;
}
