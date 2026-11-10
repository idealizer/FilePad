export function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return index >= 0 ? trimmed.slice(0, index) : trimmed;
}

export function joinPath(folder: string, name: string): string {
  const sep = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}${name}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = size >= 10 || unit === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

export function formatWhen(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function typeLabel(entry: { isDir: boolean; extension: string }): string {
  if (entry.isDir) return "Folder";
  return entry.extension ? entry.extension.toUpperCase() : "File";
}

export function shortPath(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `…\\${parts.slice(-2).join("\\")}`;
}

export function isZipPath(path: string): boolean {
  return path.startsWith("zip:");
}

export function displayPath(path: string): string {
  if (!isZipPath(path)) return path;
  const body = path.slice(4);
  const bar = body.indexOf("|");
  if (bar < 0) return path;
  const archive = body.slice(0, bar);
  const inner = body.slice(bar + 1).replaceAll("/", "\\");
  return inner ? `${archive}\\${inner}` : archive;
}

export function storePath(draft: string): string {
  const text = draft.trim();
  if (text.toLowerCase().startsWith("zip:")) return text;
  const match = /^(.*\.zip)(?:[\\/](.*))?$/i.exec(text);
  if (!match) return text;
  const inner = (match[2] ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return `zip:${match[1]}|${inner}`;
}

export function diskFolder(path: string): string {
  if (!isZipPath(path)) return path;
  const archive = path.slice(4).split("|")[0] ?? "";
  const cut = Math.max(archive.lastIndexOf("\\"), archive.lastIndexOf("/"));
  return cut > 0 ? archive.slice(0, cut) : archive;
}
