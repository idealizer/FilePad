import DOMPurify from "dompurify";
import { FlipHorizontal, FlipVertical, RotateCcw, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { FileIcon } from "../lib/fileIcon";
import { formatBytes, typeLabel } from "../lib/format";
import { fileRows, treeRows } from "../lib/rows";
import { inTauri, invoke, message, openExternal } from "../lib/platform";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";
import type { DirListing, Entry, PreviewFile, Side } from "../types";

const imageMime: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
};

export function PreviewPane({ side }: { side: Side }) {
  const panels = useApp((state) => state.panels);
  const showHidden = useApp((state) => state.showHidden);
  const textpad = useApp((state) => state.textpad);
  const openInTextpad = useApp((state) => state.openInTextpad);
  const source = side === "left" ? "right" : "left";
  const sourcePanel = panels[source];
  const treeRow = sourcePanel.view === "tree" ? treeRows(sourcePanel, showHidden)[sourcePanel.cursor] : null;
  const row = sourcePanel.view === "tree" ? null : fileRows(sourcePanel, showHidden)[sourcePanel.cursor];
  const file = row && !row.up && !row.isDir ? row : null;
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      setError(null);
      return;
    }
    let cancel = false;
    setLoading(true);
    setError(null);
    void invoke<PreviewFile>("preview_file", { path: file.path })
      .then((next) => {
        if (!cancel) setPreview(next);
      })
      .catch((reason: unknown) => {
        if (!cancel) setError(message(reason));
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [file?.path, tick]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-2">
        <span className="min-w-0 flex-1 truncate">{file ? file.name : row?.name ?? "Preview"}</span>
        {file && <span className="text-xs text-[var(--muted)]">{formatBytes(file.size)}</span>}
        {file && <button className="btn sm" onClick={() => void openExternal(file.path).catch((reason: unknown) => toast("error", message(reason)))}>Open</button>}
        {file && textpad && (preview?.kind === "text" || preview?.kind === "csv") && (
          <button className="btn sm" onClick={() => void openInTextpad()}>TextPad</button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {treeRow && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--muted)]">
            <FileIcon isDir extension="" />
            <div>{treeRow.name}</div>
            <div className="text-xs">Folder</div>
          </div>
        )}
        {!treeRow && !row && <Empty text="Select a file in the other panel." />}
        {!treeRow && row?.up && <Empty text="Parent folder" />}
        {!treeRow && row?.isDir && !row.up && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[var(--muted)]">
            <FileIcon isDir extension="" />
            <div>{row.name}</div>
            <div className="text-xs">Folder</div>
          </div>
        )}
        {file && loading && <Empty text="Reading…" />}
        {file && error && <Empty text={error} />}
        {file && !loading && preview && <Body preview={preview} source={source} onSaved={() => setTick((value) => value + 1)} />}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-[var(--muted)]">{text}</div>;
}

function Body({ preview, source, onSaved }: { preview: PreviewFile; source: Side; onSaved: () => void }) {
  if (preview.kind === "image" && preview.dataBase64) return <ImageView key={preview.path} preview={preview} onSaved={onSaved} />;
  if (preview.kind === "audio" || preview.kind === "video") return <MediaView preview={preview} />;
  if (preview.kind === "zip") return <ZipView path={preview.path} source={source} />;
  if (preview.kind === "text" && preview.text !== null) {
    return <pre className="fp-pre">{preview.text}{preview.truncated ? "\n\n… preview stopped at 8 MB" : ""}</pre>;
  }
  if (preview.kind === "csv" && preview.text !== null) return <CsvTable text={preview.text} delimiter={preview.extension === "tsv" ? "\t" : ","} />;
  if (preview.kind === "pdf" && preview.dataBase64) return <PdfView data={preview.dataBase64} />;
  if (preview.kind === "docx" && preview.dataBase64) return <DocxView data={preview.dataBase64} />;
  if (preview.kind === "xlsx" && preview.dataBase64) return <XlsxView data={preview.dataBase64} />;
  if (preview.kind === "too-large") return <Empty text={`${preview.name} is ${formatBytes(preview.size)}. It is too large to preview.`} />;
  return <Empty text={`${preview.name} can't be previewed. Use Open to view it in another app.`} />;
}

function ImageView({ preview, onSaved }: { preview: PreviewFile; onSaved: () => void }) {
  const [quarters, setQuarters] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = quarters !== 0 || flipH || flipV;
  const svg = preview.extension === "svg";
  const mime = preview.mime || imageMime[preview.extension] || "image/jpeg";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="fp-tools">
        <button className="tb-btn" data-tip="Rotate left" onClick={() => setQuarters((value) => (value + 3) % 4)}><RotateCcw /></button>
        <button className="tb-btn" data-tip="Rotate right" onClick={() => setQuarters((value) => (value + 1) % 4)}><RotateCw /></button>
        <button className="tb-btn" data-tip="Mirror" onClick={() => setFlipH((value) => !value)}><FlipHorizontal /></button>
        <button className="tb-btn" data-tip="Flip" onClick={() => setFlipV((value) => !value)}><FlipVertical /></button>
        <button
          className="btn sm primary"
          disabled={!dirty || saving || svg}
          title={svg ? "SVG pictures stay as they are." : "Save the picture"}
          onClick={() => {
            setSaving(true);
            void invoke("save_image", { path: preview.path, quarters, flipH, flipV })
              .then(() => {
                toast("success", "Picture saved.");
                setQuarters(0);
                setFlipH(false);
                setFlipV(false);
                onSaved();
              })
              .catch((reason: unknown) => toast("error", message(reason)))
              .finally(() => setSaving(false));
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {preview.scaled && <span className="text-xs text-[var(--muted)]">Shown smaller. Save writes the full picture.</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="fp-stage">
          <img
            alt={preview.name}
            src={`data:${mime};base64,${preview.dataBase64}`}
            style={{ transform: `scaleY(${flipV ? -1 : 1}) scaleX(${flipH ? -1 : 1}) rotate(${quarters * 90}deg)` }}
          />
        </div>
      </div>
    </div>
  );
}

function MediaView({ preview }: { preview: PreviewFile }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl = "";
    let cancel = false;
    if (preview.dataBase64) {
      const type = preview.kind === "audio" ? audioMime[preview.extension] ?? "audio/mpeg" : videoMime[preview.extension] ?? "video/mp4";
      const copy = new Uint8Array(decodeBase64(preview.dataBase64));
      objectUrl = URL.createObjectURL(new Blob([copy.buffer], { type }));
      setUrl(objectUrl);
    } else if (inTauri()) {
      void import("@tauri-apps/api/core").then(({ convertFileSrc }) => {
        if (!cancel) setUrl(convertFileSrc(preview.path));
      });
    }
    return () => {
      cancel = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [preview.path, preview.dataBase64, preview.kind, preview.extension]);
  if (!url) return <Empty text="Reading…" />;
  return (
    <div className="fp-media">
      {preview.kind === "video"
        ? <video src={url} controls onError={() => setFailed(true)} />
        : <audio src={url} controls onError={() => setFailed(true)} />}
      {failed && <div className="text-center text-sm text-[var(--muted)]">This file won't play here. Use Open.</div>}
    </div>
  );
}

function ZipView({ path, source }: { path: string; source: Side }) {
  const navigate = useApp((state) => state.navigate);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = path.startsWith("zip:") ? path : `zip:${path}|`;
  useEffect(() => {
    let cancel = false;
    void invoke<DirListing>("list_dir", { path: target })
      .then((listing) => {
        if (!cancel) setEntries(listing.entries);
      })
      .catch((reason: unknown) => {
        if (!cancel) setError(message(reason));
      });
    return () => {
      cancel = true;
    };
  }, [target]);
  if (error) return <Empty text={error} />;
  if (!entries) return <Empty text="Reading…" />;
  const shown = [...entries].sort((left, right) => Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name)).slice(0, 500);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="fp-tools">
        <button className="btn sm" onClick={() => void navigate(source, target)}>Browse</button>
        <span className="text-xs text-[var(--muted)]">{entries.length} items inside the zip</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="fp-table">
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.path}>
                <td>{entry.name}</td>
                <td>{entry.isDir ? "" : formatBytes(entry.size)}</td>
                <td>{typeLabel(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries.length > shown.length && <div className="px-3 py-2 text-xs text-[var(--muted)]">Showing the first {shown.length} items. Browse to see the rest.</div>}
      </div>
    </div>
  );
}

const audioMime: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac" };
const videoMime: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mkv: "video/x-matroska" };

function CsvTable({ text, delimiter }: { text: string; delimiter: string }) {
  const rows = parseTable(text, delimiter);
  return <Table rows={rows} />;
}

function Table({ rows }: { rows: string[][] }) {
  const shown = rows.slice(0, 200);
  const width = Math.min(20, shown.reduce((max, row) => Math.max(max, row.length), 0));
  return (
    <div className="h-full overflow-auto">
      <table className="fp-table">
        <tbody>
          {shown.map((row, index) => (
            <tr key={index}>
              {Array.from({ length: width }, (_, cell) => <td key={cell}>{row[cell] ?? ""}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && <div className="px-3 py-2 text-xs text-[var(--muted)]">Showing the first {shown.length} rows.</div>}
    </div>
  );
}

function PdfView({ data }: { data: string }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const pdf = await pdfjs.getDocument({ data: decodeBase64(data) }).promise;
        const pages: string[] = [];
        const count = Math.min(pdf.numPages, 8);
        for (let number = 1; number <= count; number += 1) {
          const page = await pdf.getPage(number);
          const viewport = page.getViewport({ scale: 1.25 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext("2d");
          if (!context) continue;
          await page.render({ canvasContext: context, viewport }).promise;
          pages.push(canvas.toDataURL("image/png"));
        }
        if (!cancel) setUrls(pages);
      } catch (reason) {
        if (!cancel) setError(message(reason));
      }
    })();
    return () => {
      cancel = true;
    };
  }, [data]);
  if (error) return <Empty text={error} />;
  if (!urls.length) return <Empty text="Reading…" />;
  return <div className="flex flex-col items-center gap-3 p-3">{urls.map((url) => <img key={url} src={url} alt="" className="max-w-full shadow" />)}</div>;
}

function DocxView({ data }: { data: string }) {
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const mammoth = await import("mammoth");
        const bytes = decodeBase64(data);
        const copy = new Uint8Array(bytes);
        const result = await mammoth.convertToHtml({ arrayBuffer: copy.buffer });
        if (!cancel) setHtml(DOMPurify.sanitize(result.value));
      } catch (reason) {
        if (!cancel) setError(message(reason));
      }
    })();
    return () => {
      cancel = true;
    };
  }, [data]);
  if (error) return <Empty text={error} />;
  if (!html) return <Empty text="Reading…" />;
  return <div className="fp-doc" dangerouslySetInnerHTML={{ __html: html }} />;
}

function XlsxView({ data }: { data: string }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const XLSX = await import("xlsx");
        const book = XLSX.read(decodeBase64(data), { type: "array" });
        const sheet = book.Sheets[book.SheetNames[0]];
        const table = sheet ? XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false }) : [];
        if (!cancel) setRows(table.map((row) => row.map((cell) => String(cell ?? ""))));
      } catch (reason) {
        if (!cancel) setError(message(reason));
      }
    })();
    return () => {
      cancel = true;
    };
  }, [data]);
  if (error) return <Empty text={error} />;
  if (!rows) return <Empty text="Reading…" />;
  return <Table rows={rows} />;
}

function parseTable(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
