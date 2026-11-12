import { typeLabel } from "./format";
import type { Entry, Panel } from "../types";

export interface Row {
  key: string;
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
  extension: string;
  up: boolean;
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
}

export function fileRows(panel: Panel, showHidden: boolean): Row[] {
  let entries = panel.entries.filter((entry) => showHidden || !entry.hidden);
  const query = panel.filter.trim().toLowerCase();
  if (query) entries = entries.filter((entry) => entry.name.toLowerCase().includes(query));
  entries.sort((left, right) => compareEntries(left, right, panel.sortKey, panel.sortAsc));
  const rows = entries.map(toRow);
  if (panel.parent && !query) {
    rows.unshift({ key: `up:${panel.path}`, name: "..", path: panel.parent, isDir: true, size: 0, modified: 0, extension: "", up: true });
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
        });
      }
      if (open) walk(kid.path, depth + 1);
    }
  };
  walk(panel.path, 0);
  return rows;
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

function toRow(entry: Entry): Row {
  return { key: entry.path, name: entry.name, path: entry.path, isDir: entry.isDir, size: entry.size, modified: entry.modified, extension: entry.extension, up: false };
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
