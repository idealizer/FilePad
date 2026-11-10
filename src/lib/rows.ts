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

export function treeRows(panel: Panel, showHidden: boolean): TreeRow[] {
  const rows: TreeRow[] = [];
  const query = panel.filter.trim().toLowerCase();
  const walk = (path: string, depth: number) => {
    const kids = (panel.treeKids[path] ?? []).filter((entry) => entry.isDir && (showHidden || !entry.hidden));
    for (const kid of kids) {
      if (query && !kid.name.toLowerCase().includes(query)) continue;
      rows.push({ key: kid.path, name: kid.name, path: kid.path, depth, expanded: panel.treeExpanded.includes(kid.path) });
      if (panel.treeExpanded.includes(kid.path)) walk(kid.path, depth + 1);
    }
  };
  walk(panel.path, 0);
  return rows;
}

function toRow(entry: Entry): Row {
  return { key: entry.path, name: entry.name, path: entry.path, isDir: entry.isDir, size: entry.size, modified: entry.modified, extension: entry.extension, up: false };
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
