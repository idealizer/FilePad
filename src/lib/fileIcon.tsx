import type { CSSProperties } from "react";
import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, FolderUp } from "lucide-react";
import { useApp } from "../stores/appStore";

const images = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "tif", "tiff", "heic", "heif"];
const sheets = ["xls", "xlsx", "csv", "tsv"];
const text = ["txt", "md", "markdown", "log", "rtf"];
const archives = ["zip", "gz", "gzip", "tgz", "7z", "rar"];
const audio = ["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "wma"];
const video = ["mp4", "m4v", "webm", "mov", "mkv", "ogv", "vob"];
const code = ["js", "jsx", "ts", "tsx", "json", "rs", "py", "css", "html", "htm", "xml", "php", "go", "java", "c", "h", "cpp", "cs", "rb", "sh", "ps1", "sql", "toml", "yaml", "yml"];
const programs = ["exe", "com", "scr", "bat", "cmd", "msi", "msix", "msixbundle", "appx", "appxbundle", "msu"];

export const iconCatalog: { label: string; items: { id: string; name: string }[] }[] = [
  { label: "Folder", items: [{ id: "folder", name: "Folder" }] },
  { label: "Documents", items: ["doc", "docx", "pdf"].map(named) },
  { label: "Text", items: text.map(named) },
  { label: "Images", items: images.map(named) },
  { label: "Spreadsheets", items: sheets.map(named) },
  { label: "Slides", items: ["ppt", "pptx", "pot", "potx", "pps", "ppsx"].map(named) },
  { label: "Video", items: video.map(named) },
  { label: "Audio", items: audio.map(named) },
  { label: "Archives", items: archives.map(named) },
  { label: "Code", items: code.map(named) },
  { label: "Programs", items: programs.map(named) },
];

const defaults: Record<string, string> = {
  folder: "#c99700",
  doc: "#2b6cb0",
  docx: "#2b6cb0",
  pdf: "#e23b2b",
  ppt: "#e07a1f",
  pptx: "#e07a1f",
  pot: "#e07a1f",
  potx: "#e07a1f",
  pps: "#e07a1f",
  ppsx: "#e07a1f",
};
for (const ext of images) defaults[ext] = "#3b82f6";
for (const ext of sheets) defaults[ext] = "#2f9e44";
for (const ext of text) defaults[ext] = "#64748b";
for (const ext of archives) defaults[ext] = "#b86b2a";
for (const ext of video) defaults[ext] = "#6d28d9";
for (const ext of audio) defaults[ext] = "#c026d3";
for (const ext of code) defaults[ext] = "#0f9b9b";
for (const ext of programs) defaults[ext] = "#c93c3c";

function named(id: string) {
  return { id, name: id };
}

export function defaultIconColor(id: string): string {
  return defaults[id.toLowerCase()] ?? "#8a8f98";
}

export function iconColor(isDir: boolean, extension: string, tints: Record<string, string>): string | undefined {
  const id = isDir ? "folder" : extension.toLowerCase();
  const custom = tints[id];
  if (custom && /^#[0-9a-fA-F]{6}$/.test(custom)) return custom;
  return defaults[id];
}

export function useIconColor(isDir: boolean, extension: string): string | undefined {
  const on = useApp((state) => state.iconColors);
  const tints = useApp((state) => state.iconTints);
  if (!on) return undefined;
  return iconColor(isDir, extension, tints);
}

export function FileIcon({ isDir, extension, up }: { isDir: boolean; extension: string; up?: boolean }) {
  const color = useIconColor(isDir || Boolean(up), extension);
  const style: CSSProperties | undefined = color ? { color } : undefined;
  if (up) return <FolderUp style={style} />;
  if (isDir) return <Folder style={style} />;
  if (images.includes(extension)) return <FileImage style={style} />;
  if (sheets.includes(extension)) return <FileSpreadsheet style={style} />;
  if (code.includes(extension)) return <FileCode style={style} />;
  if (archives.includes(extension)) return <FileArchive style={style} />;
  if (audio.includes(extension)) return <FileAudio style={style} />;
  if (video.includes(extension)) return <FileVideo style={style} />;
  if (["pdf", "doc", "docx", ...text].includes(extension)) return <FileText style={style} />;
  return <File style={style} />;
}
