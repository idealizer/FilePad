export function pathKey(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  return (trimmed || path.trim()).toLowerCase();
}

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

export function isPackedPath(path: string): boolean {
  return path.startsWith("zip:") || path.startsWith("gz:");
}

export function isRemotePath(path: string): boolean {
  return path.startsWith("sftp:");
}

export function remoteParts(path: string): { id: string; remote: string } | null {
  if (!path.startsWith("sftp:")) return null;
  const rest = path.slice(5);
  const cut = rest.indexOf(":");
  if (cut <= 0) return null;
  return { id: rest.slice(0, cut), remote: rest.slice(cut + 1) || "/" };
}

function packedBody(path: string): { prefix: "zip" | "gz"; archive: string; inner: string } | null {
  const prefix = path.startsWith("zip:") ? "zip" : path.startsWith("gz:") ? "gz" : "";
  if (!prefix) return null;
  const body = path.slice(prefix.length + 1);
  const bar = body.indexOf("|");
  if (bar < 0) return { prefix, archive: body, inner: "" };
  return { prefix, archive: body.slice(0, bar), inner: body.slice(bar + 1) };
}

export function displayPath(path: string, connections: { id: string; label: string }[] = []): string {
  const remote = remoteParts(path);
  if (remote) {
    const name = connections.find((item) => item.id === remote.id)?.label.trim() || "Server";
    return `sftp / ${name} / ${remote.remote}`;
  }
  const packed = packedBody(path);
  if (!packed) return path;
  const inner = packed.inner.replaceAll("/", "\\");
  return inner ? `${packed.archive}\\${inner}` : packed.archive;
}

export function storePath(draft: string, current = ""): string {
  const text = draft.trim();
  const lower = text.toLowerCase();
  if (lower.startsWith("sftp:")) return text;
  const remote = remoteParts(current);
  const labeled = /^sftp\s+\/\s+.+?\s+\/\s+(\/.*)$/i.exec(text);
  if (remote && labeled) return `sftp:${remote.id}:${labeled[1]}`;
  if (remote && (text.startsWith("/") || lower.startsWith("sftp "))) {
    const next = text.replace(/^sftp\s+/i, "");
    return `sftp:${remote.id}:${next.startsWith("/") ? next : `/${next}`}`;
  }
  if (lower.startsWith("zip:") || lower.startsWith("gz:")) return text;
  const zip = /^(.*\.zip)(?:[\\/](.*))?$/i.exec(text);
  if (zip) {
    const inner = (zip[2] ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    return `zip:${zip[1]}|${inner}`;
  }
  const gz = /^(.*\.(?:tar\.gz|tgz|gzip|gz))(?:[\\/](.*))?$/i.exec(text);
  if (!gz) return text;
  const inner = (gz[2] ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  return `gz:${gz[1]}|${inner}`;
}

export function zipInner(path: string): string | null {
  return packedBody(path)?.inner ?? null;
}

function isGzName(path: string): boolean {
  return /\.(?:tar\.gz|tgz|gzip|gz)$/i.test(path);
}

export function archiveFile(path: string): string | null {
  const packed = packedBody(path);
  if (!packed) return /\.zip$/i.test(path) || isGzName(path) ? path : null;
  if (packed.inner) return null;
  return packed.archive || null;
}

export function canExtract(path: string): boolean {
  if (archiveFile(path)) return true;
  const packed = packedBody(path);
  if (!packed) return false;
  const inner = packed.inner.toLowerCase();
  return !/\.(?:zip|tar\.gz|tgz|gzip|gz)$/i.test(inner);
}

const stillImages = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export function isStillImage(path: string): boolean {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 && stillImages.has(name.slice(dot + 1).toLowerCase());
}

export function diskFolder(path: string): string {
  if (isRemotePath(path)) return "";
  const packed = packedBody(path);
  if (!packed) return path;
  const cut = Math.max(packed.archive.lastIndexOf("\\"), packed.archive.lastIndexOf("/"));
  return cut > 0 ? packed.archive.slice(0, cut) : packed.archive;
}
