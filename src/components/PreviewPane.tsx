import DOMPurify from "dompurify";
import { ChevronLeft, ChevronRight, ClipboardCopy, Crop, FileText, FlipHorizontal, FlipVertical, FolderOpen, FolderOutput, FolderSearch, Mail, Printer, Replace, RotateCcw, RotateCw, Save, Share2, Table2 } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { baseName, formatBytes, formatWhen, isPackedPath, typeLabel } from "../lib/format";
import { fileRows, treeRows } from "../lib/rows";
import { inTauri, invoke, message, openExternal } from "../lib/platform";
import { CodeView } from "./CodeView";
import { Dropdown, MenuItem } from "./Menu";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";
import type { DirListing, Entry, PreviewFile, Side, ThemeMode } from "../types";

const imageMime: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
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
  const file = row && !row.up && !row.isDir ? row : null;
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [tableOn, setTableOn] = useState(true);
  const filePath = file?.path ?? "";
  const [tablePath, setTablePath] = useState(filePath);
  if (tablePath !== filePath) {
    setTablePath(filePath);
    setTableOn(true);
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-2">
        <span className="min-w-0 flex-1 truncate">{file ? file.name : row?.name ?? "Preview"}</span>
        {file && <span className="text-xs text-[var(--muted)]">{formatBytes(file.size)}</span>}
        {preview?.kind === "csv" && (
          <div className="seg" role="tablist" aria-label="CSV view">
            <button data-active={!tableOn} data-tip="Text" onClick={() => setTableOn(false)}><FileText />Text</button>
            <button data-active={tableOn} data-tip="Table" onClick={() => setTableOn(true)}><Table2 />Table</button>
          </div>
        )}
        {file && <PreviewActions path={file.path} extension={file.extension} />}
        {file && <button className="tb-btn" data-tip="Open" onClick={() => void openExternal(file.path).catch((reason: unknown) => toast("error", message(reason)))}><FolderOpen /></button>}
        {file && textpad && (preview?.kind === "text" || preview?.kind === "csv") && (
          <button className="btn sm" onClick={() => void openInTextpad()}>TextPad</button>
        )}
      </div>
      <div className={`min-h-0 min-w-0 flex-1 ${preview?.kind === "slides" ? "overflow-hidden" : "overflow-auto"}`}>
        {treeRow && <ListingView listPath={treeRow.path} source={source} />}
        {!treeRow && !row && <Empty text="Select a file in the other panel." />}
        {!treeRow && row?.up && <Empty text="Parent folder" />}
        {!treeRow && row?.isDir && !row.up && <ListingView listPath={row.path} source={source} />}
        {file && loading && <Empty text="Reading…" />}
        {file && error && <Empty text={error} />}
        {file && !loading && preview && <Body preview={preview} source={source} theme={theme} tableOn={tableOn} onSaved={() => setTick((value) => value + 1)} />}
      </div>
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
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico", "svg", "heic", "heif"].includes(ext)) return "image";
  if (["mp4", "m4v", "webm", "ogv", "mov", "mkv"].includes(ext)) return "video";
  return "";
}

function Empty({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center px-6 text-center text-[var(--muted)]">{text}</div>;
}

function Body({ preview, source, theme, tableOn, onSaved }: { preview: PreviewFile; source: Side; theme: ThemeMode; tableOn: boolean; onSaved: () => void }) {
  if (preview.kind === "image" && preview.dataBase64) return <ImageView key={preview.path} preview={preview} source={source} onSaved={onSaved} />;
  if (preview.kind === "audio" || preview.kind === "video") return <MediaView preview={preview} />;
  if (preview.kind === "zip") return <ZipView path={preview.path} source={source} />;
  if (preview.kind === "gz") return <GzView path={preview.path} source={source} />;
  if (preview.kind === "slides" && preview.text !== null) return <SlideView key={preview.path} path={preview.path} text={preview.text} />;
  if (preview.kind === "document" && preview.text !== null) return <DocumentView text={preview.text} />;
  if (preview.kind === "text" && preview.text !== null) {
    return <CodeView text={preview.text} extension={preview.extension} truncated={preview.truncated} theme={theme} />;
  }
  if (preview.kind === "csv" && preview.text !== null) {
    if (!tableOn) return <CodeView text={preview.text} extension={preview.extension} truncated={preview.truncated} theme={theme} />;
    return <CsvTable text={preview.text} delimiter={preview.extension === "tsv" ? "\t" : ","} truncated={preview.truncated} />;
  }
  if (preview.kind === "pdf" && (preview.dataBase64 || !isPackedPath(preview.path))) return <PdfView data={preview.dataBase64} path={preview.path} />;
  if (preview.kind === "docx" && preview.dataBase64) return <DocxView data={preview.dataBase64} />;
  if (preview.kind === "xlsx" && preview.dataBase64) return <XlsxView data={preview.dataBase64} />;
  if (preview.kind === "too-large") return <Empty text={`${preview.name} is ${formatBytes(preview.size)}. It is too large to preview.`} />;
  return <Empty text={`${preview.name} can't be previewed. Use Open to view it in another app.`} />;
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

function stillFormat(extension: string): string {
  const ext = extension.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext === "png" || ext === "webp" || ext === "bmp" || ext === "gif") return ext;
  return "jpg";
}

function ImageView({ preview, source, onSaved }: { preview: PreviewFile; source: Side; onSaved: () => void }) {
  const [quarters, setQuarters] = useState(0);
  const [flipH, setFlipH] = useState(false);
  const [flipV, setFlipV] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tool, setTool] = useState<"" | "convert" | "trim">("");
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
  const [box, setBox] = useState({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const cropRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);
  const focused = useRef(false);
  const dirty = quarters !== 0 || flipH || flipV;
  const svg = preview.extension === "svg";
  const zipped = isPackedPath(preview.path);
  const mime = preview.mime || imageMime[preview.extension] || "image/jpeg";
  const turned = quarters % 2 === 1;
  const orientedW = turned ? preview.height : preview.width;
  const orientedH = turned ? preview.width : preview.height;
  const canEdit = !svg && !zipped && orientedW > 0 && orientedH > 0;
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
    if (tool !== "trim") return;
    const node = stageRef.current;
    if (!node || !outW || !outH) return;
    const fit = () => {
      const maxW = Math.max(1, node.clientWidth - 24);
      const maxH = Math.max(1, Math.min(node.clientHeight - 24, window.innerHeight * 0.7));
      const aspect = outW / outH;
      let w = maxW;
      let h = w / aspect;
      if (h > maxH) {
        h = maxH;
        w = h * aspect;
      }
      const next = { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
      setBox((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, [tool, outW, outH]);

  useEffect(() => {
    if (tool !== "trim") {
      focused.current = false;
      return;
    }
    if (focused.current || !cropRef.current) return;
    cropRef.current.focus();
    focused.current = true;
  }, [tool, box.w, box.h]);

  useEffect(() => {
    const node = stageRef.current;
    if (!node || tool !== "trim") return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const frame = cropRef.current?.getBoundingClientRect();
      if (!frame?.width || !frame.height || !orientedW || !orientedH) return;
      const current = view.current;
      if (!current.outW || !current.outH || !current.scale) return;
      const min = Math.min(1, current.outW / orientedW, current.outH / orientedH);
      const nextScale = Math.min(8, Math.max(min, current.scale * Math.exp(-event.deltaY * 0.0015)));
      const px = Math.min(Math.max(event.clientX - frame.left, 0), frame.width);
      const py = Math.min(Math.max(event.clientY - frame.top, 0), frame.height);
      const currentViewW = current.outW / current.scale;
      const currentViewH = current.outH / current.scale;
      const srcX = current.originX + (px / frame.width) * currentViewW;
      const srcY = current.originY + (py / frame.height) * currentViewH;
      const nextViewW = current.outW / nextScale;
      const nextViewH = current.outH / nextScale;
      const next = clampOrigin(srcX - (px / frame.width) * nextViewW, srcY - (py / frame.height) * nextViewH, nextViewW, nextViewH, orientedW, orientedH);
      setScale(nextScale);
      setOriginX(next.x);
      setOriginY(next.y);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [tool, orientedW, orientedH]);

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
    applySize(axis, n);
  };

  const nudge = (dx: number, dy: number) => {
    if (!viewW || !viewH) return;
    const stepX = dx / scale;
    const stepY = dy / scale;
    const next = clampOrigin(originX - stepX, originY - stepY, viewW, viewH, orientedW, orientedH);
    setOriginX(next.x);
    setOriginY(next.y);
  };

  const dragPicture = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height || !viewW || !viewH) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startOriginX = originX;
    const startOriginY = originY;
    const target = event.currentTarget;
    target.focus();
    target.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const next = clampOrigin(
        startOriginX - ((ev.clientX - startX) / rect.width) * viewW,
        startOriginY - ((ev.clientY - startY) / rect.height) * viewH,
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
      quarters,
      flipH,
      flipV,
    })
      .then((saved) => {
        toast("success", `Saved ${baseName(saved)}.`);
        void useApp.getState().refresh(source);
      })
      .catch((reason: unknown) => toast("error", message(reason)))
      .finally(() => setSavingTrim(false));
  };

  const screenPerSource = viewW > 0 ? box.w / viewW : 0;
  const imgScreenW = orientedW * screenPerSource;
  const imgScreenH = orientedH * (viewH > 0 ? box.h / viewH : 0);
  const imgLeft = -originX * screenPerSource;
  const imgTop = -originY * (viewH > 0 ? box.h / viewH : 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="fp-tools">
        <button className="tb-btn" data-tip="Rotate left" onClick={() => setQuarters((value) => (value + 3) % 4)}><RotateCcw /></button>
        <button className="tb-btn" data-tip="Rotate right" onClick={() => setQuarters((value) => (value + 1) % 4)}><RotateCw /></button>
        <button className="tb-btn" data-tip="Mirror" onClick={() => setFlipH((value) => !value)}><FlipHorizontal /></button>
        <button className="tb-btn" data-tip="Flip" onClick={() => setFlipV((value) => !value)}><FlipVertical /></button>
        <button
          className="tb-btn"
          disabled={!dirty || saving || svg || zipped}
          data-tip={svg ? "SVG pictures stay as they are." : zipped ? "Copy the picture out of the archive before saving a change." : saving ? "Saving…" : "Save the picture"}
          style={dirty && !saving && !svg && !zipped ? { color: "var(--accent)" } : undefined}
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
          <Save />
        </button>
        <button
          className="tb-btn"
          data-active={tool === "convert"}
          disabled={!canEdit}
          data-tip={svg ? "SVG pictures stay as they are." : zipped ? "Copy the picture out of the archive before saving a change." : canEdit ? "Convert" : "Can't read this picture's size."}
          onClick={() => setTool((value) => (value === "convert" ? "" : "convert"))}
        >
          <Replace />
        </button>
        <button
          className="tb-btn"
          data-active={tool === "trim"}
          disabled={!canEdit}
          data-tip={svg ? "SVG pictures stay as they are." : zipped ? "Copy the picture out of the archive before saving a change." : canEdit ? "Trim" : "Can't read this picture's size."}
          onClick={() => setTool((value) => (value === "trim" ? "" : "trim"))}
        >
          <Crop />
        </button>
        {preview.scaled && <span className="text-xs text-[var(--muted)]">Shown smaller. Save writes the full picture.</span>}
      </div>
      {tool && canEdit && (
        <div className="fp-trim">
          {tool === "trim" && (
            <>
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
          <select className="field sm" value={format} onChange={(event) => setFormat(event.target.value)} aria-label="Format">
            <option value="jpg">JPG</option>
            <option value="png">PNG</option>
            <option value="webp">WebP</option>
            <option value="bmp">BMP</option>
            <option value="gif">GIF</option>
          </select>
          {format === "jpg" && (
            <label className="flex items-center gap-1 text-xs text-[var(--muted)]">
              Quality
              <input type="range" min={1} max={100} value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
              {quality}
            </label>
          )}
          {(format === "jpg" || format === "bmp") && (
            <span className="seg">
              <button type="button" data-active={background === "white"} onClick={() => setBackground("white")}>White</button>
              <button type="button" data-active={background === "black"} onClick={() => setBackground("black")}>Black</button>
            </span>
          )}
          <button
            className="btn sm primary"
            type="button"
            disabled={savingTrim || (tool === "trim" && (!(Number(widthText) > 0) || !(Number(heightText) > 0) || outW < 1 || outH < 1))}
            onClick={() => saveExport(tool === "convert")}
          >
            Save
          </button>
          {notice && <span className="text-xs text-[var(--muted)]">{notice}</span>}
          {tool === "trim" && <span className="text-xs text-[var(--muted)]">Ctrl + scroll zooms. Drag moves the picture.</span>}
          {tool === "trim" && zoom !== 100 && <span className="text-xs text-[var(--muted)]">Save scales the picture to this size.</span>}
          {preview.extension === "gif" && <span className="text-xs text-[var(--muted)]">Animated GIFs become a single frame.</span>}
          {tool === "convert" && (format === "png" || format === "webp") && <span className="text-xs text-[var(--muted)]">This keeps every pixel. Photos are often larger than a JPG.</span>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto" ref={stageRef}>
        <div className="fp-stage" data-trim={tool === "trim" ? "true" : undefined}>
          {tool === "trim" && canEdit && box.w > 0 && viewW > 0 ? (
            <div
              ref={cropRef}
              className="fp-window"
              tabIndex={0}
              style={{ width: box.w, height: box.h, background: format === "jpg" || format === "bmp" ? (background === "black" ? "#000" : "#fff") : "transparent" }}
              onPointerDown={dragPicture}
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
              <div style={{ position: "absolute", left: imgLeft, top: imgTop, width: imgScreenW, height: imgScreenH }}>
                <img
                  alt={preview.name}
                  src={`data:${mime};base64,${preview.dataBase64}`}
                  style={{
                    width: turned ? imgScreenH : imgScreenW,
                    height: turned ? imgScreenW : imgScreenH,
                    left: "50%",
                    top: "50%",
                    transform: `translate(-50%, -50%) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1}) rotate(${quarters * 90}deg)`,
                  }}
                />
              </div>
            </div>
          ) : (
            <img
              alt={preview.name}
              src={`data:${mime};base64,${preview.dataBase64}`}
              style={{ transform: `scaleY(${flipV ? -1 : 1}) scaleX(${flipH ? -1 : 1}) rotate(${quarters * 90}deg)` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function MediaView({ preview }: { preview: PreviewFile }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const dvd = preview.extension === "vob";
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
        ? <video src={url} controls onError={() => setFailed(true)} />
        : <audio src={url} controls onError={() => setFailed(true)} />)}
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
    setEntries(null);
    setError(null);
    void invoke<DirListing>("list_dir", { path: listPath })
      .then((listing) => {
        if (!cancel) setEntries(listing.entries);
      })
      .catch((reason: unknown) => {
        if (!cancel) setError(message(reason));
      });
    return () => {
      cancel = true;
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
        <table className={drag.widths ? "fp-table fp-cols" : "fp-table"} onPointerDown={drag.onPointerDown} onPointerMove={drag.onPointerMove}>
          {drag.widths && <colgroup>{drag.widths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup>}
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
