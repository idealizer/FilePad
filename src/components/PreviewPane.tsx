import DOMPurify from "dompurify";
import { AppWindow, Blend, Cast, ChevronLeft, ChevronRight, Circle, ClipboardCopy, Code, Contrast, Crop, FileText, FlipHorizontal, FlipVertical, FoldHorizontal, FolderOpen, FolderOutput, FolderSearch, Mail, PanelRight, PanelTop, Pause, Play, Plus, Printer, Replace, RotateCcw, RotateCw, Save, Share2, Square, SquareCheck, Table2, Volume2, VolumeX, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { baseName, formatBytes, formatWhen, isPackedPath, isRemotePath, typeLabel } from "../lib/format";
import { fileRows, markSet, treeRows } from "../lib/rows";
import { inTauri, invoke, message, openExternal } from "../lib/platform";
import { castPause, castResume, castSeek, setCastActive, watchCast } from "../lib/castSession";
import { CodeView } from "./CodeView";
import { FileName } from "./FileName";
import { Dropdown, MenuItem } from "./Menu";
import { takeListId, useApp } from "../stores/appStore";
import { jobFinish, jobStart, jobUpdate, toast } from "../stores/toastStore";
import type { DirListing, Entry, ListBatch, PreviewFile, Side, ThemeMode } from "../types";

type PreviewChrome = {
  beside: boolean;
  setBeside: (next: boolean) => void;
  setTools: Dispatch<SetStateAction<ReactNode>>;
};

const PreviewChromeContext = createContext<PreviewChrome>({
  beside: true,
  setBeside: () => {},
  setTools: () => {},
});

let toolsBeside = true;
const besideListeners = new Set<(value: boolean) => void>();

function useToolsBeside(): [boolean, (next: boolean) => void] {
  const [beside, setBeside] = useState(toolsBeside);
  useEffect(() => {
    const listen = (value: boolean) => setBeside(value);
    besideListeners.add(listen);
    setBeside(toolsBeside);
    return () => {
      besideListeners.delete(listen);
    };
  }, []);
  const set = useCallback((next: boolean) => {
    toolsBeside = next;
    besideListeners.forEach((listen) => listen(next));
  }, []);
  return [beside, set];
}

const imageMime: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
};

export function PreviewPane({ side }: { side: Side }) {
  const panels = useApp((state) => state.panels);
  const showHidden = useApp((state) => state.showHidden);
  const textpad = useApp((state) => state.textpad);
  const theme = useApp((state) => state.theme);
  const openInTextpad = useApp((state) => state.openInTextpad);
  const source = side === "left" ? "right" : "left";
  const sourcePanel = panels[source];
  const treeRow = sourcePanel.view === "tree" ? treeRows(sourcePanel, showHidden)[sourcePanel.cursor] : null;
  const row = sourcePanel.view === "tree" ? null : fileRows(sourcePanel, showHidden)[sourcePanel.cursor];
  const file = treeRow && !treeRow.isDir
    ? { key: treeRow.key, name: treeRow.name, path: treeRow.path, isDir: false, size: treeRow.size, modified: treeRow.modified, extension: treeRow.extension, up: false }
    : row && !row.up && !row.isDir ? row : null;
  const clickEntry = useApp((state) => state.clickEntry);
  const toggleMark = useApp((state) => state.toggleMark);
  const listed = sourcePanel.view === "tree" ? treeRows(sourcePanel, showHidden) : fileRows(sourcePanel, showHidden);
  const marked = file !== null && sourcePanel.view !== "tree" && markSet(sourcePanel.marked).has(file.path);
  const neighbors = neighborFiles(listed, sourcePanel.cursor);
  const stepFile = (index: number) => {
    if (index < 0) return;
    clickEntry(source, index);
  };
  const [trimming, setTrimming] = useState(false);
  const [beside, setBeside] = useToolsBeside();
  const [pictureTools, setPictureTools] = useState<ReactNode>(null);
  const chrome = useMemo(() => ({ beside, setBeside, setTools: setPictureTools }), [beside, setBeside]);
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [tableOn, setTableOn] = useState(true);
  const [pageOn, setPageOn] = useState(false);
  const [pageText, setPageText] = useState("");
  const htmlText = useRef<(() => string) | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const filePath = file?.path ?? "";
  const [tablePath, setTablePath] = useState(filePath);
  if (tablePath !== filePath) {
    setTablePath(filePath);
    setTableOn(true);
    setPageOn(false);
  }

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
        if (cancel || message(reason) === "cancelled") return;
        setError(message(reason));
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [file?.path, tick]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-2">
        {file || (treeRow && treeRow.path) || (row && !row.up) ? (
          <FileName
            key={file?.path ?? treeRow?.path ?? row?.path}
            className="min-w-0 flex-1 truncate"
            name={file?.name ?? treeRow?.name ?? row?.name ?? ""}
            path={file?.path ?? treeRow?.path ?? row?.path ?? ""}
            isDir={file ? false : Boolean(treeRow?.isDir ?? row?.isDir)}
            selected
            activate="click"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{row?.up ? "Parent folder of the other panel" : "Preview"}</span>
        )}
        {file && <span className="text-xs text-[var(--muted)]">{formatBytes(file.size)}</span>}
        {(preview?.extension === "html" || preview?.extension === "htm") && preview.kind === "text" && (
          <div className="seg" role="tablist" aria-label="HTML view">
            <button data-active={!pageOn} data-tip="Code" onClick={() => setPageOn(false)}><Code />Code</button>
            <button data-active={pageOn} data-tip="HTML" onClick={() => { setPageText(htmlText.current?.() ?? preview.text ?? ""); setPageOn(true); }}><AppWindow />HTML</button>
          </div>
        )}
        {preview?.kind === "csv" && (
          <div className="seg" role="tablist" aria-label="CSV view">
            <button data-active={!tableOn} data-tip="Text" onClick={() => setTableOn(false)}><FileText />Text</button>
            <button data-active={tableOn} data-tip="Table" onClick={() => setTableOn(true)}><Table2 />Table</button>
          </div>
        )}
        {file && <PreviewActions path={file.path} extension={file.extension} />}
        {file && preview && preview.path === file.path && (preview.kind === "audio" || (preview.kind === "video" && preview.extension !== "vob")) && (
          <CastButton
            path={file.path}
            kind={preview.kind === "audio" ? "audio" : "video"}
            disabled={isPackedPath(file.path) || isRemotePath(file.path)}
            onStart={() => {
              bodyRef.current?.querySelectorAll("video, audio").forEach((node) => {
                if (!(node instanceof HTMLMediaElement)) return;
                node.muted = true;
                try { node.currentTime = 0; } catch { /* the file is still opening */ }
                void node.play().catch(() => {});
              });
            }}
            onStop={() => {
              bodyRef.current?.querySelectorAll("video, audio").forEach((node) => {
                if (node instanceof HTMLMediaElement) node.pause();
              });
            }}
          />
        )}
        {file && <button className="tb-btn" data-tip="Open" onClick={() => void openExternal(file.path).catch((reason: unknown) => toast("error", message(reason)))}><FolderOpen /></button>}
        {file && textpad && (preview?.kind === "text" || preview?.kind === "csv") && (
          <button className="btn sm" onClick={() => void openInTextpad()}>TextPad</button>
        )}
      </div>
      <PreviewChromeContext.Provider value={chrome}>
      <div ref={bodyRef} className="relative min-h-0 min-w-0 flex-1">
        <div className={`h-full min-h-0 min-w-0 ${preview?.kind === "slides" || preview?.kind === "video" ? "overflow-hidden" : "overflow-auto"}`}>
          {treeRow?.isDir && <ListingView listPath={treeRow.path} source={source} />}
          {!treeRow && !row && <Empty text="Select a file in the other panel." />}
          {!treeRow && row?.up && <Empty text="The other panel is on its parent folder." />}
          {!treeRow && row?.isDir && !row.up && <ListingView listPath={row.path} source={source} />}
          {file && loading && <Empty text="Reading…" />}
          {file && error && <Empty text={error} />}
          {file && !loading && preview && <Body preview={preview} source={source} theme={theme} tableOn={tableOn} pageOn={pageOn} pageText={pageText} htmlText={htmlText} onTrim={setTrimming} onSaved={() => setTick((value) => value + 1)} />}
        </div>
        {file && !trimming && (
          <>
            <button type="button" className="fp-step" data-side="prev" aria-label="Previous file" disabled={neighbors.prev < 0} onClick={() => stepFile(neighbors.prev)}><ChevronLeft /></button>
            <button type="button" className="fp-step" data-side="next" aria-label="Next file" disabled={neighbors.next < 0} onClick={() => stepFile(neighbors.next)}><ChevronRight /></button>
            {beside && pictureTools && <ToolRail>{pictureTools}</ToolRail>}
            {sourcePanel.view !== "tree" && (
              <button type="button" className="fp-pick" data-on={marked ? "true" : undefined} data-tip={marked ? "Selected" : "Select file"} aria-pressed={marked} onClick={() => toggleMark(source, sourcePanel.cursor, false)}>
                {marked ? <SquareCheck /> : <Square />}
              </button>
            )}
          </>
        )}
      </div>
      </PreviewChromeContext.Provider>
    </div>
  );
}

function PreviewActions({ path, extension }: { path: string; extension: string }) {
  const kind = mediaKind(extension);
  const run = (command: string, extra?: Record<string, string>) => {
    void invoke<string>(command, { path, ...extra })
      .then((note) => { if (note) toast("success", note); })
      .catch((reason: unknown) => toast("error", message(reason)));
  };
  return (
    <>
      <button className="tb-btn" data-tip="Copy" title="Copy the file so you can paste it into Mail, a chat, or another folder" onClick={() => run("copy_to_clipboard")}><ClipboardCopy /></button>
      <button className="tb-btn" data-tip="Email" onClick={() => run("email_file")}><Mail /></button>
      <button className="tb-btn" data-tip="WhatsApp" title="Send to one person" onClick={() => run("share_file", { target: "whatsapp" })}><WhatsAppIcon /></button>
      <button className="tb-btn" data-tip="Print" onClick={() => run("print_file")}><Printer /></button>
      {kind && (
        <Dropdown
          align="end"
          button={({ open, toggle }) => (
            <button className="tb-btn" data-active={open} data-tip="Post" title="Pictures and videos only. Other people can see a post." onClick={toggle}><Share2 /></button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<InstagramIcon />} label="Instagram" onClick={() => { close(); run("share_file", { target: "instagram" }); }} />
              <MenuItem icon={<XIcon />} label="X" onClick={() => { close(); run("share_file", { target: "x" }); }} />
              <MenuItem icon={<FacebookIcon />} label="Facebook" onClick={() => { close(); run("share_file", { target: "facebook" }); }} />
              <MenuItem icon={<LinkedInIcon />} label="LinkedIn" onClick={() => { close(); run("share_file", { target: "linkedin" }); }} />
              <MenuItem icon={<TikTokIcon />} label="TikTok" onClick={() => { close(); run("share_file", { target: "tiktok" }); }} />
              {kind === "video" && <MenuItem icon={<YouTubeIcon />} label="YouTube" onClick={() => { close(); run("share_file", { target: "youtube" }); }} />}
            </>
          )}
        </Dropdown>
      )}
    </>
  );
}

function mediaKind(extension: string): "image" | "video" | "" {
  const ext = extension.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "ico", "svg", "heic", "heif"].includes(ext)) return "image";
  if (["mp4", "m4v", "webm", "ogv", "mov", "mkv"].includes(ext)) return "video";
  return "";
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-[var(--muted)]">{text}</div>;
}

function Body({ preview, source, theme, tableOn, pageOn, pageText, htmlText, onTrim, onSaved }: { preview: PreviewFile; source: Side; theme: ThemeMode; tableOn: boolean; pageOn: boolean; pageText: string; htmlText: { current: (() => string) | null }; onTrim: (active: boolean) => void; onSaved: () => void }) {
  if (preview.kind === "image" && preview.dataBase64) return <ImageView key={preview.path} preview={preview} source={source} onTrim={onTrim} onSaved={onSaved} />;
  if (preview.kind === "video" && preview.extension !== "vob") return <VideoView key={preview.path} preview={preview} source={source} onTrim={onTrim} />;
  if (preview.kind === "audio" || preview.kind === "video") return <MediaView preview={preview} />;
  if (preview.kind === "zip") return <ZipView path={preview.path} source={source} />;
  if (preview.kind === "gz") return <GzView path={preview.path} source={source} />;
  if (preview.kind === "slides" && preview.text !== null) return <SlideView key={preview.path} path={preview.path} text={preview.text} />;
  if (preview.kind === "document" && preview.text !== null) return <DocumentView text={preview.text} />;
  if (preview.kind === "text" && preview.text !== null) {
    const html = preview.extension === "html" || preview.extension === "htm";
    if (!html) return <CodeView key={preview.path} text={preview.text} path={preview.path} source={source} extension={preview.extension} truncated={preview.truncated} theme={theme} />;
    return (
      <div className="relative h-full min-h-0">
        <div className={pageOn ? "invisible absolute inset-0" : "h-full min-h-0"} aria-hidden={pageOn}>
          <CodeView key={preview.path} text={preview.text} path={preview.path} source={source} extension={preview.extension} truncated={preview.truncated} theme={theme} liveRef={htmlText} />
        </div>
        {pageOn && <HtmlView text={pageText || preview.text} path={preview.path} truncated={preview.truncated} />}
      </div>
    );
  }
  if (preview.kind === "csv" && preview.text !== null) {
    if (!tableOn) return <CodeView key={preview.path} text={preview.text} path={preview.path} source={source} extension={preview.extension} truncated={preview.truncated} theme={theme} />;
    return <CsvTable text={preview.text} delimiter={preview.extension === "tsv" ? "\t" : ","} truncated={preview.truncated} />;
  }
  if (preview.kind === "pdf" && (preview.dataBase64 || !isPackedPath(preview.path))) return <PdfView data={preview.dataBase64} path={preview.path} />;
  if (preview.kind === "docx" && preview.dataBase64) return <DocxView data={preview.dataBase64} />;
  if (preview.kind === "xlsx" && preview.dataBase64) return <XlsxView data={preview.dataBase64} />;
  if (preview.kind === "too-large") return <Empty text={`${preview.name} is ${formatBytes(preview.size)}. It is too large to preview.`} />;
  return <Empty text={`${preview.name} can't be previewed. Use Open to view it in another app.`} />;
}

function neighborFiles(rows: { isDir: boolean; up?: boolean }[], cursor: number) {
  const indexes: number[] = [];
  rows.forEach((row, index) => {
    if (row.up || row.isDir) return;
    indexes.push(index);
  });
  const at = indexes.indexOf(cursor);
  if (at >= 0) return { prev: at > 0 ? indexes[at - 1] : -1, next: at < indexes.length - 1 ? indexes[at + 1] : -1 };
  let prev = -1;
  let next = -1;
  for (const index of indexes) {
    if (index < cursor) prev = index;
    else { next = index; break; }
  }
  return { prev, next };
}

function clampOrigin(ox: number, oy: number, viewW: number, viewH: number, imgW: number, imgH: number) {
  const minX = viewW >= imgW ? imgW - viewW : 0;
  const maxX = viewW >= imgW ? 0 : imgW - viewW;
  const minY = viewH >= imgH ? imgH - viewH : 0;
  const maxY = viewH >= imgH ? 0 : imgH - viewH;
  return {
    x: Math.min(Math.max(ox, minX), maxX),
    y: Math.min(Math.max(oy, minY), maxY),
  };
}

type TrimEdge = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

type Tone = "color" | "bw" | "sepia";
type BlurShape = "square" | "oval";
type BlurFill = "blur" | "black";
type BlurSpot = { id: number; shape: BlurShape; fill: BlurFill; x: number; y: number; w: number; h: number };

const BLUR_MIN = 2;
const BLUR_MAX = 48;
const BLUR_DEFAULT = 16;

function nextTone(tone: Tone): Tone {
  if (tone === "color") return "bw";
  if (tone === "bw") return "sepia";
  return "color";
}

function toneTip(tone: Tone): string {
  if (tone === "color") return "Black and white";
  if (tone === "bw") return "Sepia";
  return "Color";
}

function toneFilter(tone: Tone): string | undefined {
  if (tone === "bw") return "grayscale(1)";
  if (tone === "sepia") return "sepia(1)";
  return undefined;
}

function formatLabel(format: string): string {
  if (format === "jpg") return "JPG";
  if (format === "png") return "PNG";
  if (format === "webp") return "WebP";
  if (format === "bmp") return "BMP";
  if (format === "avif") return "AVIF";
  return "GIF";
}

function blurMask(spots: BlurSpot[], width: number, height: number, feather: number): string {
  const soft = Math.max(1, feather).toFixed(1);
  const shapes = spots.map((spot) => {
    if (spot.shape === "oval") {
      const cx = (spot.x + spot.w / 2).toFixed(2);
      const cy = (spot.y + spot.h / 2).toFixed(2);
      const rx = (spot.w / 2).toFixed(2);
      const ry = (spot.h / 2).toFixed(2);
      return `<ellipse cx='${cx}' cy='${cy}' rx='${rx}' ry='${ry}' fill='white'/>`;
    }
    return `<rect x='${spot.x.toFixed(2)}' y='${spot.y.toFixed(2)}' width='${spot.w.toFixed(2)}' height='${spot.h.toFixed(2)}' fill='white'/>`;
  }).join("");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}' preserveAspectRatio='none'><defs><filter id='s' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='${soft}'/></filter></defs><g filter='url(#s)'>${shapes}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

function stillFormat(extension: string): string {
  const ext = extension.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext === "png" || ext === "webp" || ext === "bmp" || ext === "gif" || ext === "avif") return ext;
  return "jpg";
}

function PictureActions({
  dirty,
  saving,
  svg,
  zipped,
  canEdit,
  tone,
  tool,
  onRotateLeft,
  onRotateRight,
  onMirror,
  onFlip,
  onTone,
  onSave,
  onTool,
}: {
  dirty: boolean;
  saving: boolean;
  svg: boolean;
  zipped: boolean;
  canEdit: boolean;
  tone: Tone;
  tool: "" | "convert" | "trim" | "blur";
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onMirror: () => void;
  onFlip: () => void;
  onTone: () => void;
  onSave: () => void;
  onTool: (next: "convert" | "trim" | "blur") => void;
}) {
  const blocked = svg ? "SVG pictures stay as they are." : zipped ? "Copy the picture out of the archive before saving a change." : "";
  return (
    <>
      <button className="tb-btn" data-tip="Rotate left" onClick={onRotateLeft}><RotateCcw /></button>
      <button className="tb-btn" data-tip="Rotate right" onClick={onRotateRight}><RotateCw /></button>
      <button className="tb-btn" data-tip="Mirror" onClick={onMirror}><FlipHorizontal /></button>
      <button className="tb-btn" data-tip="Flip" onClick={onFlip}><FlipVertical /></button>
      <button className="tb-btn" data-active={tool === "trim"} disabled={!canEdit} data-tip={blocked || (canEdit ? "Trim" : "Can't read this picture's size.")} onClick={() => onTool("trim")}><Crop /></button>
      <button className="tb-btn" data-tone={tone === "color" ? undefined : tone} disabled={!canEdit} data-tip={blocked || (canEdit ? toneTip(tone) : "Can't read this picture's size.")} onClick={onTone}><Contrast /></button>
      <button className="tb-btn" data-active={tool === "blur"} disabled={!canEdit} data-tip={blocked || (canEdit ? "Blur" : "Can't read this picture's size.")} onClick={() => onTool("blur")}><Blend /></button>
      <button className="tb-btn" data-active={tool === "convert"} disabled={!canEdit} data-tip={blocked || (canEdit ? "Convert" : "Can't read this picture's size.")} onClick={() => onTool("convert")}><Replace /></button>
      <button
        className="tb-btn"
        disabled={!dirty || saving || svg || zipped}
        data-tip={blocked || (saving ? "Saving…" : "Save the picture")}
        style={saving || (dirty && !svg && !zipped) ? { color: "var(--accent)" } : undefined}
        onClick={onSave}
      >
        {saving ? <span className="fp-spin" /> : <Save />}
      </button>
    </>
  );
}

function BlurMarks({
  spots,
  boxW,
  boxH,
  orientedW,
  orientedH,
  tone,
  turned,
  flipH,
  flipV,
  quarters,
  src,
  strength,
  interactive,
  onRemove,
}: {
  spots: BlurSpot[];
  boxW: number;
  boxH: number;
  orientedW: number;
  orientedH: number;
  tone: Tone;
  turned: boolean;
  flipH: boolean;
  flipV: boolean;
  quarters: number;
  src: string;
  strength: number;
  interactive: boolean;
  onRemove: (id: number) => void;
}) {
  if (!boxW || !boxH || !orientedW || !orientedH || spots.length === 0) return null;
  const veils = spots.filter((spot) => spot.fill !== "black");
  const feather = Math.max(1, strength * 0.25);
  const mask = veils.length > 0 ? blurMask(veils, orientedW, orientedH, feather) : "";
  const blurPx = Math.max(1, (strength * boxW) / orientedW);
  const toneCss = toneFilter(tone);
  const filter = toneCss ? `${toneCss} blur(${blurPx}px)` : `blur(${blurPx}px)`;
  const sx = boxW / orientedW;
  const sy = boxH / orientedH;
  const remove = (id: number) => (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onRemove(id);
  };
  return (
    <>
      {veils.length > 0 && (
        <div className="fp-blur-layer" style={{ maskImage: mask, WebkitMaskImage: mask, maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskSize: "100% 100%", WebkitMaskSize: "100% 100%" }}>
          <img
            alt=""
            draggable={false}
            src={src}
            style={{
              width: turned ? boxH : boxW,
              height: turned ? boxW : boxH,
              filter,
              transform: `translate(-50%, -50%) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1}) rotate(${quarters * 90}deg)`,
            }}
          />
        </div>
      )}
      {spots.filter((spot) => spot.fill === "black" || interactive).map((spot) => (
        <div
          key={spot.id}
          className={spot.fill === "black" ? "fp-censor" : "fp-blur-hit"}
          data-shape={spot.shape}
          data-draft={spot.id < 0 ? "true" : undefined}
          style={{ left: spot.x * sx, top: spot.y * sy, width: Math.max(1, spot.w * sx), height: Math.max(1, spot.h * sy) }}
          onPointerDown={interactive && spot.id >= 0 ? remove(spot.id) : undefined}
        />
      ))}
    </>
  );
}

function ToolRail({ children }: { children: ReactNode }) {
  const tipRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ text: string; x: number; y: number; w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const node = tipRef.current;
    if (!node || !tip) return;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    let left = tip.x - width - 8;
    let top = tip.y + tip.h / 2 - height / 2;
    if (left < 8) left = Math.min(window.innerWidth - width - 8, tip.x + tip.w + 8);
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
    node.dataset.ready = "true";
  }, [tip]);
  return (
    <div
      className="fp-rail"
      onMouseOver={(event) => {
        const target = (event.target as Element | null)?.closest?.("[data-tip]");
        if (!target || !event.currentTarget.contains(target)) return;
        const text = target.getAttribute("data-tip");
        if (!text || target.getAttribute("data-active") === "true") {
          setTip(null);
          return;
        }
        const box = target.getBoundingClientRect();
        setTip((current) => current && current.text === text && current.x === box.left && current.y === box.top ? current : { text, x: box.left, y: box.top, w: box.width, h: box.height });
      }}
      onMouseLeave={() => setTip(null)}
    >
      {children}
      {tip && createPortal(<div ref={tipRef} className="fp-rail-tip">{tip.text}</div>, document.body)}
    </div>
  );
}

type CastScreen = { id: string; name: string; audio: boolean; video: boolean };

function CastButton({ path, kind, disabled, onStart, onStop }: { path: string; kind: "audio" | "video"; disabled: boolean; onStart: () => void; onStop: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; right: number } | null>(null);
  const [screens, setScreens] = useState<CastScreen[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [casting, setCasting] = useState<string | null>(null);
  useEffect(() => () => {
    setCastActive(false);
    void invoke("cast_stop").catch(() => {});
  }, [path]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const lookId = useRef(0);
  const look = () => {
    const id = lookId.current + 1;
    lookId.current = id;
    setLooking(true);
    setScreens(null);
    void invoke<CastScreen[]>("cast_screens")
      .then((list) => {
        if (lookId.current === id) setScreens(list);
      })
      .catch((reason: unknown) => {
        if (lookId.current !== id) return;
        toast("error", message(reason));
        setScreens([]);
      })
      .finally(() => {
        if (lookId.current === id) setLooking(false);
      });
  };
  const playOn = (screen: CastScreen) => {
    setOpen(false);
    void invoke("cast_play", { path, screen: screen.id })
      .then(() => {
        setCasting(screen.name);
        setCastActive(true);
        onStart();
        toast("success", `Playing on ${screen.name}. Pause and the bar control it.`);
      })
      .catch((reason: unknown) => toast("error", message(reason)));
  };
  const ready = screens ?? [];
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="tb-btn"
        disabled={disabled}
        data-active={casting ? "true" : undefined}
        data-tip={disabled ? "This file has to be on this computer." : casting ? `Playing on ${casting}. Pause and the bar control it.` : "Cast to devices"}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          const rect = buttonRef.current?.getBoundingClientRect();
          if (rect) setBox({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) });
          setOpen(true);
          look();
        }}
      >
        <Cast />
      </button>
      {open && box && createPortal(
        <div className="menu" style={{ position: "fixed", top: box.top, right: box.right, left: "auto", zIndex: 80 }} onMouseDown={(event) => event.stopPropagation()}>
          {casting && (
            <MenuItem label={`Stop on ${casting}`} onClick={() => {
              setOpen(false);
              void invoke("cast_stop")
                .then(() => {
                  setCasting(null);
                  setCastActive(false);
                  onStop();
                  toast("success", "Stopped.");
                })
                .catch((reason: unknown) => toast("error", message(reason)));
            }} />
          )}
          {looking && <MenuItem label="Looking for devices…" disabled onClick={() => {}} />}
          {ready.map((screen) => {
            const canPlay = kind === "audio" ? screen.audio : screen.video;
            return (
              <MenuItem key={screen.id} icon={<Cast />} label={screen.name} hint={canPlay ? undefined : "Audio"} disabled={!canPlay} onClick={() => { if (canPlay) playOn(screen); }} />
            );
          })}
          {screens && ready.length === 0 && !looking && <MenuItem label="No devices on this network" disabled onClick={() => {}} />}
        </div>,
        document.body,
      )}
    </>
  );
}

function ToolsPlaceButton() {
  const { beside, setBeside } = useContext(PreviewChromeContext);
  return (
    <button type="button" className="tb-btn" data-tip={beside ? "Tools in the bar" : "Tools beside the arrows"} onClick={() => setBeside(!beside)}>
      {beside ? <PanelTop /> : <PanelRight />}
    </button>
  );
}

function ImageView({ preview, source, onTrim, onSaved }: { preview: PreviewFile; source: Side; onTrim: (active: boolean) => void; onSaved: () => void }) {
  const [quarters, setQuarters] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [tone, setTone] = useState<Tone>("color");
  const [spots, setSpots] = useState<BlurSpot[]>([]);
  const [draft, setDraft] = useState<BlurSpot | null>(null);
  const [blurShape, setBlurShape] = useState<BlurShape>("square");
  const [blurFill, setBlurFill] = useState<BlurFill>("blur");
  const [blurStrength, setBlurStrength] = useState(BLUR_DEFAULT);
  const [saving, setSaving] = useState(false);
  const [tool, setTool] = useState<"" | "convert" | "trim" | "blur">("");
  const [ratio, setRatio] = useState<VideoPreset>("original");
  const [widthText, setWidthText] = useState("");
  const [heightText, setHeightText] = useState("");
  const [outW, setOutW] = useState(0);
  const [outH, setOutH] = useState(0);
  const [scale, setScale] = useState(1);
  const [originX, setOriginX] = useState(0);
  const [originY, setOriginY] = useState(0);
  const [format, setFormat] = useState(stillFormat(preview.extension));
  const [quality, setQuality] = useState(85);
  const [background, setBackground] = useState<"white" | "black">("white");
  const [notice, setNotice] = useState("");
  const [savingTrim, setSavingTrim] = useState(false);
  const [applied, setApplied] = useState(false);
  const trimGeom = useRef({ x: 0, y: 0, w: 0, h: 0, sps: 1 });
  const [viewZoom, setViewZoom] = useState(1);
  const [pixels, setPixels] = useState({ w: preview.width, h: preview.height });
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(viewZoom);
  const scrollAnchor = useRef<{ left: number; top: number } | "center" | null>(null);
  zoomRef.current = viewZoom;
  const cropRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);
  const focused = useRef(false);
  const blurIds = useRef(0);
  const dirty = quarters !== 0 || flipH || flipV || tone !== "color" || spots.length > 0;
  const marks = draft && draft.w > 0 && draft.h > 0 ? [...spots, draft] : spots;
  const pictureEdits = {
    quarters,
    flipH,
    flipV,
    tone,
    spots: spots.map(({ shape, fill, x, y, w, h }) => ({ shape, mode: fill, x, y, w, h })),
    strength: blurStrength,
  };
  const svg = preview.extension === "svg";
  const zipped = isPackedPath(preview.path);
  const mime = preview.mime || imageMime[preview.extension] || "image/jpeg";
  const turned = quarters % 2 === 1;
  const pixelW = pixels.w || preview.width;
  const pixelH = pixels.h || preview.height;
  const fullW = preview.scaled && preview.width > 0 ? preview.width : pixelW;
  const fullH = preview.scaled && preview.height > 0 ? preview.height : pixelH;
  const orientedW = turned ? fullH : fullW;
  const orientedH = turned ? fullW : fullH;
  const canEdit = !svg && !zipped && orientedW > 0 && orientedH > 0;
  const { beside, setTools } = useContext(PreviewChromeContext);
  const saveTurn = () => {
    const job = jobStart("Saving picture…");
    setSaving(true);
    void invoke<string>("save_image", { path: preview.path, ...pictureEdits })
      .then((saved) => {
        jobFinish(job, "success", `Saved ${baseName(saved)}.`);
        setQuarters(0);
        setFlipH(false);
        setFlipV(false);
        setTone("color");
        setSpots([]);
        setDraft(null);
        onSaved();
      })
      .catch((reason: unknown) => jobFinish(job, "error", message(reason)))
      .finally(() => setSaving(false));
  };
  const saveTurnRef = useRef(saveTurn);
  saveTurnRef.current = saveTurn;
  useLayoutEffect(() => {
    if (!beside || tool === "trim" || tool === "blur") {
      setTools(null);
      return () => setTools(null);
    }
    setTools(
      <div className="fp-rail-tools">
        <PictureActions
          dirty={dirty}
          saving={saving}
          svg={svg}
          zipped={zipped}
          canEdit={canEdit}
          tone={tone}
          tool={tool}
          onRotateLeft={() => setQuarters((value) => (value + 3) % 4)}
          onRotateRight={() => setQuarters((value) => (value + 1) % 4)}
          onMirror={() => setFlipH((value) => !value)}
          onFlip={() => setFlipV((value) => !value)}
          onTone={() => setTone(nextTone)}
          onSave={() => saveTurnRef.current()}
          onTool={(next) => setTool((value) => (value === next ? "" : next))}
        />
      </div>,
    );
    return () => setTools(null);
  }, [beside, canEdit, dirty, saving, setTools, svg, tone, tool, zipped]);
  const viewW = outW > 0 && scale > 0 ? outW / scale : 0;
  const viewH = outH > 0 && scale > 0 ? outH / scale : 0;
  const zoom = Math.round(scale * 100);
  const view = useRef({ scale, originX, originY, outW, outH });
  view.current = { scale, originX, originY, outW, outH };

  useEffect(() => {
    if (seeded.current || !orientedW || !orientedH) return;
    seeded.current = true;
    setWidthText(String(orientedW));
    setHeightText(String(orientedH));
    setOutW(orientedW);
    setOutH(orientedH);
    setScale(1);
    setOriginX(0);
    setOriginY(0);
  }, [orientedW, orientedH]);

  useEffect(() => {
    onTrim(tool === "trim");
    return () => onTrim(false);
  }, [tool, onTrim]);

  const [seenPicture, setSeenPicture] = useState(preview.dataBase64);
  if (seenPicture !== preview.dataBase64) {
    setSeenPicture(preview.dataBase64);
    setTool("");
    setRatio("original");
    setApplied(false);
    setTone("color");
    setSpots([]);
    setDraft(null);
  }

  useEffect(() => {
    if (!seeded.current || !outW || !outH || !orientedW || !orientedH) return;
    const min = Math.min(1, outW / orientedW, outH / orientedH);
    const nextScale = Math.min(8, Math.max(min, scale));
    const nextViewW = outW / nextScale;
    const nextViewH = outH / nextScale;
    const next = clampOrigin(originX, originY, nextViewW, nextViewH, orientedW, orientedH);
    if (Math.abs(nextScale - scale) > 1e-6) setScale(nextScale);
    if (Math.abs(next.x - originX) > 1e-3) setOriginX(next.x);
    if (Math.abs(next.y - originY) > 1e-3) setOriginY(next.y);
  }, [orientedW, orientedH, outW, outH, scale, originX, originY]);

  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setFrame((prev) => (prev.w === node.clientWidth && prev.h === node.clientHeight ? prev : { w: node.clientWidth, h: node.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const availW = Math.max(1, frame.w - 24);
  const availH = Math.max(1, frame.h - 24);
  let fitW = availW;
  let fitH = orientedW > 0 && orientedH > 0 ? availW * (orientedH / orientedW) : availH;
  if (orientedW > 0 && orientedH > 0 && fitH > availH) {
    fitH = availH;
    fitW = availH * (orientedW / orientedH);
  }
  const displayW = Math.max(1, Math.round(fitW * viewZoom));
  const displayH = Math.max(1, Math.round(fitH * viewZoom));

  useLayoutEffect(() => {
    if (tool === "trim") return;
    const node = stageRef.current;
    const anchor = scrollAnchor.current;
    if (!node || !anchor) return;
    scrollAnchor.current = null;
    if (anchor === "center") {
      node.scrollLeft = Math.max(0, (node.scrollWidth - node.clientWidth) / 2);
      node.scrollTop = Math.max(0, (node.scrollHeight - node.clientHeight) / 2);
      return;
    }
    node.scrollLeft = anchor.left;
    node.scrollTop = anchor.top;
  }, [tool, viewZoom, displayW, displayH]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node || tool === "trim") return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const current = zoomRef.current;
      const next = Math.min(8, Math.max(1, current * Math.exp(-event.deltaY * 0.0015)));
      if (Math.abs(next - current) < 1e-4) return;
      const rect = node.getBoundingClientRect();
      const px = event.clientX - rect.left + node.scrollLeft;
      const py = event.clientY - rect.top + node.scrollTop;
      const ratio = next / current;
      scrollAnchor.current = { left: px * ratio - (event.clientX - rect.left), top: py * ratio - (event.clientY - rect.top) };
      setViewZoom(next);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [tool]);

  useEffect(() => {
    if (tool !== "trim") {
      focused.current = false;
      return;
    }
    if (focused.current || !cropRef.current) return;
    cropRef.current.focus();
    focused.current = true;
  }, [tool, outW, outH, frame.w]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node || tool !== "trim") return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const geo = trimGeom.current;
      const bounds = node.getBoundingClientRect();
      if (!geo.w || !geo.sps || !orientedW || !orientedH) return;
      const current = view.current;
      if (!current.outW || !current.outH || !current.scale) return;
      const min = Math.min(1, current.outW / orientedW, current.outH / orientedH);
      const nextScale = Math.min(8, Math.max(min, current.scale * Math.exp(-event.deltaY * 0.0015)));
      const srcX = (event.clientX - bounds.left - geo.x) / geo.sps;
      const srcY = (event.clientY - bounds.top - geo.y) / geo.sps;
      const currentViewW = current.outW / current.scale;
      const currentViewH = current.outH / current.scale;
      if (!currentViewW || !currentViewH) return;
      const nextViewW = current.outW / nextScale;
      const nextViewH = current.outH / nextScale;
      const next = clampOrigin(
        srcX - (nextViewW / currentViewW) * (srcX - current.originX),
        srcY - (nextViewH / currentViewH) * (srcY - current.originY),
        nextViewW,
        nextViewH,
        orientedW,
        orientedH,
      );
      setScale(nextScale);
      setOriginX(next.x);
      setOriginY(next.y);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [tool, orientedW, orientedH]);

  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;

  const applyFrame = (width: number, height: number) => {
    const w = Math.min(Math.max(Math.round(width), 1), 16000);
    const h = Math.min(Math.max(Math.round(height), 1), 16000);
    const min = Math.min(1, w / orientedW, h / orientedH);
    const nextScale = Math.min(8, Math.max(min, scale));
    const nextViewW = w / nextScale;
    const nextViewH = h / nextScale;
    const nextOrigin = clampOrigin(originX + viewW / 2 - nextViewW / 2, originY + viewH / 2 - nextViewH / 2, nextViewW, nextViewH, orientedW, orientedH);
    setOutW(w);
    setOutH(h);
    setScale(nextScale);
    setOriginX(nextOrigin.x);
    setOriginY(nextOrigin.y);
    setWidthText(String(w));
    setHeightText(String(h));
    setNotice(width > 16000 || height > 16000 ? "That trim is too large, so it was reduced." : "");
  };

  const fitRatio = (next: VideoPreset) => {
    setRatio(next);
    if (next === "original" || orientedW < 1 || orientedH < 1) return;
    const target = presetRatio[next];
    let w = orientedW;
    let h = w / target;
    if (h > orientedH) {
      h = orientedH;
      w = h * target;
    }
    const cx = originX + (viewW || orientedW) / 2;
    const cy = originY + (viewH || orientedH) / 2;
    const nextW = Math.max(1, Math.round(w));
    const nextH = Math.max(1, Math.round(h));
    const nextOrigin = clampOrigin(cx - nextW / 2, cy - nextH / 2, nextW, nextH, orientedW, orientedH);
    setScale(1);
    setOutW(nextW);
    setOutH(nextH);
    setWidthText(String(nextW));
    setHeightText(String(nextH));
    setOriginX(nextOrigin.x);
    setOriginY(nextOrigin.y);
    setNotice("");
  };

  const applySize = (axis: "x" | "y", next: number) => {
    const capped = Math.min(Math.max(Math.round(next), 1), 16000);
    const width = axis === "x" ? capped : outW || orientedW;
    const height = axis === "y" ? capped : outH || orientedH;
    const min = Math.min(1, width / orientedW, height / orientedH);
    const nextScale = Math.min(8, Math.max(min, scale));
    const nextViewW = width / nextScale;
    const nextViewH = height / nextScale;
    const cx = originX + viewW / 2;
    const cy = originY + viewH / 2;
    const nextOrigin = clampOrigin(cx - nextViewW / 2, cy - nextViewH / 2, nextViewW, nextViewH, orientedW, orientedH);
    setOutW(width);
    setOutH(height);
    setScale(nextScale);
    setOriginX(nextOrigin.x);
    setOriginY(nextOrigin.y);
    setWidthText(String(width));
    setHeightText(String(height));
    setNotice(next > 16000 ? "That trim is too large, so it was reduced." : "");
  };

  const typeSize = (axis: "x" | "y", raw: string) => {
    if (axis === "x") setWidthText(raw);
    else setHeightText(raw);
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return;
    if (ratio !== "original") {
      const target = presetRatio[ratio];
      if (axis === "x") applyFrame(n, Math.max(1, Math.round(n / target)));
      else applyFrame(Math.max(1, Math.round(n * target)), n);
      return;
    }
    applySize(axis, n);
  };

  const nudge = (dx: number, dy: number) => {
    if (!viewW || !viewH) return;
    const stepX = dx / scale;
    const stepY = dy / scale;
    const next = clampOrigin(originX + stepX, originY + stepY, viewW, viewH, orientedW, orientedH);
    setOriginX(next.x);
    setOriginY(next.y);
  };

  const image = (() => {
    if (!orientedW || !orientedH || frame.w < 1 || frame.h < 1) return { x: 0, y: 0, w: 0, h: 0 };
    const maxW = Math.max(1, frame.w - 24);
    const maxH = Math.max(1, Math.min(frame.h - 24, window.innerHeight * 0.7));
    const aspect = orientedW / orientedH;
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    return { x: Math.round((frame.w - w) / 2), y: Math.round((frame.h - h) / 2), w, h };
  })();
  const trimSps = orientedW > 0 ? image.w / orientedW : 0;
  trimGeom.current = { x: image.x, y: image.y, w: image.w, h: image.h, sps: trimSps || 1 };
  const cut = { x: originX * trimSps, y: originY * trimSps, w: viewW * trimSps, h: viewH * trimSps };
  const crop = { x: image.x + cut.x, y: image.y + cut.y, w: cut.w, h: cut.h };

  const dragBox = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const sps = trimGeom.current.sps;
    if (!sps || !viewW || !viewH) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startOriginX = originX;
    const startOriginY = originY;
    const target = event.currentTarget;
    target.focus();
    target.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const next = clampOrigin(
        startOriginX + (ev.clientX - startX) / sps,
        startOriginY + (ev.clientY - startY) / sps,
        viewW,
        viewH,
        orientedW,
        orientedH,
      );
      setOriginX(next.x);
      setOriginY(next.y);
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const saveExport = (full: boolean) => {
    if (full && !dirty && stillFormat(preview.extension) === format) {
      toast("warning", "Already that format.");
      return;
    }
    const width = full ? orientedW : outW;
    const height = full ? orientedH : outH;
    if (width < 1 || height < 1) return;
    const untouched =
      !full &&
      !dirty &&
      Math.abs(scale - 1) < 0.001 &&
      Math.abs(originX) < 0.5 &&
      Math.abs(originY) < 0.5 &&
      Math.abs(viewW - orientedW) < 0.5 &&
      Math.abs(viewH - orientedH) < 0.5 &&
      stillFormat(preview.extension) === format;
    if (untouched) {
      setTool("");
      return;
    }
    if (!full) setApplied(true);
    const job = jobStart("Saving picture…");
    setSavingTrim(true);
    void invoke<string>("trim_image", {
      path: preview.path,
      format,
      quality,
      background,
      viewX: full ? 0 : originX,
      viewY: full ? 0 : originY,
      viewWidth: full ? orientedW : viewW,
      viewHeight: full ? orientedH : viewH,
      outWidth: width,
      outHeight: height,
      ...pictureEdits,
    })
      .then((saved) => {
        jobFinish(job, "success", `Saved ${baseName(saved)}.`);
        void useApp.getState().refresh(source);
        if (!full) onSaved();
      })
      .catch((reason: unknown) => {
        if (!full) setApplied(false);
        jobFinish(job, "error", message(reason));
      })
      .finally(() => setSavingTrim(false));
  };

  const resizeTrim = (edge: TrimEdge, event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!image.w || !viewW || !viewH || !scale || !trimSps) return;
    const west = edge === "w" || edge === "nw" || edge === "sw";
    const east = edge === "e" || edge === "ne" || edge === "se";
    const north = edge === "n" || edge === "nw" || edge === "ne";
    const south = edge === "s" || edge === "sw" || edge === "se";
    const startX = event.clientX;
    const startY = event.clientY;
    const start = { originX, originY, viewW, viewH, scale };
    const sps = trimSps;
    const limitW = orientedW;
    const limitH = orientedH;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const minViewW = Math.max(1 / start.scale, 32 / sps);
      const minViewH = Math.max(1 / start.scale, 32 / sps);
      let nextViewW = start.viewW;
      let nextViewH = start.viewH;
      if (east || west) nextViewW = start.viewW + ((west ? -dx : dx) / sps);
      if (north || south) nextViewH = start.viewH + ((north ? -dy : dy) / sps);
      nextViewW = Math.min(Math.max(nextViewW, Math.min(minViewW, limitW)), limitW);
      nextViewH = Math.min(Math.max(nextViewH, Math.min(minViewH, limitH)), limitH);
      let left = west ? start.originX + start.viewW - nextViewW : start.originX;
      let top = north ? start.originY + start.viewH - nextViewH : start.originY;
      if (!(east || west)) {
        nextViewW = start.viewW;
        left = start.originX;
      }
      if (!(north || south)) {
        nextViewH = start.viewH;
        top = start.originY;
      }
      if (left < 0) {
        if (west) nextViewW += left;
        left = 0;
      }
      if (top < 0) {
        if (north) nextViewH += top;
        top = 0;
      }
      if (left + nextViewW > limitW) {
        if (east) nextViewW = limitW - left;
        else left = limitW - nextViewW;
      }
      if (top + nextViewH > limitH) {
        if (south) nextViewH = limitH - top;
        else top = limitH - nextViewH;
      }
      const locked = ratioRef.current;
      if (locked !== "original") {
        const target = presetRatio[locked];
        const horizontal = east || west;
        const vertical = north || south;
        let w = nextViewW;
        let h = nextViewH;
        if (horizontal && (!vertical || Math.abs(dx) >= Math.abs(dy))) h = w / target;
        else w = h * target;
        if (w > limitW) {
          w = limitW;
          h = w / target;
        }
        if (h > limitH) {
          h = limitH;
          w = h * target;
        }
        w = Math.max(1, w);
        h = Math.max(1, h);
        let x = west ? start.originX + start.viewW - w : east ? start.originX : start.originX + (start.viewW - w) / 2;
        let y = north ? start.originY + start.viewH - h : south ? start.originY : start.originY + (start.viewH - h) / 2;
        x = Math.min(Math.max(0, x), Math.max(0, limitW - w));
        y = Math.min(Math.max(0, y), Math.max(0, limitH - h));
        nextViewW = w;
        nextViewH = h;
        left = x;
        top = y;
      }
      nextViewW = Math.min(Math.max(nextViewW, Math.min(minViewW, limitW)), limitW);
      nextViewH = Math.min(Math.max(nextViewH, Math.min(minViewH, limitH)), limitH);
      left = Math.min(Math.max(0, left), Math.max(0, limitW - nextViewW));
      top = Math.min(Math.max(0, top), Math.max(0, limitH - nextViewH));
      const nextOutW = Math.min(16000, Math.max(1, Math.round(nextViewW * start.scale)));
      const nextOutH = Math.min(16000, Math.max(1, Math.round(nextViewH * start.scale)));
      const usedW = nextOutW / start.scale;
      const usedH = nextOutH / start.scale;
      if (west) left = Math.min(Math.max(0, start.originX + start.viewW - usedW), Math.max(0, limitW - usedW));
      else left = Math.min(Math.max(0, left), Math.max(0, limitW - usedW));
      if (north) top = Math.min(Math.max(0, start.originY + start.viewH - usedH), Math.max(0, limitH - usedH));
      else top = Math.min(Math.max(0, top), Math.max(0, limitH - usedH));
      setOriginX(left);
      setOriginY(top);
      setOutW(nextOutW);
      setOutH(nextOutH);
      setWidthText(String(nextOutW));
      setHeightText(String(nextOutH));
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const markBlur = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!orientedW || !orientedH) return;
    if ((event.target as Element).closest?.(".fp-blur-hit, .fp-censor")) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const locate = (clientX: number, clientY: number) => {
      const box = target.getBoundingClientRect();
      const x = box.width > 0 ? ((clientX - box.left) / box.width) * orientedW : 0;
      const y = box.height > 0 ? ((clientY - box.top) / box.height) * orientedH : 0;
      return { x: Math.min(orientedW, Math.max(0, x)), y: Math.min(orientedH, Math.max(0, y)) };
    };
    const start = locate(event.clientX, event.clientY);
    const shape = blurShape;
    const fill = blurFill;
    target.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const next = locate(ev.clientX, ev.clientY);
      setDraft({ id: -1, shape, fill, x: Math.min(start.x, next.x), y: Math.min(start.y, next.y), w: Math.abs(next.x - start.x), h: Math.abs(next.y - start.y) });
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
      const next = locate(ev.clientX, ev.clientY);
      const x = Math.min(start.x, next.x);
      const y = Math.min(start.y, next.y);
      const w = Math.abs(next.x - start.x);
      const h = Math.abs(next.y - start.y);
      const box = target.getBoundingClientRect();
      const screenW = orientedW > 0 ? (w / orientedW) * box.width : 0;
      const screenH = orientedH > 0 ? (h / orientedH) * box.height : 0;
      setDraft(null);
      if (w >= 4 && h >= 4 && screenW >= 6 && screenH >= 6) {
        blurIds.current += 1;
        const id = blurIds.current;
        setSpots((list) => [...list, { id, shape, fill, x, y, w, h }]);
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const shotSrc = `data:${mime};base64,${preview.dataBase64}`;
  const removeSpot = (id: number) => setSpots((list) => list.filter((spot) => spot.id !== id));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="fp-tools">
        {(!beside || tool === "trim" || tool === "blur") && (
          <PictureActions
            dirty={dirty}
            saving={saving}
            svg={svg}
            zipped={zipped}
            canEdit={canEdit}
            tone={tone}
            tool={tool}
            onRotateLeft={() => setQuarters((value) => (value + 3) % 4)}
            onRotateRight={() => setQuarters((value) => (value + 1) % 4)}
            onMirror={() => setFlipH((value) => !value)}
            onFlip={() => setFlipV((value) => !value)}
            onTone={() => setTone(nextTone)}
            onSave={saveTurn}
            onTool={(next) => setTool((value) => (value === next ? "" : next))}
          />
        )}
        <div className="ml-auto flex items-center gap-2">
          {tool !== "trim" && (
            <label className="flex items-center gap-1 text-xs text-[var(--muted)]">
              <input
                className="fp-icon-size"
                style={{ "--fp-icon-fill": `${((viewZoom - 1) / 7) * 100}%` } as CSSProperties}
                type="range"
                min={100}
                max={800}
                step={1}
                value={Math.round(viewZoom * 100)}
                aria-label="Zoom"
                data-tip="Zoom. Ctrl + scroll zooms."
                onChange={(event) => {
                  scrollAnchor.current = "center";
                  setViewZoom(Number(event.target.value) / 100);
                }}
              />
              {Math.round(viewZoom * 100)}%
            </label>
          )}
          {preview.scaled && <span className="text-xs text-[var(--muted)]">Shown smaller. The copy uses the full picture.</span>}
          <ToolsPlaceButton />
        </div>
      </div>
      {tool === "blur" && canEdit && (
        <div className="fp-trim">
          <span className="seg">
            <button type="button" data-active={blurShape === "square"} data-tip="Square" aria-label="Square" onClick={() => setBlurShape("square")}><Square /></button>
            <button type="button" data-active={blurShape === "oval"} data-tip="Oval" aria-label="Oval" onClick={() => setBlurShape("oval")}><Circle /></button>
          </span>
          <span className="seg">
            <button type="button" data-active={blurFill === "blur"} data-tip="Blur" aria-label="Blur" onClick={() => setBlurFill("blur")}><Blend /></button>
            <button type="button" data-active={blurFill === "black"} data-tip="Black" aria-label="Black" onClick={() => setBlurFill("black")}><Square className="fp-solid" /></button>
          </span>
          <label className="flex items-center gap-1 text-xs text-[var(--muted)]">
            Strength
            <input
              className="fp-icon-size"
              style={{ "--fp-icon-fill": `${((blurStrength - BLUR_MIN) / (BLUR_MAX - BLUR_MIN)) * 100}%` } as CSSProperties}
              type="range"
              min={BLUR_MIN}
              max={BLUR_MAX}
              value={blurStrength}
              aria-label="Blur strength"
              onChange={(event) => setBlurStrength(Number(event.target.value))}
            />
            {blurStrength}
          </label>
          <span className="text-xs text-[var(--muted)]">Drag on the picture. Click a spot to remove it.</span>
          {spots.length > 0 && <button type="button" className="btn sm" onClick={() => setSpots([])}>Clear</button>}
        </div>
      )}
      {tool && tool !== "blur" && canEdit && (
        <div className="fp-trim">
          {tool === "trim" && (
            <>
              <span className="seg" role="group" aria-label="Frame">
                {frameChoices.map((frame) => (
                  <button key={frame.id} type="button" data-active={ratio === frame.id} data-tip={frame.tip} aria-label={frame.tip} onClick={() => fitRatio(frame.id)}>
                    <FrameMark wide={frame.wide} tall={frame.tall} free={frame.free} />
                  </button>
                ))}
              </span>
              <label className="text-xs text-[var(--muted)]">
                Width
                <input className="field sm ml-1" inputMode="numeric" value={widthText} onChange={(event) => typeSize("x", event.target.value)} />
              </label>
              <label className="text-xs text-[var(--muted)]">
                Height
                <input className="field sm ml-1" inputMode="numeric" value={heightText} onChange={(event) => typeSize("y", event.target.value)} />
              </label>
              <span className="text-xs text-[var(--muted)]">{zoom}%</span>
            </>
          )}
          <span className="text-xs text-[var(--muted)]">{orientedW} × {orientedH}</span>
          <Dropdown
            menuClass="fp-format-menu"
            button={({ open, toggle }) => (
              <button type="button" className="field sm fp-format" data-active={open} aria-label="Format" onClick={toggle}>
                {formatLabel(format)}
              </button>
            )}
          >
            {(close) => (
              <>
                {([["jpg", "JPG"], ["png", "PNG"], ["webp", "WebP"], ["avif", "AVIF"], ["bmp", "BMP"], ["gif", "GIF"]] as const).map(([value, label]) => (
                  <MenuItem key={value} label={label} hint={format === value ? "✓" : undefined} onClick={() => { setFormat(value); close(); }} />
                ))}
              </>
            )}
          </Dropdown>
          {(format === "jpg" || format === "avif") && (
            <label className="flex items-center gap-1 text-xs text-[var(--muted)]">
              Quality
              <input type="range" min={1} max={100} value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
              {quality}
            </label>
          )}
          {(format === "jpg" || format === "bmp") && ["png", "webp", "avif", "gif", "svg", "ico"].includes(preview.extension) && (
            <label className="flex items-center gap-1 text-xs text-[var(--muted)]">
              Transparent parts
              <span className="seg" role="group" aria-label="Color for transparent parts">
                <button type="button" data-active={background === "white"} data-tip="See-through parts become white" onClick={() => setBackground("white")}>White</button>
                <button type="button" data-active={background === "black"} data-tip="See-through parts become black" onClick={() => setBackground("black")}>Black</button>
              </span>
            </label>
          )}
          <button
            className="btn sm primary"
            type="button"
            data-trim-commit={tool === "trim" ? "" : undefined}
            disabled={savingTrim || (tool === "trim" && (!(Number(widthText) > 0) || !(Number(heightText) > 0) || outW < 1 || outH < 1))}
            onClick={() => saveExport(tool === "convert")}
          >
            {savingTrim && <span className="fp-spin" />}
            {savingTrim ? "Saving…" : "Save"}
          </button>
          {notice && <span className="text-xs text-[var(--muted)]">{notice}</span>}
          {tool === "trim" && <span className="text-xs text-[var(--muted)]">Enter keeps the trim. Drag the box to move it. Drag an edge to resize. Ctrl + scroll zooms.</span>}
          {tool === "trim" && zoom !== 100 && <span className="text-xs text-[var(--muted)]">Save scales the picture to this size.</span>}
          {preview.extension === "gif" && <span className="text-xs text-[var(--muted)]">Animated GIFs become a single frame.</span>}
          {tool === "convert" && (format === "png" || format === "webp") && <span className="text-xs text-[var(--muted)]">This keeps every pixel. Photos are often larger than a JPG.</span>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto" ref={stageRef}>
        <div className="fp-stage" data-trim={tool === "trim" ? "true" : undefined} data-zoom={tool !== "trim" && viewZoom > 1 ? "true" : undefined}>
          {tool === "trim" && canEdit && image.w > 0 && crop.w > 0 ? (
            <>
              <div className="fp-photo" style={{ left: image.x, top: image.y, width: image.w, height: image.h, background: format === "jpg" || format === "bmp" ? (background === "black" ? "#000" : "#fff") : "transparent", clipPath: applied ? `inset(${cut.y}px ${Math.max(0, image.w - cut.x - cut.w)}px ${Math.max(0, image.h - cut.y - cut.h)}px ${cut.x}px)` : undefined }}>
                <img
                  alt={preview.name}
                  src={shotSrc}
                  style={{
                    width: turned ? image.h : image.w,
                    height: turned ? image.w : image.h,
                    filter: toneFilter(tone),
                    transform: `translate(-50%, -50%) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1}) rotate(${quarters * 90}deg)`,
                  }}
                />
                <BlurMarks spots={marks} boxW={image.w} boxH={image.h} orientedW={orientedW} orientedH={orientedH} tone={tone} turned={turned} flipH={flipH} flipV={flipV} quarters={quarters} src={shotSrc} strength={blurStrength} interactive={false} onRemove={removeSpot} />
                {!applied && <div className="fp-shade" style={{ left: 0, top: 0, width: "100%", height: cut.y }} />}
                {!applied && <div className="fp-shade" style={{ left: 0, top: cut.y, width: cut.x, height: cut.h }} />}
                {!applied && <div className="fp-shade" style={{ left: cut.x + cut.w, top: cut.y, right: 0, height: cut.h }} />}
                {!applied && <div className="fp-shade" style={{ left: 0, top: cut.y + cut.h, right: 0, bottom: 0 }} />}
              </div>
              {!applied && (
              <div
                ref={cropRef}
                className="fp-frame"
                tabIndex={0}
                style={{ left: crop.x, top: crop.y, width: crop.w, height: crop.h }}
                onPointerDown={dragBox}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 10 : 1;
                  if (event.key === "ArrowLeft") nudge(-step, 0);
                  else if (event.key === "ArrowRight") nudge(step, 0);
                  else if (event.key === "ArrowUp") nudge(0, -step);
                  else if (event.key === "ArrowDown") nudge(0, step);
                  else return;
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                {(["n", "s", "e", "w", "nw", "ne", "sw", "se"] as TrimEdge[]).map((edge) => (
                  <div key={edge} className="fp-handle" data-edge={edge} onPointerDown={(event) => resizeTrim(edge, event)} />
                ))}
              </div>
              )}
            </>
          ) : (
            <div
              className="fp-shot"
              data-pan={tool !== "blur" && viewZoom > 1 ? "true" : undefined}
              data-blur={tool === "blur" ? "true" : undefined}
              style={{ width: displayW, height: displayH, background: (format === "jpg" || format === "bmp") && ["png", "webp", "avif", "gif", "svg", "ico"].includes(preview.extension) ? (background === "black" ? "#000" : "#fff") : undefined }}
              onPointerDown={(event) => {
                if (tool === "blur") {
                  markBlur(event);
                  return;
                }
                if (viewZoom <= 1) return;
                const scroller = stageRef.current;
                if (!scroller) return;
                event.preventDefault();
                const startX = event.clientX;
                const startY = event.clientY;
                const startLeft = scroller.scrollLeft;
                const startTop = scroller.scrollTop;
                const target = event.currentTarget;
                target.setPointerCapture(event.pointerId);
                const move = (ev: PointerEvent) => {
                  scroller.scrollLeft = startLeft - (ev.clientX - startX);
                  scroller.scrollTop = startTop - (ev.clientY - startY);
                };
                const up = (ev: PointerEvent) => {
                  target.removeEventListener("pointermove", move);
                  target.removeEventListener("pointerup", up);
                  if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
                };
                target.addEventListener("pointermove", move);
                target.addEventListener("pointerup", up);
              }}
            >
              <img
                alt={preview.name}
                src={shotSrc}
                onLoad={(event) => {
                  const width = event.currentTarget.naturalWidth;
                  const height = event.currentTarget.naturalHeight;
                  if (width > 0 && height > 0) setPixels((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
                }}
                style={{
                  width: turned ? displayH : displayW,
                  height: turned ? displayW : displayH,
                  filter: toneFilter(tone),
                  transform: `translate(-50%, -50%) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1}) rotate(${quarters * 90}deg)`,
                }}
              />
              <BlurMarks spots={marks} boxW={displayW} boxH={displayH} orientedW={orientedW} orientedH={orientedH} tone={tone} turned={turned} flipH={flipH} flipV={flipV} quarters={quarters} src={shotSrc} strength={blurStrength} interactive={tool === "blur"} onRemove={removeSpot} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type VideoPreset = "original" | "youtube" | "tiktok" | "instagram" | "fourThree";

type VideoInfo = { durationMs: number; width: number; height: number; hasAudio: boolean };

const presetRatio: Record<Exclude<VideoPreset, "original">, number> = {
  youtube: 16 / 9,
  tiktok: 9 / 16,
  instagram: 1,
  fourThree: 4 / 3,
};

const soundExts = ["mp3", "m4a", "aac", "wav", "ogg", "oga", "flac", "opus"];

const frameChoices: { id: VideoPreset; tip: string; wide: number; tall: number; free?: boolean }[] = [
  { id: "original", tip: "Original", wide: 16, tall: 11, free: true },
  { id: "youtube", tip: "16:9", wide: 18, tall: 10 },
  { id: "fourThree", tip: "4:3", wide: 16, tall: 12 },
  { id: "instagram", tip: "1:1", wide: 13, tall: 13 },
  { id: "tiktok", tip: "9:16", wide: 8, tall: 14 },
];

function FrameMark({ wide, tall, free }: { wide: number; tall: number; free?: boolean }) {
  return (
    <span className="fp-ratio" data-free={free ? "true" : undefined} aria-hidden="true">
      <i style={{ width: wide, height: tall }} />
    </span>
  );
}

function Volume({ value, disabled, onChange }: { value: number; disabled?: boolean; onChange: (value: number) => void }) {
  return (
    <input
      className="fp-icon-size fp-vol"
      type="range"
      min={0}
      max={100}
      step={1}
      value={value}
      disabled={disabled}
      aria-label="Volume"
      data-tip={`Volume ${value}%`}
      data-tip-pos="top"
      style={{ "--fp-icon-fill": `${value}%` } as CSSProperties}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}

function clock(ms: number) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

function frameNote(preset: VideoPreset, picture: { w: number; h: number } | null, movable: boolean) {
  const cap = preset === "youtube" ? [1920, 1080] : preset === "tiktok" ? [1080, 1920] : preset === "instagram" ? [1080, 1080] : preset === "fourThree" ? [1440, 1080] : null;
  const scales = !!cap && !!picture && (picture.w > cap[0] + 1 || picture.h > cap[1] + 1);
  if (movable && scales) return "Drag the picture to move the frame. Save scales this down to fit.";
  if (scales) return "Save scales this down to fit.";
  return movable ? "Drag the picture to move the frame." : "The picture already has this shape.";
}

function cropDragSlices(cut: { x: number; y: number; w: number; h: number }, videoW: number, videoH: number) {
  const barTop = videoH - 48;
  const volTop = videoH - 132;
  const volLeft = videoW - 44;
  const top = cut.y;
  const bottom = cut.y + cut.h;
  const right = cut.x + cut.w;
  const slices: { top: number; height: number; left: number; right: number }[] = [];
  const upperEnd = Math.min(bottom, volTop);
  if (upperEnd - top > 1) slices.push({ top: 0, height: upperEnd - top, left: 0, right: 0 });
  const midTop = Math.max(top, volTop);
  const midEnd = Math.min(bottom, barTop);
  if (midEnd - midTop > 1) {
    const rightInset = Math.max(0, right - volLeft);
    if (cut.w - rightInset > 8) slices.push({ top: midTop - top, height: midEnd - midTop, left: 0, right: rightInset });
  }
  return slices;
}

function visualCrop(width: number, height: number, preset: VideoPreset, cropX: number, cropY: number) {
  if (preset === "original" || width < 1 || height < 1) return null;
  const ratio = presetRatio[preset];
  const wide = width / height > ratio;
  const w = wide ? height * ratio : width;
  const h = wide ? height : width / ratio;
  return { x: (width - w) * cropX, y: (height - h) * cropY, w, h };
}

function TimeSpan({
  label,
  start,
  end,
  duration,
  disabled,
  onChange,
  onMove,
  onSeek,
  onSeekEnd,
  handles = true,
}: {
  label: string;
  start: number;
  end: number;
  duration: number;
  disabled?: boolean;
  onChange?: (which: "start" | "end", ms: number) => void;
  onMove?: (startMs: number) => void;
  onSeek?: (ms: number) => void;
  onSeekEnd?: () => void;
  handles?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = Math.max(1, duration);
  const from = Math.min(start, span);
  const to = Math.min(Math.max(end, from), span);
  const left = (from / span) * 100;
  const width = ((to - from) / span) * 100;
  const drag = (which: "start" | "end", event: ReactPointerEvent<HTMLButtonElement>) => {
    const track = trackRef.current;
    if (!track || disabled) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)) : 0;
      onChange?.(which, Math.round(ratio * span));
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  const dragBody = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || !onMove || disabled) return;
    event.preventDefault();
    const originX = event.clientX;
    const origin = from;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = track.getBoundingClientRect();
      const delta = rect.width > 0 ? ((ev.clientX - originX) / rect.width) * span : 0;
      onMove(Math.round(origin + delta));
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  const scrub = (event: ReactPointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || !onSeek) return;
    const hit = event.target as HTMLElement;
    if (hit.closest(".fp-span-knob, .fp-span-fill")) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const at = (clientX: number) => {
      const rect = track.getBoundingClientRect();
      const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
      onSeek(Math.round(ratio * span));
    };
    at(event.clientX);
    const move = (ev: PointerEvent) => at(ev.clientX);
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
      onSeekEnd?.();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  return (
    <div className="fp-span" data-off={disabled ? "true" : undefined} data-scrub={onSeek ? "true" : undefined} ref={trackRef} onPointerDown={onSeek ? scrub : undefined}>
      <div className="fp-span-line" />
      <div className="fp-span-fill" data-move={onMove ? "true" : undefined} style={{ left: `${left}%`, width: `${width}%` }} onPointerDown={onMove ? dragBody : undefined} />
      {handles && <button type="button" className="fp-span-knob" style={{ left: `${left}%` }} disabled={disabled} aria-label={`${label} start`} onPointerDown={(event) => drag("start", event)} />}
      {handles && <button type="button" className="fp-span-knob" style={{ left: `${left + width}%` }} disabled={disabled} aria-label={`${label} end`} onPointerDown={(event) => drag("end", event)} />}
    </div>
  );
}

function VideoActions({
  saving,
  canSave,
  ready,
  saveTip,
  trimming,
  onRotateLeft,
  onRotateRight,
  onMirror,
  onFlip,
  onTrim,
  onSave,
}: {
  saving: boolean;
  canSave: boolean;
  ready: boolean;
  saveTip: string;
  trimming: boolean;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onMirror: () => void;
  onFlip: () => void;
  onTrim: () => void;
  onSave: () => void;
}) {
  return (
    <>
      <button className="tb-btn" disabled={saving} data-tip="Rotate left" onClick={onRotateLeft}><RotateCcw /></button>
      <button className="tb-btn" disabled={saving} data-tip="Rotate right" onClick={onRotateRight}><RotateCw /></button>
      <button className="tb-btn" disabled={saving} data-tip="Mirror" onClick={onMirror}><FlipHorizontal /></button>
      <button className="tb-btn" disabled={saving} data-tip="Flip" onClick={onFlip}><FlipVertical /></button>
      <button className="tb-btn" disabled={saving} data-active={trimming} data-tip="Trim" onClick={onTrim}><Crop /></button>
      <button className="tb-btn" disabled={!canSave} data-tip={saveTip} style={ready ? { color: "var(--accent)" } : undefined} onClick={onSave}>
        <Save />
      </button>
      {saving && <button className="tb-btn" data-tip="Cancel" onClick={() => void invoke("cancel_video")}><Square /></button>}
    </>
  );
}

function VideoView({ preview, source, onTrim }: { preview: PreviewFile; source: Side; onTrim: (active: boolean) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [blocked, setBlocked] = useState("");
  const [pixels, setPixels] = useState({ w: 0, h: 0 });
  const [quarters, setQuarters] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [preset, setPreset] = useState<VideoPreset>("original");
  const [cropX, setCropX] = useState(0.5);
  const [cropY, setCropY] = useState(0.5);
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  const [soundStart, setSoundStart] = useState(0);
  const [soundEnd, setSoundEnd] = useState(0);
  const [soundVol, setSoundVol] = useState(100);
  const [extraPath, setExtraPath] = useState<string | null>(null);
  const [extraDur, setExtraDur] = useState(0);
  const [extraStart, setExtraStart] = useState(0);
  const [extraEnd, setExtraEnd] = useState(0);
  const [extraPlace, setExtraPlace] = useState(0);
  const [extraVol, setExtraVol] = useState(100);
  const [matched, setMatched] = useState(false);
  const [songPlaying, setSongPlaying] = useState(false);
  const [songHeld, setSongHeld] = useState(false);
  const [songMs, setSongMs] = useState(0);
  const [soundOpen, setSoundOpen] = useState(false);
  const [draftPath, setDraftPath] = useState("");
  const [mute, setMute] = useState(false);
  const [trimming, setTrimming] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const saveJob = useRef<string | null>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const extraAudio = useRef<HTMLAudioElement | null>(null);
  const soundFollows = useRef(true);
  const scrubbing = useRef(false);
  const tailing = useRef(false);
  const tailFrame = useRef(0);
  const holding = useRef(false);
  const resumeTail = useRef(false);
  const gliding = useRef(false);
  const songEdge = useRef(0);
  const songOn = useRef(false);
  const songAt = useRef(0);
  const songFrame = useRef(0);
  const extraVolRef = useRef(100);
  const hearRef = useRef<(t: number, force: boolean) => void>(() => {});
  const [playMs, setPlayMs] = useState(0);
  const playRef = useRef(0);
  const castOn = useRef(false);
  const thumbVideo = useRef<HTMLVideoElement>(null);
  const thumbTimer = useRef(0);
  const [thumb, setThumb] = useState<{ left: number; top: number; ms: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  const packed = isPackedPath(preview.path) || isRemotePath(preview.path);
  const turned = quarters % 2 === 1;
  const naturalW = info?.width || pixels.w;
  const naturalH = info?.height || pixels.h;
  const orientedW = turned ? naturalH : naturalW;
  const orientedH = turned ? naturalW : naturalH;
  const trimmed = !!info && (startMs > 80 || endMs < info.durationMs - 80);
  const heardFrom = Math.max(soundStart, startMs);
  const heardTo = Math.min(soundEnd, endMs);
  const soundCut = !!info && info.hasAudio && !mute && (heardFrom > startMs + 80 || heardTo < endMs - 80);
  const levelDirty = !!info && info.hasAudio && !mute && soundVol !== 100;
  const audioDirty = (mute && info?.hasAudio === true) || soundCut || levelDirty || !!extraPath;
  const dirty = quarters !== 0 || flipH || flipV || preset !== "original" || audioDirty || trimmed;
  const fitted = (() => {
    if (!orientedW || !orientedH || frame.w < 2 || frame.h < 2) return null;
    const maxW = Math.max(1, frame.w - 16);
    const maxH = Math.max(1, frame.h - 16);
    const aspect = orientedW / orientedH;
    let w = maxW;
    let h = w / aspect;
    if (h > maxH) {
      h = maxH;
      w = h * aspect;
    }
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    return { x: Math.round((frame.w - w) / 2), y: Math.round((frame.h - h) / 2), w, h };
  })();
  const picture = visualCrop(orientedW, orientedH, preset, cropX, cropY);
  const movable = !!picture && (orientedW - picture.w > 2 || orientedH - picture.h > 2);
  const cut = fitted && picture && movable
    ? {
        x: picture.x * (fitted.w / orientedW),
        y: picture.y * (fitted.h / orientedH),
        w: picture.w * (fitted.w / orientedW),
        h: picture.h * (fitted.h / orientedH),
      }
    : null;

  useEffect(() => {
    let objectUrl = "";
    let cancel = false;
    if (preview.dataBase64) {
      const copy = new Uint8Array(decodeBase64(preview.dataBase64));
      objectUrl = URL.createObjectURL(new Blob([copy.buffer], { type: videoMime[preview.extension] ?? "video/mp4" }));
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
  }, [preview.path, preview.dataBase64, preview.extension]);

  useEffect(() => {
    let cancel = false;
    setInfo(null);
    setBlocked("");
    void invoke<VideoInfo>("probe_video", { path: preview.path })
      .then((next) => {
        if (cancel) return;
        setInfo(next);
        setEndMs(next.durationMs);
        setSoundStart(0);
        setSoundEnd(next.durationMs);
        soundFollows.current = true;
      })
      .catch((reason: unknown) => {
        if (!cancel) setBlocked(message(reason));
      });
    return () => {
      cancel = true;
    };
  }, [preview.path]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !info) return;
    const t = video.currentTime * 1000;
    video.muted = castOn.current || mute || !info.hasAudio || t < soundStart - 40 || t >= soundEnd;
    video.volume = soundVol / 100;
    syncExtra(video);
  }, [extraEnd, extraPlace, extraStart, extraVol, info, mute, soundEnd, soundStart, soundVol, url]);

  useEffect(() => watchCast((on) => {
    castOn.current = on;
    const video = videoRef.current;
    if (!video) return;
    const t = video.currentTime * 1000;
    video.muted = on || mute || !info?.hasAudio || t < soundStart - 40 || t >= soundEnd;
  }), [info, mute, soundEnd, soundStart]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancel = false;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stop = await listen<{ path: string; ratio: number }>("video-edit", (event) => {
        if (event.payload.path !== preview.path) return;
        setProgress(event.payload.ratio);
        if (saveJob.current) jobUpdate(saveJob.current, event.payload.ratio, "Saving video…");
      });
      if (cancel) stop();
      else unlisten = stop;
    });
    return () => {
      cancel = true;
      unlisten?.();
    };
  }, [preview.path]);

  useEffect(() => () => {
    tailing.current = false;
    songOn.current = false;
    cancelAnimationFrame(tailFrame.current);
    cancelAnimationFrame(songFrame.current);
    window.clearTimeout(thumbTimer.current);
  }, [preview.path]);

  useEffect(() => {
    extraAudio.current?.pause();
    extraAudio.current = null;
    if (!extraPath || !inTauri()) return;
    let cancel = false;
    let audio: HTMLAudioElement | null = null;
    void import("@tauri-apps/api/core").then(({ convertFileSrc }) => {
      if (cancel) return;
      audio = new Audio(convertFileSrc(extraPath));
      audio.preload = "auto";
      extraAudio.current = audio;
    });
    return () => {
      cancel = true;
      audio?.pause();
      if (extraAudio.current === audio) extraAudio.current = null;
    };
  }, [extraPath]);

  useEffect(() => {
    songOn.current = false;
    cancelAnimationFrame(songFrame.current);
    setSongPlaying(false);
    setSongHeld(false);
    setSongMs(0);
    songAt.current = 0;
    if (!extraPath) {
      setExtraDur(0);
      setMatched(false);
      return;
    }
    setMatched(false);
    let cancel = false;
    void invoke<number>("probe_sound", { path: extraPath })
      .then((ms) => {
        if (cancel) return;
        setExtraDur(ms);
        setExtraPlace(0);
        setExtraStart(0);
        setExtraEnd(ms);
      })
      .catch((reason: unknown) => {
        if (cancel) return;
        toast("warning", message(reason));
        const play = Math.max(100, endMs - startMs);
        setExtraDur(play);
        setExtraPlace(0);
        setExtraStart(0);
        setExtraEnd(play);
      });
    return () => {
      cancel = true;
    };
  }, [extraPath]);

  useEffect(() => {
    if (!soundOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSoundOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [soundOpen]);

  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setFrame({ w: node.clientWidth, h: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const dragCrop = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!picture || !fitted || saving) return;
    event.preventDefault();
    event.stopPropagation();
    const slackX = orientedW - picture.w;
    const slackY = orientedH - picture.h;
    const start = { x: event.clientX, y: event.clientY, cx: cropX, cy: cropY };
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ((ev.clientX - start.x) / fitted.w) * orientedW;
      const dy = ((ev.clientY - start.y) / fitted.h) * orientedH;
      setCropX(slackX > 1 ? Math.min(1, Math.max(0, (start.cx * slackX + dx) / slackX)) : 0.5);
      setCropY(slackY > 1 ? Math.min(1, Math.max(0, (start.cy * slackY + dy) / slackY)) : 0.5);
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const songFile = extraDur > 0 ? extraDur : Math.max(extraEnd, extraStart);
  songEdge.current = extraPath ? extraPlace + Math.max(0, extraEnd - extraStart) : 0;
  extraVolRef.current = extraVol;
  const timelineMs = info?.durationMs ?? 0;
  const head = timelineMs > 0 ? Math.min(100, Math.max(0, (Math.min(playMs, timelineMs) / timelineMs) * 100)) : 0;
  const songSlice = Math.max(0, extraEnd - extraStart);
  const songHeard = songHeld ? songMs : null;
  const songMark = songHeard !== null && songFile > 0 ? Math.min(100, Math.max(0, (songHeard / songFile) * 100)) : null;
  const videoLen = Math.max(100, endMs - startMs);
  const matchedFit = matched && Math.abs(songSlice - Math.min(videoLen, Math.max(100, songFile || videoLen))) < 80 && Math.abs(extraPlace - startMs) < 80;
  const hear = (t: number, force: boolean) => {
    const audio = extraAudio.current;
    const video = videoRef.current;
    if (!audio || !extraPath) return;
    audio.volume = extraVol / 100;
    if (songOn.current) return;
    const slice = Math.max(0, extraEnd - extraStart);
    const inside = t >= extraPlace - 40 && t < extraPlace + slice;
    if (!inside || !(force || (video ? !video.paused : false))) {
      audio.pause();
      return;
    }
    const want = (extraStart + Math.max(0, t - extraPlace)) / 1000;
    if (Math.abs(audio.currentTime - want) > (force && scrubbing.current ? 0.12 : 0.35)) audio.currentTime = want;
    if (audio.paused) void audio.play().catch(() => {});
  };
  hearRef.current = hear;
  const stopTail = () => {
    tailing.current = false;
    cancelAnimationFrame(tailFrame.current);
  };
  const startTail = (from: number) => {
    songOn.current = false;
    cancelAnimationFrame(songFrame.current);
    setSongPlaying(false);
    if (!info || songEdge.current <= info.durationMs + 80) return;
    const end = songEdge.current;
    const origin = Math.max(info.durationMs, Math.min(from, end));
    if (origin >= end - 30) return;
    tailing.current = true;
    const video = videoRef.current;
    if (video) {
      holding.current = true;
      video.pause();
      video.currentTime = Math.max(0, info.durationMs - 50) / 1000;
    }
    playRef.current = origin;
    setPlayMs(origin);
    hearRef.current(origin, true);
    const started = performance.now();
    let shown = Math.floor(origin / 80);
    const tick = (now: number) => {
      if (!tailing.current) return;
      const t = origin + (now - started);
      if (t >= end) {
        tailing.current = false;
        playRef.current = end;
        setPlayMs(end);
        extraAudio.current?.pause();
        return;
      }
      playRef.current = t;
      const bucket = Math.floor(t / 80);
      if (bucket !== shown) {
        shown = bucket;
        setPlayMs(t);
        const scroll = scrollRef.current;
        const inset = insetRef.current;
        if (scroll && inset && timelineMs > 0) {
          const x = (t / timelineMs) * inset.clientWidth;
          const view = x - scroll.scrollLeft;
          if (view < 48 || view > scroll.clientWidth - 48) {
            gliding.current = true;
            scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.35);
            gliding.current = false;
          }
        }
      }
      hearRef.current(t, true);
      tailFrame.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(tailFrame.current);
    tailFrame.current = requestAnimationFrame(tick);
  };
  const seek = (ms: number) => {
    if (!info) return;
    const next = Math.max(0, Math.min(ms, timelineMs));
    playRef.current = next;
    setPlayMs(next);
    const video = videoRef.current;
    if (!video) return;
    holding.current = true;
    if (next >= info.durationMs) {
      video.pause();
      video.currentTime = Math.max(0, info.durationMs - 50) / 1000;
    } else {
      video.currentTime = next / 1000;
    }
    hear(next, scrubbing.current || tailing.current);
  };
  const scrubTo = (ms: number) => {
    songOn.current = false;
    cancelAnimationFrame(songFrame.current);
    setSongPlaying(false);
    resumeTail.current = tailing.current || videoRef.current?.paused === false;
    stopTail();
    scrubbing.current = true;
    seek(ms);
  };
  const stopScrub = () => {
    scrubbing.current = false;
    setThumb(null);
    const video = videoRef.current;
    const duration = info?.durationMs ?? 0;
    if (resumeTail.current && playRef.current >= duration - 80 && songEdge.current > duration + 80) {
      startTail(playRef.current);
      return;
    }
    if (resumeTail.current && video && playRef.current < duration - 80) {
      holding.current = true;
      video.currentTime = playRef.current / 1000;
      void video.play().catch(() => {});
      return;
    }
    resumeTail.current = false;
    if (video?.paused) extraAudio.current?.pause();
  };
  const peekAt = (clientX: number, ms: number) => {
    if (!info) return;
    const scroll = scrollRef.current;
    if (!scroll) return;
    const box = scroll.getBoundingClientRect();
    const width = 168;
    const left = Math.min(box.right - width - 8, Math.max(box.left + 8, clientX - width / 2));
    const frame = Math.max(0, Math.min(ms, Math.max(0, info.durationMs - 40)));
    const node = thumbVideo.current;
    if (node && Math.abs(node.currentTime * 1000 - frame) > 160) node.currentTime = frame / 1000;
    setThumb({ left, top: Math.max(8, box.top - 118), ms });
  };
  const peekFromPointer = (clientX: number) => {
    const inset = insetRef.current;
    if (!inset || !info || saving) return;
    const rect = inset.getBoundingClientRect();
    const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    peekAt(clientX, ratio * timelineMs);
  };
  const scrubRuler = (event: ReactPointerEvent<HTMLDivElement>) => {
    const inset = insetRef.current;
    if (!inset || saving || !info) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const at = (clientX: number) => {
      const rect = inset.getBoundingClientRect();
      const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
      const ms = Math.round(ratio * timelineMs);
      scrubTo(ms);
      peekAt(clientX, ms);
    };
    at(event.clientX);
    const move = (ev: PointerEvent) => at(ev.clientX);
    const up = (ev: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
      stopScrub();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };
  const moveTrim = (which: "start" | "end", ms: number) => {
    if (!info || saving) return;
    if (which === "start") {
      const next = Math.max(0, Math.min(ms, endMs - 100));
      setStartMs(next);
      if (soundFollows.current) setSoundStart(next);
      seek(next);
      return;
    }
    const next = Math.min(info.durationMs, Math.max(ms, startMs + 100));
    setEndMs(next);
    if (soundFollows.current) setSoundEnd(next);
    seek(Math.max(0, next - 50));
  };
  const moveSound = (which: "start" | "end", ms: number) => {
    if (!info || saving || mute || !info.hasAudio) return;
    soundFollows.current = false;
    if (which === "start") {
      const next = Math.max(0, Math.min(ms, soundEnd - 100));
      setSoundStart(next);
      seek(next);
      return;
    }
    const next = Math.min(info.durationMs, Math.max(ms, soundStart + 100));
    setSoundEnd(next);
    seek(Math.max(0, next - 50));
  };
  const stopSong = () => {
    songOn.current = false;
    cancelAnimationFrame(songFrame.current);
    setSongPlaying(false);
    setSongMs(songAt.current);
    setSongHeld(true);
    if (!tailing.current && videoRef.current?.paused !== false) extraAudio.current?.pause();
  };
  const playSongFrom = (from: number) => {
    const audio = extraAudio.current;
    const song = extraDur > 0 ? extraDur : 0;
    if (!audio || song < 1) return;
    const origin = Math.max(0, Math.min(from, Math.max(0, song - 30)));
    songOn.current = true;
    setSongPlaying(true);
    setSongHeld(true);
    songAt.current = origin;
    setSongMs(origin);
    const video = videoRef.current;
    if (video && !video.paused) video.pause();
    stopTail();
    audio.volume = extraVolRef.current / 100;
    audio.currentTime = origin / 1000;
    void audio.play().catch(() => {});
    const started = performance.now();
    let shown = Math.floor(origin / 80);
    const tick = (now: number) => {
      if (!songOn.current) return;
      const t = origin + (now - started);
      if (t >= song) {
        songOn.current = false;
        songAt.current = song;
        setSongMs(song);
        setSongPlaying(false);
        setSongHeld(true);
        audio.pause();
        return;
      }
      songAt.current = t;
      audio.volume = extraVolRef.current / 100;
      const bucket = Math.floor(t / 80);
      if (bucket !== shown) {
        shown = bucket;
        setSongMs(t);
      }
      songFrame.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(songFrame.current);
    songFrame.current = requestAnimationFrame(tick);
  };
  const toggleSong = () => {
    if (songPlaying) {
      stopSong();
      return;
    }
    const from = songAt.current > 80 && songAt.current < songFile - 80 ? songAt.current : extraStart;
    playSongFrom(from);
  };
  const scrubSong = (ms: number) => {
    const song = extraDur > 0 ? extraDur : 0;
    if (song < 1) return;
    const next = Math.max(0, Math.min(ms, song));
    songAt.current = next;
    setSongMs(next);
    setSongPlaying(true);
    setSongHeld(true);
    songOn.current = false;
    cancelAnimationFrame(songFrame.current);
    const video = videoRef.current;
    if (video && !video.paused) video.pause();
    stopTail();
    const audio = extraAudio.current;
    if (!audio) return;
    audio.pause();
    audio.volume = extraVolRef.current / 100;
    try { audio.currentTime = next / 1000; } catch { /* not ready yet */ }
  };
  const stopSongScrub = () => playSongFrom(songAt.current);
  const matchVideo = () => {
    if (!info || saving || !extraPath) return;
    const videoLen = Math.max(100, endMs - startMs);
    const song = extraDur > 0 ? extraDur : videoLen;
    const len = Math.min(videoLen, Math.max(100, song));
    const already = matched && Math.abs(extraEnd - extraStart - len) < 80 && Math.abs(extraPlace - startMs) < 80;
    if (already) {
      setMatched(false);
      return;
    }
    const start = Math.max(0, Math.min(extraStart, Math.max(0, song - len)));
    setExtraStart(start);
    setExtraEnd(start + len);
    setExtraPlace(startMs);
    setMatched(true);
  };
  const trimSong = (which: "start" | "end", ms: number) => {
    if (!info || saving || !extraPath) return;
    const song = extraDur > 0 ? extraDur : Math.max(extraEnd, ms);
    setMatched(false);
    if (which === "start") {
      setExtraStart(Math.max(0, Math.min(ms, extraEnd - 100)));
      return;
    }
    setExtraEnd(Math.min(song, Math.max(ms, extraStart + 100)));
  };
  const slideSong = (ms: number) => {
    if (!info || saving || !extraPath) return;
    const len = Math.max(100, extraEnd - extraStart);
    const song = extraDur > 0 ? extraDur : len;
    const next = Math.max(0, Math.min(ms, Math.max(0, song - len)));
    setExtraStart(next);
    setExtraEnd(next + len);
  };
  const syncExtra = (video: HTMLVideoElement) => {
    if (scrubbing.current) return;
    hear(video.currentTime * 1000, !video.paused);
  };
  const chooseSound = () => {
    void invoke<string | null>("pick_sound_file")
      .then((picked) => {
        if (picked) setDraftPath(picked);
      })
      .catch((reason: unknown) => toast("error", message(reason)));
  };
  const addSound = () => {
    const picked = draftPath.trim();
    if (!picked || !info) {
      toast("warning", "Choose a sound file.");
      return;
    }
    const ext = picked.split(".").pop()?.toLowerCase() ?? "";
    if (!soundExts.includes(ext) || isPackedPath(picked) || isRemotePath(picked)) {
      toast("warning", "Choose a sound file on this computer.");
      return;
    }
    setExtraPath(picked);
    setExtraVol(100);
    setSoundOpen(false);
  };

  const save = () => {
    if (packed) return;
    if (blocked) {
      toast("error", blocked);
      return;
    }
    if (!info) {
      toast("warning", "Still reading that video.");
      return;
    }
    if (!dirty || saving) return;
    const job = jobStart("Saving video…");
    saveJob.current = job;
    setSaving(true);
    setProgress(0);
    void invoke<string>("edit_video", {
      path: preview.path,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      preset,
      cropX,
      cropY,
      quarters,
      flipH,
      flipV,
      mute,
      soundPath: extraPath,
      soundStartMs: Math.round(soundStart),
      soundEndMs: Math.round(soundEnd),
      soundVolume: soundVol / 100,
      extraStartMs: Math.round(extraStart),
      extraEndMs: Math.round(extraEnd),
      extraPlaceMs: Math.round(extraPlace),
      extraVolume: extraVol / 100,
    })
      .then((saved) => {
        jobFinish(job, "success", `Saved ${baseName(saved)}.`);
        void useApp.getState().refresh(source);
      })
      .catch((reason: unknown) => {
        const text = message(reason);
        jobFinish(job, text === "Save cancelled." ? "warning" : "error", text);
      })
      .finally(() => {
        if (saveJob.current === job) saveJob.current = null;
        setSaving(false);
      });
  };

  const percent = Math.round(progress * 100);
  const saveTip = packed
    ? "Copy the video out of the archive before saving a change."
    : blocked
      ? blocked
      : saving
        ? `Saving… ${percent}%`
        : "Save the video";
  const canSave = !(saving || packed || (!blocked && !dirty));
  const ready = dirty && !saving && !packed && !blocked;
  const { beside, setTools } = useContext(PreviewChromeContext);
  const saveRef = useRef(save);
  saveRef.current = save;
  const videoActionProps = {
    saving,
    canSave,
    ready,
    saveTip,
    onRotateLeft: () => setQuarters((value) => (value + 3) % 4),
    onRotateRight: () => setQuarters((value) => (value + 1) % 4),
    onMirror: () => setFlipH((value) => !value),
    onFlip: () => setFlipV((value) => !value),
    onTrim: () => setTrimming((value) => !value),
    onSave: () => saveRef.current(),
    trimming,
  };
  useEffect(() => {
    onTrim(trimming);
    return () => onTrim(false);
  }, [trimming, onTrim]);
  useLayoutEffect(() => {
    if (!beside || trimming || playing) {
      setTools(null);
      return () => setTools(null);
    }
    setTools(
      <div className="fp-rail-tools">
        <VideoActions {...videoActionProps} />
      </div>,
    );
    return () => setTools(null);
  }, [beside, blocked, canSave, dirty, mute, packed, playing, ready, saveTip, saving, setTools, trimming]);

  return (
    <div className="fp-video">
      <div className="fp-tools">
        {(!beside || trimming) && <VideoActions {...videoActionProps} />}
        {trimming && (
          <>
            <div className="seg" role="group" aria-label="Frame">
              {frameChoices.map((frame) => (
                <button
                  key={frame.id}
                  type="button"
                  disabled={saving}
                  data-active={preset === frame.id}
                  data-tip={frame.tip}
                  aria-label={frame.tip}
                  onClick={() => {
                    setPreset(frame.id);
                    setCropX(0.5);
                    setCropY(0.5);
                  }}
                >
                  <FrameMark wide={frame.wide} tall={frame.tall} free={frame.free} />
                </button>
              ))}
            </div>
            {saving && <span className="text-xs text-[var(--muted)]">{percent}%</span>}
            {blocked && <span className="text-xs text-[var(--muted)]">{blocked}</span>}
            {!blocked && preset !== "original" && naturalW > 0 && (
              <span className="text-xs text-[var(--muted)]">{frameNote(preset, picture, movable)}</span>
            )}
          </>
        )}
        {!trimming && saving && <span className="text-xs text-[var(--muted)]">{percent}%</span>}
        {!trimming && blocked && <span className="text-xs text-[var(--muted)]">{blocked}</span>}
        <div className="ml-auto flex items-center gap-1">
          <ToolsPlaceButton />
        </div>
      </div>
      <div className="fp-video-stage" ref={stageRef}>
        {!url ? <Empty text="Reading…" /> : (
          <div className={fitted ? "fp-video-fit" : "fp-video-open"} style={fitted ? { left: fitted.x, top: fitted.y, width: fitted.w, height: fitted.h } : undefined}>
            <video
              ref={videoRef}
              src={url}
              controls
              playsInline
              style={fitted ? {
                width: turned ? fitted.h : fitted.w,
                height: turned ? fitted.w : fitted.h,
                transform: `translate(-50%, -50%) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1}) rotate(${quarters * 90}deg)`,
              } : undefined}
              onLoadedMetadata={(event) => {
                const node = event.currentTarget;
                if (node.videoWidth > 0 && node.videoHeight > 0) setPixels({ w: node.videoWidth, h: node.videoHeight });
              }}
              onTimeUpdate={(event) => {
                const video = event.currentTarget;
                if (!info || tailing.current) return;
                let t = video.currentTime * 1000;
                video.muted = castOn.current || mute || !info.hasAudio || t < soundStart - 40 || t >= soundEnd;
                video.volume = soundVol / 100;
                syncExtra(video);
                if (!video.paused && !(startMs <= 80 && endMs >= info.durationMs - 80) && (t >= endMs || t < startMs - 40)) {
                  video.currentTime = startMs / 1000;
                  t = startMs;
                }
                if (!scrubbing.current && !(video.paused && playRef.current > info.durationMs - 80)) {
                  playRef.current = Math.round(t);
                  setPlayMs(playRef.current);
                }
              }}
              onPlay={(event) => {
                setPlaying(true);
                if (castOn.current) castResume();
                songOn.current = false;
                cancelAnimationFrame(songFrame.current);
                setSongPlaying(false);
                if (!info) return;
                if (extraPath && playRef.current >= info.durationMs - 80 && songEdge.current > info.durationMs + 80) {
                  event.currentTarget.pause();
                  startTail(playRef.current);
                  return;
                }
                stopTail();
                syncExtra(event.currentTarget);
              }}
              onPause={(event) => {
                setPlaying(false);
                if (castOn.current && !scrubbing.current && !event.currentTarget.seeking) castPause();
                if (scrubbing.current || tailing.current || songOn.current) return;
                if (info && event.currentTarget.ended && songEdge.current > info.durationMs + 80) return;
                extraAudio.current?.pause();
              }}
              onEnded={() => {
                if (castOn.current) castPause();
                if (!info || scrubbing.current) return;
                if (songEdge.current > info.durationMs + 80) startTail(info.durationMs);
              }}
              onSeeked={(event) => {
                if (castOn.current) castSeek(Math.round(event.currentTarget.currentTime * 1000));
                if (holding.current) {
                  holding.current = false;
                  return;
                }
                if (scrubbing.current || !info) return;
                stopTail();
                const t = Math.round(event.currentTarget.currentTime * 1000);
                const duration = info.durationMs;
                if (!(playRef.current > duration - 80 && event.currentTarget.paused)) {
                  playRef.current = t;
                  setPlayMs(t);
                }
                syncExtra(event.currentTarget);
              }}
              onError={() => setFailed(true)}
            />
            {fitted && trimming && cut && (
              <>
                <div className="fp-shade" style={{ left: 0, top: 0, width: "100%", height: cut.y }} />
                <div className="fp-shade" style={{ left: 0, top: cut.y, width: cut.x, height: cut.h }} />
                <div className="fp-shade" style={{ left: cut.x + cut.w, top: cut.y, right: 0, height: cut.h }} />
                <div className="fp-shade" style={{ left: 0, top: cut.y + cut.h, right: 0, bottom: 0 }} />
                <div className="fp-frame" data-move="true" style={{ left: cut.x, top: cut.y, width: cut.w, height: cut.h }}>
                  {cropDragSlices(cut, fitted.w, fitted.h).map((slice) => (
                    <div key={`${slice.top}-${slice.right}`} className="fp-frame-move" style={{ top: slice.top, height: slice.height, left: slice.left, right: slice.right }} onPointerDown={dragCrop} />
                  ))}
                  {(["n", "e", "w", "s"] as const).filter((edge) => edge !== "s" || cut.y + cut.h < fitted.h - 56).map((edge) => (
                    <div key={edge} className="fp-handle" data-edge={edge} style={edge === "e" || edge === "w" ? { bottom: Math.max(16, cut.y + cut.h - (fitted.h - 48)) } : undefined} onPointerDown={dragCrop} />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {failed && <div className="absolute inset-x-0 bottom-3 text-center text-sm text-[var(--muted)]">This file won't play here. Use Open.</div>}
      </div>
      {trimming && info && info.durationMs > 0 && (
        <div className="fp-time">
          <div className="fp-time-labels">
            <div className="fp-time-label fp-time-ruler-gap">
              <span className="fp-span-label" />
              <span className="fp-span-time">{clock(Math.min(playMs, info.durationMs))}</span>
            </div>
            <div className="fp-time-label">
              <span className="fp-span-label">Video</span>
              <span className="fp-span-time">{clock(startMs)}</span>
            </div>
            <div className="fp-time-label" data-tip={!info.hasAudio ? "This video has no sound" : mute ? "Muted" : undefined} data-tip-pos="top">
              <span className="fp-span-label" data-off={saving || mute || !info.hasAudio ? "true" : undefined}>Sound</span>
              <span className="fp-span-time" data-off={saving || mute || !info.hasAudio ? "true" : undefined}>{clock(soundStart)}</span>
            </div>
          </div>
          <div className="fp-time-scroll" ref={scrollRef} onScroll={() => {
            const inset = insetRef.current;
            const scroll = scrollRef.current;
            if (!inset || !scroll || !info || saving) return;
            const box = scroll.getBoundingClientRect();
            const center = box.left + box.width / 2;
            const rect = inset.getBoundingClientRect();
            const ratio = rect.width > 0 ? Math.min(1, Math.max(0, (center - rect.left) / rect.width)) : 0;
            if (gliding.current) return;
            peekAt(center, ratio * timelineMs);
            window.clearTimeout(thumbTimer.current);
            thumbTimer.current = window.setTimeout(() => { if (!scrubbing.current) setThumb(null); }, 700);
          }}>
            <div className="fp-time-sheet">
              <div className="fp-time-inset" ref={insetRef} onPointerMove={(event) => peekFromPointer(event.clientX)} onPointerLeave={() => { if (!scrubbing.current) setThumb(null); }}>
                <div className="fp-ruler" data-tip="Drag to play from here" data-tip-pos="top" onPointerDown={saving ? undefined : scrubRuler} />
                <div className="fp-time-track">
                  <TimeSpan label="Video" start={startMs} end={endMs} duration={timelineMs} disabled={saving} onSeek={saving ? undefined : scrubTo} onSeekEnd={stopScrub} onChange={moveTrim} />
                </div>
                <div className="fp-time-track">
                  <TimeSpan label="Sound" start={soundStart} end={soundEnd} duration={timelineMs} disabled={saving || mute || !info.hasAudio} onSeek={saving ? undefined : scrubTo} onSeekEnd={stopScrub} onChange={moveSound} />
                </div>
                <div className="fp-playmark" style={{ left: `${head}%` }} />
                <div className="fp-playline" style={{ left: `${head}%` }} />
              </div>
            </div>
          </div>
          <div className="fp-time-sides">
            <div className="fp-time-side fp-time-ruler-gap">
              <span className="fp-span-time">{clock(timelineMs)}</span>
              <span />
            </div>
            <div className="fp-time-side">
              <span className="fp-span-time">{clock(endMs)}</span>
              <span className="fp-span-side" />
            </div>
            <div className="fp-time-side">
              <span className="fp-span-time" data-off={saving || mute || !info.hasAudio ? "true" : undefined}>{clock(soundEnd)}</span>
              <span className="fp-span-side">
                <button type="button" className="tb-btn" disabled={saving || !info.hasAudio} data-active={mute} data-tip={mute ? "Keep the sound" : "Mute"} onClick={() => setMute((value) => !value)}>
                  {mute ? <VolumeX /> : <Volume2 />}
                </button>
                <Volume value={soundVol} disabled={saving || mute || !info.hasAudio} onChange={setSoundVol} />
                {extraPath ? <span className="fp-slot" /> : (
                  <button type="button" className="tb-btn" disabled={saving} data-tip="Add a sound" onClick={() => { setDraftPath(""); setSoundOpen(true); }}>
                    <Plus />
                  </button>
                )}
              </span>
            </div>
          </div>
          {extraPath && (
            <div className="fp-song-label" data-tip="Play, then pause. The marker stays, so you can drag the selection to it." data-tip-pos="top">
              <button type="button" className="tb-btn" disabled={saving || extraDur < 1} data-tip={songPlaying ? "Stop the song" : "Play the song"} data-tip-pos="top" onClick={toggleSong}>
                {songPlaying ? <Pause /> : <Play />}
              </button>
              <span className="fp-span-label">{baseName(extraPath)}</span>
              <span className="fp-span-time">{clock(songHeld ? songMs : extraStart)}</span>
            </div>
          )}
          {extraPath && (
            <div className="fp-song-track">
              <TimeSpan label={baseName(extraPath)} start={extraStart} end={extraEnd} duration={Math.max(1, songFile)} disabled={saving || extraDur < 1} onSeek={saving ? undefined : scrubSong} onSeekEnd={stopSongScrub} onMove={slideSong} onChange={trimSong} />
              {songMark !== null && <div className="fp-playline fp-songline" style={{ left: `${songMark}%` }} />}
            </div>
          )}
          {extraPath && (
            <div className="fp-time-side fp-song-side">
              <span className="fp-span-time">{clock(extraEnd)}</span>
              <span className="fp-span-side">
                <button type="button" className="tb-btn" disabled={saving || extraDur < 1} data-active={matched} data-tip={matchedFit ? "Unlock the length" : "Match the video length"} onClick={matchVideo}>
                  <FoldHorizontal />
                </button>
                <Volume value={extraVol} disabled={saving} onChange={setExtraVol} />
                <button type="button" className="tb-btn" disabled={saving} data-tip="Remove this sound" onClick={() => setExtraPath(null)}>
                  <X />
                </button>
              </span>
            </div>
          )}
        </div>
      )}
      <div className="fp-thumb" data-on={thumb ? "true" : undefined} style={thumb ? { left: thumb.left, top: thumb.top } : undefined}>
        <video ref={thumbVideo} src={url ?? undefined} muted playsInline preload="auto" />
        <span>{clock(thumb?.ms ?? playMs)}</span>
      </div>
      {soundOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 p-6" onMouseDown={() => setSoundOpen(false)}>
          <div className="fp-float w-full max-w-md border border-[var(--border)] bg-[var(--surface)] p-4" onMouseDown={(event) => event.stopPropagation()}>
            <h2 className="text-base font-semibold">Add sound</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">The bar under the video is the whole song. Drag the block to choose a part, then match it to the video.</p>
            <div className="mt-3 flex gap-2">
              <input className="field min-w-0 flex-1" value={draftPath} placeholder="Sound file" onChange={(event) => setDraftPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addSound(); }} />
              <button type="button" className="btn" onClick={chooseSound}>Browse</button>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setSoundOpen(false)}>Cancel</button>
              <button type="button" className="btn primary" onClick={addSound}>Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MediaView({ preview }: { preview: PreviewFile }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const dvd = preview.extension === "vob";
  const castOn = useRef(false);
  useEffect(() => {
    const node = preview.kind === "video" ? videoRef.current : audioRef.current;
    if (!node) return;
    const unwatch = watchCast((on) => {
      castOn.current = on;
      node.muted = on;
    });
    const play = () => { if (castOn.current) castResume(); };
    const pause = () => { if (castOn.current && !node.seeking) castPause(); };
    const seeked = () => { if (castOn.current) castSeek(Math.round(node.currentTime * 1000)); };
    node.addEventListener("play", play);
    node.addEventListener("pause", pause);
    node.addEventListener("seeked", seeked);
    node.addEventListener("ended", pause);
    return () => {
      unwatch();
      node.removeEventListener("play", play);
      node.removeEventListener("pause", pause);
      node.removeEventListener("seeked", seeked);
      node.removeEventListener("ended", pause);
    };
  }, [preview.kind, url]);
  useEffect(() => {
    if (dvd) return;
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
  }, [dvd, preview.path, preview.dataBase64, preview.kind, preview.extension]);
  if (dvd) return <Empty text="DVD video (MPEG-2). Use Open to play it." />;
  if (!url && !preview.posterBase64) return <Empty text="Reading…" />;
  return (
    <div className="fp-media">
      {preview.kind === "audio" && preview.posterBase64 && (
        <img className="fp-cover" alt="" src={`data:${preview.posterMime || "image/jpeg"};base64,${preview.posterBase64}`} />
      )}
      {url && (preview.kind === "video"
        ? <video ref={videoRef} src={url} controls onError={() => setFailed(true)} />
        : <audio ref={audioRef} src={url} controls onError={() => setFailed(true)} />)}
      {failed && <div className="text-center text-sm text-[var(--muted)]">This file won't play here. Use Open.</div>}
    </div>
  );
}

function ZipView({ path, source }: { path: string; source: Side }) {
  const target = path.startsWith("zip:") ? path : `zip:${path}|`;
  const archive = path.startsWith("zip:") ? undefined : path;
  return <ListingView listPath={target} source={source} archive={archive} noun="inside the zip" />;
}

function GzView({ path, source }: { path: string; source: Side }) {
  const target = path.startsWith("gz:") ? path : `gz:${path}|`;
  const archive = path.startsWith("gz:") ? undefined : path;
  return <ListingView listPath={target} source={source} archive={archive} noun="inside the archive" />;
}

type SlideRun = { text: string; size: number; bold: boolean; color: string };
type SlidePara = { align: string; runs: SlideRun[] };
type SlideCell = { fill?: string | null; paragraphs: SlidePara[] };
type SlideRow = { height: number; cells: SlideCell[] };
type SlideShape = { x: number; y: number; w: number; h: number; fill?: string | null; kind: string; paragraphs?: SlidePara[]; image?: string | null; columns?: number[]; rows?: SlideRow[] };
type SlideFrame = { background: string; shapes: SlideShape[]; image?: string };
type SlidePage = { width: number; height: number; count: number; index: number; slide?: SlideFrame; image?: string };

function frameOf(page: SlidePage): SlideFrame | null {
  if (page.image) return { background: "#fff", shapes: [], image: page.image };
  return page.slide ?? null;
}

function readPage(text: string): SlidePage | null {
  try {
    const parsed = JSON.parse(text) as SlidePage;
    if (!parsed.width || !parsed.height || !parsed.count || !frameOf(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function SlideView({ path, text }: { path: string; text: string }) {
  const page = useMemo(() => readPage(text), [text]);
  const cache = useRef(new Map<number, SlideFrame>());
  if (page) {
    const frame = frameOf(page);
    if (frame) cache.current.set(page.index, frame);
  }
  const [index, setIndex] = useState(page?.index ?? 0);
  const [slide, setSlide] = useState<SlideFrame | null>(page ? frameOf(page) : null);
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const width = page?.width ?? 1;
  const height = page?.height ?? 1;
  const count = page?.count ?? 0;
  useEffect(() => {
    if (!page) return;
    const cached = cache.current.get(index);
    if (cached) {
      setSlide(cached);
      return;
    }
    let cancel = false;
    void invoke<string>("preview_slide", { path, index })
      .then((raw) => {
        if (cancel) return;
        const next = readPage(raw);
        const frame = next && frameOf(next);
        if (!next || !frame) return;
        cache.current.set(index, frame);
        setSlide(frame);
      })
      .catch((reason: unknown) => {
        if (!cancel) toast("error", message(reason));
      });
    return () => {
      cancel = true;
    };
  }, [index, path, page]);
  useLayoutEffect(() => {
    const node = host.current;
    if (!node || !page) return;
    const fit = () => {
      const sx = Math.max(0, node.clientWidth - 28) / width;
      const sy = Math.max(0, node.clientHeight - 28) / height;
      setScale(Math.max(0.05, Math.min(sx, sy)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [page, width, height]);
  if (!page || !slide) return <Empty text="Can't read that presentation." />;
  const show = (next: number) => setIndex(Math.min(count - 1, Math.max(0, next)));
  return (
    <div
      className="fp-slides"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowDown" && event.key !== "ArrowLeft" && event.key !== "ArrowUp") return;
        event.preventDefault();
        event.stopPropagation();
        show(index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1));
      }}
    >
      <div ref={host} className="fp-slide-stage">
        <div className="fp-slide-scale" style={{ width: width * scale, height: height * scale }}>
          <div className="fp-slide" style={{ width, height, transform: `scale(${scale})`, background: slide.background || "#fff" }}>
            {slide.image ? <img className="fp-slide-raster" alt="" src={slide.image} /> : slide.shapes.map((shape, shapeIndex) => <SlideShapeView key={shapeIndex} shape={shape} />)}
          </div>
        </div>
      </div>
      <div className="fp-slide-bar">
        <button className="tb-btn" data-tip="Previous slide" disabled={index <= 0} onClick={() => show(index - 1)}><ChevronLeft /></button>
        <span>Slide {index + 1} of {count}</span>
        <button className="tb-btn" data-tip="Next slide" disabled={index >= count - 1} onClick={() => show(index + 1)}><ChevronRight /></button>
      </div>
    </div>
  );
}

function SlideShapeView({ shape }: { shape: SlideShape }) {
  return (
    <div className="fp-slide-shape" style={{ left: shape.x, top: shape.y, width: shape.w, height: shape.h, background: shape.fill || undefined }}>
      {shape.image && <img alt="" src={shape.image} />}
      {shape.kind === "chart" && <div className="fp-slide-note">Chart</div>}
      {shape.kind === "table" && shape.rows && shape.rows.length > 0 && (
        <table>
          {shape.columns && shape.columns.length > 0 && (
            <colgroup>
              {shape.columns.map((column, columnIndex) => <col key={columnIndex} style={{ width: column }} />)}
            </colgroup>
          )}
          <tbody>
            {shape.rows.map((row, rowIndex) => (
              <tr key={rowIndex} style={{ height: row.height || undefined }}>
                {row.cells.map((cell, cellIndex) => (
                  <td key={cellIndex} style={{ background: cell.fill || undefined }}>
                    <SlideText paragraphs={cell.paragraphs} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {shape.kind !== "table" && shape.paragraphs && shape.paragraphs.length > 0 && <SlideText paragraphs={shape.paragraphs} />}
    </div>
  );
}

function SlideText({ paragraphs }: { paragraphs: SlidePara[] }) {
  return (
    <div className="fp-slide-text">
      {paragraphs.map((para, index) => (
        <p key={index} style={{ textAlign: para.align as "left" | "center" | "right" | "justify" }}>
          {para.runs.map((run, runIndex) => (
            <span key={runIndex} style={{ fontSize: run.size, fontWeight: run.bold ? 700 : 400, color: run.color }}>{run.text}</span>
          ))}
        </p>
      ))}
    </div>
  );
}

function DocumentView({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="h-full overflow-auto">
      <div className="fp-doc">
        {lines.map((line, index) => <p key={index}>{line}</p>)}
      </div>
    </div>
  );
}

function ListingView({ listPath, source, archive, noun = "in this folder" }: { listPath: string; source: Side; archive?: string; noun?: string }) {
  const navigate = useApp((state) => state.navigate);
  const showHidden = useApp((state) => state.showHidden);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drag = useColumnDrag();
  useEffect(() => {
    let cancel = false;
    let settled = false;
    const id = takeListId();
    let unlisten: (() => void) | undefined;
    setEntries(null);
    setError(null);
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancel) return;
      unlisten = await listen<ListBatch>("list-batch", (event) => {
        const batch = event.payload;
        if (cancel || settled || batch.id !== id) return;
        setEntries((current) => (batch.seq === 0 ? batch.entries : [...(current ?? []), ...batch.entries]));
      });
      if (cancel) {
        unlisten();
        return;
      }
      try {
        const listing = await invoke<DirListing>("list_dir", { path: listPath, id });
        settled = true;
        if (!cancel) setEntries(listing.entries);
      } catch (reason: unknown) {
        if (!cancel && message(reason) !== "cancelled") setError(message(reason));
      }
    })();
    return () => {
      cancel = true;
      unlisten?.();
      void invoke("cancel_list", { id });
    };
  }, [listPath]);
  if (error) return <Empty text={error} />;
  if (!entries) return <Empty text="Reading…" />;
  const visible = entries.filter((entry) => showHidden || !entry.hidden).sort((left, right) => Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name));
  const shown = visible.slice(0, 500);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="fp-tools">
        <button className="tb-btn" data-tip="Browse" onClick={() => void navigate(source, listPath)}><FolderSearch /></button>
        {archive && <button className="tb-btn" data-tip="Extract" onClick={() => void useApp.getState().extractSelection([archive])}><FolderOutput /></button>}
        <span className="text-xs text-[var(--muted)]">{visible.length} items {noun}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className={drag.widths ? "fp-table fp-listing fp-cols" : "fp-table fp-listing"} onPointerDown={drag.onPointerDown} onPointerMove={drag.onPointerMove}>
          <colgroup>
            {(drag.widths ?? [0, 88, 148, 88]).map((width, index) => <col key={index} style={width ? { width } : undefined} />)}
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th>Size</th>
              <th>Modified</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.path}>
                <td>{entry.name}</td>
                <td>{entry.isDir ? "" : formatBytes(entry.size)}</td>
                <td>{formatWhen(entry.modified)}</td>
                <td>{typeLabel(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <div className="px-3 py-6 text-center text-sm text-[var(--muted)]">Nothing inside.</div>}
        {entries.length > shown.length && <div className="px-3 py-2 text-xs text-[var(--muted)]">Showing the first {shown.length} items. Browse to see the rest.</div>}
      </div>
    </div>
  );
}

const audioMime: Record<string, string> = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac" };
const videoMime: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mkv: "video/x-matroska" };

function CsvTable({ text, delimiter, truncated }: { text: string; delimiter: string; truncated: boolean }) {
  const rows = parseTable(text, delimiter);
  return <Table rows={rows} truncated={truncated} />;
}

function Table({ rows, truncated = false }: { rows: string[][]; truncated?: boolean }) {
  const shown = rows.slice(0, 200);
  const width = Math.min(20, shown.reduce((max, row) => Math.max(max, row.length), 0));
  const drag = useColumnDrag();
  return (
    <div className="h-full overflow-auto">
      <table className={drag.widths ? "fp-table fp-cols" : "fp-table"} onPointerDown={drag.onPointerDown} onPointerMove={drag.onPointerMove}>
        {drag.widths && <colgroup>{drag.widths.map((column, index) => <col key={index} style={{ width: column }} />)}</colgroup>}
        <tbody>
          {shown.map((row, index) => (
            <tr key={index}>
              {Array.from({ length: width }, (_, cell) => <td key={cell}>{row[cell] ?? ""}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && <div className="px-3 py-2 text-xs text-[var(--muted)]">Showing the first {shown.length} rows.</div>}
      {truncated && <div className="px-3 py-2 text-xs text-[var(--muted)]">Preview stopped at 8 MB</div>}
    </div>
  );
}

function PdfView({ data, path }: { data: string | null; path: string }) {
  const [urls, setUrls] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const source = data
          ? { data: decodeBase64(data) }
          : { url: (await import("@tauri-apps/api/core")).convertFileSrc(path), disableRange: true, disableStream: true };
        const pdf = await pdfjs.getDocument(source).promise;
        const pages: string[] = [];
        const count = Math.min(pdf.numPages, 12);
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
        if (!cancel) {
          setMore(pdf.numPages > count);
          setUrls(pages);
        }
      } catch (reason) {
        if (!cancel) setError(message(reason));
      }
    })();
    return () => {
      cancel = true;
    };
  }, [data, path]);
  if (error) return <Empty text={error} />;
  if (!urls.length) return <Empty text="Reading…" />;
  return (
    <div className="flex flex-col items-center gap-3 p-3">
      {urls.map((url) => <img key={url} src={url} alt="" className="max-w-full shadow" />)}
      {more && <div className="text-xs text-[var(--muted)]">Showing the first {urls.length} pages.</div>}
    </div>
  );
}

function localAsset(filePath: string, url: string): string | null {
  const value = url.trim();
  if (!value || /^(#|https?:|data:|blob:|mailto:|file:|javascript:)/i.test(value)) return null;
  const hashAt = value.indexOf("#");
  const hash = hashAt >= 0 ? value.slice(hashAt) : "";
  const before = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const queryAt = before.indexOf("?");
  const query = queryAt >= 0 ? before.slice(queryAt) : "";
  const rel = queryAt >= 0 ? before.slice(0, queryAt) : before;
  if (!rel) return null;
  let absolute = rel;
  if (!/^[a-zA-Z]:[\\/]/.test(rel) && !rel.startsWith("\\\\") && !rel.startsWith("/")) {
    const folder = filePath.replace(/[/\\][^/\\]*$/, "");
    const base = folder.split(/[/\\]/).filter((part) => part.length > 0);
    for (const part of rel.split(/[/\\]/)) {
      if (part === "" || part === ".") continue;
      if (part === "..") base.pop();
      else base.push(part);
    }
    absolute = folder.includes("\\") ? base.join("\\") : `/${base.join("/")}`;
  }
  return `${absolute}${query}${hash}`;
}

function HtmlView({ text, path, truncated }: { text: string; path: string; truncated: boolean }) {
  const [src, setSrc] = useState(text);
  useEffect(() => {
    let cancel = false;
    void (async () => {
      const doc = new DOMParser().parseFromString(text, "text/html");
      doc.querySelectorAll("script").forEach((node) => node.remove());
      let convert: ((file: string) => string) | null = null;
      if (inTauri()) {
        try {
          convert = (await import("@tauri-apps/api/core")).convertFileSrc;
        } catch {
          convert = null;
        }
      }
      const rewrite = (url: string) => {
        const file = localAsset(path, url);
        if (!file || !convert) return url;
        const hashAt = file.indexOf("#");
        const queryAt = file.indexOf("?");
        const cut = [hashAt, queryAt].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? file.length;
        return `${convert(file.slice(0, cut))}${file.slice(cut)}`;
      };
      for (const el of doc.querySelectorAll("[src], [href]")) {
        for (const attr of ["src", "href"]) {
          const raw = el.getAttribute(attr);
          if (!raw) continue;
          const next = rewrite(raw);
          if (next !== raw) el.setAttribute(attr, next);
        }
      }
      if (convert) {
        const sheets = [...doc.querySelectorAll('link[rel~="stylesheet"][href]')];
        await Promise.all(sheets.map(async (link) => {
          const href = link.getAttribute("href");
          if (!href) return;
          try {
            const css = await fetch(href).then((response) => response.ok ? response.text() : "");
            if (!css || cancel) return;
            const style = doc.createElement("style");
            style.textContent = css;
            link.replaceWith(style);
          } catch { /* the page still shows without that sheet */ }
        }));
      }
      if (!cancel) setSrc(`<!DOCTYPE html>${doc.documentElement.outerHTML}`);
    })();
    return () => {
      cancel = true;
    };
  }, [text, path]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {truncated && <div className="shrink-0 border-b border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)]">Only the start of this file is shown.</div>}
      <iframe className="fp-html" sandbox="" title="HTML preview" srcDoc={src} />
    </div>
  );
}

function DocxView({ data }: { data: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const node = host.current;
    if (!node || !html) return;
    return bindColumnResize(node);
  }, [html]);
  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const mammoth = await import("mammoth");
        const bytes = decodeBase64(data);
        const copy = new Uint8Array(bytes);
        const result = await mammoth.convertToHtml({ arrayBuffer: copy.buffer }, { ignoreEmptyParagraphs: false });
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
  return <div ref={host} className="fp-doc" dangerouslySetInnerHTML={{ __html: html }} />;
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

const COLUMN_EDGE = 6;

function columnEdge(event: PointerEvent): { index: number } | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const cell = target.closest("td, th");
  const table = cell?.closest("table");
  if (!(cell instanceof HTMLTableCellElement) || !(table instanceof HTMLTableElement)) return null;
  if (table.closest(".fp-slide")) return null;
  const rect = cell.getBoundingClientRect();
  if (event.clientX >= rect.right - COLUMN_EDGE) return { index: cell.cellIndex };
  if (event.clientX <= rect.left + COLUMN_EDGE && cell.cellIndex > 0) return { index: cell.cellIndex - 1 };
  return null;
}

function measureColumns(table: HTMLTableElement): number[] {
  const row = [...table.rows].find((item) => item.cells.length);
  if (!row) return [];
  return [...row.cells].map((cell) => Math.max(48, Math.round(cell.getBoundingClientRect().width)));
}

function useColumnDrag() {
  const [widths, setWidths] = useState<number[] | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLTableElement>) => {
    if (event.button !== 0) return;
    const hit = columnEdge(event.nativeEvent);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    const base = widths ?? measureColumns(event.currentTarget);
    const startW = base[hit.index] ?? 96;
    const startX = event.clientX;
    const index = hit.index;
    const move = (ev: PointerEvent) => {
      const next = base.slice();
      next[index] = Math.max(48, Math.round(startW + ev.clientX - startX));
      setWidths(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("fp-col-resize");
    };
    document.body.classList.add("fp-col-resize");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLTableElement>) => {
    if (document.body.classList.contains("fp-col-resize")) return;
    event.currentTarget.style.cursor = columnEdge(event.nativeEvent) ? "col-resize" : "";
  };
  return { widths, onPointerDown, onPointerMove };
}

function bindColumnResize(root: HTMLElement) {
  let drag: { index: number; startX: number; startW: number; widths: number[]; table: HTMLTableElement } | null = null;
  let hot: HTMLElement | null = null;
  const move = (event: PointerEvent) => {
    if (drag) {
      const next = drag.widths.slice();
      next[drag.index] = Math.max(48, Math.round(drag.startW + event.clientX - drag.startX));
      drag.widths = next;
      applyColumnWidths(drag.table, next);
      return;
    }
    const hit = columnEdge(event);
    const cell = event.target instanceof Element ? event.target.closest("td, th") : null;
    if (hot && hot !== cell) hot.style.cursor = "";
    hot = cell instanceof HTMLElement ? cell : null;
    if (hot) hot.style.cursor = hit ? "col-resize" : "";
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || drag) return;
    const hit = columnEdge(event);
    const table = event.target instanceof Element ? event.target.closest("table") : null;
    if (!hit || !(table instanceof HTMLTableElement) || !root.contains(table)) return;
    event.preventDefault();
    const widths = columnWidths(table);
    drag = { index: hit.index, startX: event.clientX, startW: widths[hit.index] ?? 96, widths, table };
    document.body.classList.add("fp-col-resize");
  };
  const up = () => {
    drag = null;
    document.body.classList.remove("fp-col-resize");
  };
  root.addEventListener("pointermove", move);
  root.addEventListener("pointerdown", down);
  window.addEventListener("pointerup", up);
  return () => {
    root.removeEventListener("pointermove", move);
    root.removeEventListener("pointerdown", down);
    window.removeEventListener("pointerup", up);
    document.body.classList.remove("fp-col-resize");
    if (hot) hot.style.cursor = "";
  };
}

function columnWidths(table: HTMLTableElement): number[] {
  const cols = [...table.querySelectorAll(":scope > colgroup > col")];
  if (cols.length) return cols.map((col) => Math.round(col.getBoundingClientRect().width) || 96);
  return measureColumns(table);
}

function applyColumnWidths(table: HTMLTableElement, widths: number[]) {
  let group = table.querySelector(":scope > colgroup");
  if (!group) {
    group = document.createElement("colgroup");
    table.insertBefore(group, table.firstChild);
  }
  while (group.children.length < widths.length) group.appendChild(document.createElement("col"));
  widths.forEach((width, index) => {
    (group.children[index] as HTMLElement).style.width = `${width}px`;
  });
  table.classList.add("fp-cols");
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

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12.04 2C6.58 2 2.15 6.4 2.15 11.83c0 1.74.46 3.44 1.34 4.94L2 22l5.39-1.41a10 10 0 0 0 4.65 1.18h.01c5.46 0 9.89-4.4 9.89-9.83C21.94 6.4 17.5 2 12.04 2zm0 17.95h-.01a8.2 8.2 0 0 1-4.18-1.15l-.3-.18-3.2.84.85-3.12-.2-.32a8.15 8.15 0 0 1-1.25-4.35c0-4.51 3.69-8.18 8.23-8.18 2.2 0 4.26.85 5.81 2.4a8.14 8.14 0 0 1 2.4 5.8c0 4.51-3.69 8.18-8.15 8.18zm4.5-6.12c-.25-.12-1.46-.72-1.68-.8-.23-.08-.39-.12-.56.12-.16.25-.64.8-.78.96-.14.17-.29.19-.54.06-.25-.12-1.05-.39-2-1.23-.74-.66-1.24-1.47-1.38-1.72-.14-.25-.02-.38.11-.5.11-.11.25-.29.37-.43.13-.14.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.42h-.48c-.17 0-.43.06-.66.31-.23.25-.87.85-.87 2.07s.89 2.4 1.01 2.56c.13.17 1.75 2.67 4.24 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.46-.6 1.67-1.18.21-.58.21-1.07.14-1.18-.06-.1-.23-.16-.48-.28z" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4.98 3.5C4.98 4.88 3.88 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1 4.98 2.12 4.98 3.5zM.5 8.5h4V24h-4V8.5zM8.5 8.5h3.83v2.12h.05c.53-1.01 1.84-2.07 3.79-2.07 4.05 0 4.8 2.67 4.8 6.14V24h-4v-7.71c0-1.84-.03-4.2-2.56-4.2-2.56 0-2.95 2-2.95 4.06V24h-4V8.5z" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.725-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

function InstagramIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zm5 4.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6zM12 9.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6zm5.35-2.05a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3z" />
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M14.5 8.5V6.4c0-.7.5-1.1 1.2-1.1H17V3h-2.1C12.2 3 11 4.4 11 6.6v1.9H9v2.6h2V21h3.1v-9.9h2.3l.4-2.6h-2.7z" />
    </svg>
  );
}

function TikTokIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M14.2 3c.4 2.4 1.7 4.1 4 4.6v2.6c-1.4 0-2.7-.4-4-1.2v6.4c0 3.4-2.6 6.1-6.1 6.1S2 18.8 2 15.4c0-3.3 2.5-5.9 5.7-6.1v2.7c-1.5.2-2.6 1.5-2.6 3.1 0 1.7 1.4 3.1 3.1 3.1s3.1-1.4 3.1-3.1V3h2.9z" />
    </svg>
  );
}

function YouTubeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M23 12.2s0-3.2-.4-4.6c-.2-.9-.9-1.6-1.8-1.8C19.2 5.4 12 5.4 12 5.4s-7.2 0-8.8.4c-.9.2-1.6.9-1.8 1.8C1 9 1 12.2 1 12.2s0 3.2.4 4.6c.2.9.9 1.6 1.8 1.8 1.6.4 8.8.4 8.8.4s7.2 0 8.8-.4c.9-.2 1.6-.9 1.8-1.8.4-1.4.4-4.6.4-4.6zM9.8 15.5v-6.6l6.2 3.3-6.2 3.3z" />
    </svg>
  );
}
