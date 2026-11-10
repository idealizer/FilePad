import { File, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, FolderUp } from "lucide-react";

export function FileIcon({ isDir, extension, up }: { isDir: boolean; extension: string; up?: boolean }) {
  if (up) return <FolderUp />;
  if (isDir) return <Folder />;
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(extension)) return <FileImage />;
  if (["xls", "xlsx", "csv", "tsv"].includes(extension)) return <FileSpreadsheet />;
  if (["js", "jsx", "ts", "tsx", "json", "rs", "py", "css", "html", "xml", "php"].includes(extension)) return <FileCode />;
  if (["zip", "gz", "7z", "rar"].includes(extension)) return <FileArchive />;
  if (["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus", "wma"].includes(extension)) return <FileAudio />;
  if (["mp4", "m4v", "webm", "mov", "mkv"].includes(extension)) return <FileVideo />;
  if (["pdf", "doc", "docx", "txt", "md", "markdown", "log"].includes(extension)) return <FileText />;
  return <File />;
}
