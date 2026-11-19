import { useEffect, useRef, useState } from "react";
import { fileRows, markSet, previewTarget } from "../lib/rows";
import { formatBytes, formatWhen, isPackedPath, isRemotePath, pathKey, typeLabel } from "../lib/format";
import { invoke } from "../lib/platform";
import { useApp } from "../stores/appStore";
import type { Side } from "../types";

interface Tally {
  size: number;
  files: number;
}

const tallies = new Map<string, Tally>();
const tallyWait = new Map<string, Promise<void>>();
const tallyListeners = new Set<() => void>();

function publishTallies() {
  for (const listen of tallyListeners) listen();
}

function walkable(row: { path: string; isDir: boolean }): boolean {
  return row.isDir && !isRemotePath(row.path) && !isPackedPath(row.path);
}

function tallyKey(row: { path: string; modified: number }): string {
  return `${pathKey(row.path)}|${row.modified}`;
}

function useTallies(rows: { path: string; isDir: boolean; modified: number }[]) {
  const token = rows.filter(walkable).map(tallyKey).sort().join("\n");
  const latest = useRef(rows);
  latest.current = rows;
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    const listen = () => setStamp((value) => value + 1);
    tallyListeners.add(listen);
    return () => {
      tallyListeners.delete(listen);
    };
  }, []);
  useEffect(() => {
    const missing: { path: string; isDir: boolean; modified: number }[] = [];
    const seen = new Set<string>();
    let waiting = false;
    for (const row of latest.current) {
      if (!walkable(row)) continue;
      const key = tallyKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      if (tallies.has(key)) continue;
      if (tallyWait.has(key)) {
        waiting = true;
        continue;
      }
      missing.push(row);
    }
    if (!missing.length) {
      if (!waiting) setStamp((value) => value + 1);
      return;
    }
    const keys = missing.map(tallyKey);
    const job = invoke<{ path: string; size: number; files: number; folders: number }[]>("measure_paths", { paths: missing.map((row) => row.path) })
      .then((result) => {
        result.forEach((item, index) => {
          const key = keys[index];
          if (!key) return;
          tallies.set(key, { size: item.size, files: item.files });
        });
      })
      .catch(() => {
        for (const key of keys) tallies.set(key, { size: 0, files: 0 });
      })
      .finally(() => {
        for (const key of keys) tallyWait.delete(key);
        publishTallies();
      });
    for (const key of keys) tallyWait.set(key, job);
  }, [token]);
  void stamp;
  return (row: { path: string; isDir: boolean; size: number; modified: number }) => {
    if (!walkable(row)) return { size: row.isDir ? 0 : row.size, files: row.isDir ? 0 : 1, pending: false };
    const found = tallies.get(tallyKey(row));
    if (!found) return { size: 0, files: 0, pending: true };
    return { size: found.size, files: found.files, pending: false };
  };
}

function selectionLine(count: number, noun: string, rows: { path: string; isDir: boolean; size: number; modified: number }[], read: ReturnType<typeof useTallies>): string {
  let size = 0;
  let files = 0;
  let pending = false;
  let dirs = false;
  for (const row of rows) {
    if (row.isDir) dirs = true;
    const part = read(row);
    size += part.size;
    files += part.files;
    pending = pending || part.pending;
  }
  const head = `${count} ${noun}`;
  if (dirs && pending) return `${head} · counting…`;
  if (dirs) return `${head} · ${files} ${files === 1 ? "file" : "files"} · ${formatBytes(size)}`;
  return `${head} · ${formatBytes(size)}`;
}

export function StatusBar() {
  const transfer = useApp((state) => state.transfer);
  if (!transfer) return null;
  const ratio = transfer.total > 0 ? Math.min(1, transfer.done / transfer.total) : null;
  const amount = transfer.total > 0
    ? transfer.bytes
      ? `${formatBytes(transfer.done)} / ${formatBytes(transfer.total)}`
      : `${transfer.done}/${transfer.total}`
    : "…";
  return (
    <div className="fp-chrome flex h-7 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] bg-[var(--bg)] px-3 text-xs text-[var(--muted)]">
      <span className="min-w-0 flex-1 truncate">{transfer.label ?? "Copying"} {amount} {transfer.current}</span>
      <span className="fp-toast-bar w-40 shrink-0" data-busy={ratio == null ? "true" : undefined}>
        <span style={ratio != null ? { width: `${Math.round(ratio * 100)}%` } : undefined} />
      </span>
    </div>
  );
}

export function PanelStatus({ side }: { side: Side }) {
  const panel = useApp((state) => state.panels[side]);
  const showHidden = useApp((state) => state.showHidden);
  const source = useApp((state) => state.panels[side === "left" ? "right" : "left"]);
  const rows = panel.view === "preview" ? [] : fileRows(panel, showHidden).filter((row) => !row.up);
  const marks = markSet(panel.marked);
  const markedRows = panel.view === "preview" ? [] : [...panel.entries, ...panel.hits].filter((entry) => marks.has(entry.path));
  const read = useTallies([...rows, ...markedRows]);
  if (panel.view === "preview") {
    const sourceRow = source.view === "tree" ? null : fileRows(source, showHidden)[source.cursor];
    if (sourceRow?.up) {
      return (
        <div className="flex h-7 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] px-3 text-xs text-[var(--muted)]">
          <span className="min-w-0 truncate">Parent folder of the other panel</span>
        </div>
      );
    }
    const row = previewTarget(source, showHidden);
    return (
      <div className="flex h-7 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] px-3 text-xs text-[var(--muted)]">
        {row && <span className="min-w-0 truncate">{row.name}</span>}
        {row && <span className="shrink-0">{typeLabel(row)}</span>}
        {row && !row.isDir && <span className="shrink-0">{formatBytes(row.size)}</span>}
        {row && <span className="shrink-0">{formatWhen(row.modified)}</span>}
      </div>
    );
  }
  const count = selectionLine(rows.length, rows.length === 1 ? "item" : "items", rows, read);
  const marked = selectionLine(markedRows.length, "marked", markedRows, read);
  return (
    <div className="flex h-7 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] px-3 text-xs text-[var(--muted)]">
      <span className="shrink-0">{count}</span>
      {panel.searching && <span className="shrink-0">Searching…</span>}
      {!panel.searching && panel.searchLimited && panel.filter.trim().toLowerCase() === panel.searched.trim().toLowerCase() && <span className="shrink-0">First {panel.searchCap} matches</span>}
      {markedRows.length > 0 && <span className="shrink-0">{marked}</span>}
    </div>
  );
}
