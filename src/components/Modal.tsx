import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { baseName, displayPath, formatBytes, formatWhen, isPackedPath, isRemotePath, isStillImage } from "../lib/format";
import { defaultIconColor, FileIcon, iconCatalog } from "../lib/fileIcon";
import { planNames, templateChoices, type NameTemplate } from "../lib/names";
import { invoke, message } from "../lib/platform";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";
import type { ItemDetails } from "../types";
import { ConnectionsDialog, ForgetConnectionDialog, HostKeyDialog, McpToolDialog, ServersDialog, SftpDialog, SftpOfferDialog, SftpResumeDialog } from "./RemoteDialogs";

export function ModalHost() {
  const modal = useApp((state) => state.modal);
  if (!modal) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 p-6">
      <div className={`fp-float w-full border border-[var(--border)] bg-[var(--surface)] p-4 ${modal.type === "renameMany" || modal.type === "properties" || modal.type === "sftp" || modal.type === "servers" ? "max-w-xl" : "max-w-md"}`}>
        {modal.type === "delete" && <DeleteDialog />}
        {modal.type === "mkdir" && <NameDialog key="mkdir" title="New folder" label="Folder name" action="Create" onSubmit={(name) => void useApp.getState().confirmMkdir(name)} />}
        {modal.type === "mkfile" && <NameDialog key="mkfile" title="New file" label="File name" action="Create" initial="untitled.txt" onSubmit={(name) => void useApp.getState().confirmMkfile(name)} />}
        {modal.type === "about" && <AboutDialog />}
        {modal.type === "colors" && <ColorsDialog />}
        {modal.type === "rename" && <NameDialog key={modal.path} title="Rename" label="New name" action="Rename" initial={modal.name} onSubmit={(name) => void useApp.getState().confirmRename(name)} />}
        {modal.type === "renameMany" && <PatternDialog />}
        {modal.type === "zip" && <NameDialog key={modal.name} title="Send to zip" label="Zip name" action="Create" initial={modal.name} onSubmit={(name) => void useApp.getState().confirmZip(name)} />}
        {modal.type === "convert" && <ConvertDialog key={modal.paths.join("|")} />}
        {modal.type === "properties" && <PropertiesDialog key={modal.paths.join("|")} />}
        {modal.type === "overwrite" && <OverwriteDialog />}
        {modal.type === "sftp" && <SftpDialog />}
        {modal.type === "hostKey" && <HostKeyDialog />}
        {modal.type === "sftpOffer" && <SftpOfferDialog />}
        {modal.type === "sftpResume" && <SftpResumeDialog />}
        {modal.type === "servers" && <ServersDialog />}
        {modal.type === "connections" && <ConnectionsDialog />}
        {modal.type === "forgetSftp" && <ForgetConnectionDialog />}
        {(modal.type === "mcpTool" || modal.type === "mcpConfirm") && <McpToolDialog />}
      </div>
    </div>
  );
}

function DeleteDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const confirmDelete = useApp((state) => state.confirmDelete);
  if (modal?.type !== "delete") return null;
  const shown = modal.paths.slice(0, 8).map(baseName);
  const remote = modal.paths.every(isRemotePath);
  const local = modal.paths.every((path) => !isRemotePath(path));
  const note = remote
    ? "This is removed from the server and cannot be undone."
    : local
      ? "This goes to the Recycle Bin."
      : "Local items go to the Recycle Bin. Server items are removed and cannot be undone.";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void confirmDelete();
      }}
    >
      <h2 className="text-base font-semibold">Delete {modal.paths.length === 1 ? "this item" : `${modal.paths.length} items`}?</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">{note}</p>
      <ul className="mt-3 max-h-40 overflow-auto text-sm text-[var(--muted)]">
        {modal.paths.slice(0, 8).map((path) => <li key={path} className="truncate">{baseName(path)}</li>)}
        {modal.paths.length > shown.length && <li>and {modal.paths.length - shown.length} more</li>}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" type="button" onClick={closeModal}>Cancel</button>
        <button className="btn danger" type="submit" autoFocus>Delete</button>
      </div>
    </form>
  );
}

function AboutDialog() {
  const closeModal = useApp((state) => state.closeModal);
  const folderAppSupported = useApp((state) => state.folderAppSupported);
  const folderApp = useApp((state) => state.folderApp);
  const setFolderApp = useApp((state) => state.setFolderApp);
  const pathStyle = useApp((state) => state.pathStyle);
  const setPathStyle = useApp((state) => state.setPathStyle);
  return (
    <>
      <h2 className="text-base font-semibold">FilePad</h2>
      <p className="mt-2 text-sm">A two-panel file commander.</p>
      <p className="mt-3 text-sm text-[var(--muted)]">by Content Factory OÜ</p>
      <h3 className="mt-4 text-sm font-semibold">Path bar</h3>
      <p className="mt-1 text-sm text-[var(--muted)]">Breadcrumb shows each folder. The arrow next to a folder lists the folders inside it. Click the empty end of the bar to type a path. Text shows the path as a line.</p>
      <div className="fp-switch mt-3" role="group" aria-label="Path bar">
        <button type="button" data-active={pathStyle === "breadcrumb"} onClick={() => setPathStyle("breadcrumb")}>Breadcrumb</button>
        <button type="button" data-active={pathStyle === "text"} onClick={() => setPathStyle("text")}>Text</button>
      </div>
      {folderAppSupported && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Folders</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">Folders from the desktop, File Explorer, drives, and Win+E open here. If FilePad is already open, the folder opens in the active panel. An Open or Save window still uses File Explorer.</p>
          <div className="fp-switch mt-3" role="group" aria-label="Open folders in FilePad">
            <button type="button" data-active={folderApp} onClick={() => { if (!folderApp) void setFolderApp(true); }}>On</button>
            <button type="button" data-active={!folderApp} onClick={() => { if (folderApp) void setFolderApp(false); }}>Off</button>
          </div>
        </>
      )}
      <div className="mt-4 flex justify-end">
        <button className="btn primary" onClick={closeModal}>Close</button>
      </div>
    </>
  );
}

function ColorsDialog() {
  const closeModal = useApp((state) => state.closeModal);
  const iconColors = useApp((state) => state.iconColors);
  const iconTints = useApp((state) => state.iconTints);
  const toggleIconColors = useApp((state) => state.toggleIconColors);
  const setIconTint = useApp((state) => state.setIconTint);
  const resetIconTints = useApp((state) => state.resetIconTints);
  const [manage, setManage] = useState(false);
  const [query, setQuery] = useState("");
  const [ext, setExt] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const known = new Set(iconCatalog.flatMap((group) => group.items.map((item) => item.id)));
  const extra = Object.keys(iconTints).filter((id) => !known.has(id)).sort();
  const needle = query.trim().toLowerCase();
  const groups = iconCatalog
    .map((group) => ({ ...group, items: group.items.filter((item) => !needle || item.id.includes(needle) || item.name.toLowerCase().includes(needle)) }))
    .filter((group) => group.items.length);
  const extraShown = extra.filter((id) => !needle || id.includes(needle));

  const add = () => {
    const id = ext.trim().toLowerCase().replace(/^\./, "");
    if (!/^[a-z0-9]{1,12}$/.test(id) || id === "folder") {
      toast("warning", "Use an extension such as txt or pdf.");
      return;
    }
    setIconTint(id, color);
    setExt("");
  };

  return (
    <>
      <h2 className="text-base font-semibold">Icon colors</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">Outlines are colored for folders, documents, images, spreadsheets, slides, video, audio, code, and programs.</p>
      <div className="fp-switch mt-4" role="group" aria-label="Icon colors">
        <button type="button" data-active={iconColors} onClick={() => { if (!iconColors) toggleIconColors(); }}>On</button>
        <button type="button" data-active={!iconColors} onClick={() => { if (iconColors) toggleIconColors(); }}>Off</button>
      </div>
      <button type="button" className="btn mt-4 w-full justify-center" aria-expanded={manage} onClick={() => setManage((open) => !open)}>
        Manage extensions
        {manage ? <ChevronUp /> : <ChevronDown />}
      </button>
      {manage && (
        <>
          <input className="field mt-3 h-8 w-full" placeholder="Find an extension" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="mt-3 max-h-[42vh] overflow-auto pr-1">
            {groups.map((group) => (
              <div key={group.label} className="mb-3">
                <div className="menu-label">{group.label}</div>
                {group.items.map((item) => (
                  <Swatch key={item.id} id={item.id} name={item.name} color={iconTints[item.id] ?? defaultIconColor(item.id)} custom={Boolean(iconTints[item.id])} onChange={(next) => setIconTint(item.id, next)} onReset={() => setIconTint(item.id, null)} />
                ))}
              </div>
            ))}
            {extraShown.length > 0 && (
              <div className="mb-3">
                <div className="menu-label">Added</div>
                {extraShown.map((id) => (
                  <Swatch key={id} id={id} name={id} color={iconTints[id]} custom onChange={(next) => setIconTint(id, next)} onReset={() => setIconTint(id, null)} />
                ))}
              </div>
            )}
            {!groups.length && !extraShown.length && <p className="px-2 py-3 text-sm text-[var(--muted)]">No extension matches.</p>}
          </div>
          <form className="mt-3 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); add(); }}>
            <input className="field h-8 min-w-0 flex-1" placeholder="Add extension" value={ext} spellCheck={false} onChange={(event) => setExt(event.target.value)} />
            <input className="fp-color" type="color" aria-label="Color for the new extension" value={color} onChange={(event) => setColor(event.target.value)} />
            <button className="btn" type="submit">Add</button>
          </form>
        </>
      )}
      <div className="mt-4 flex justify-end gap-2">
        {manage && <button className="btn" disabled={!Object.keys(iconTints).length} onClick={resetIconTints}>Reset all</button>}
        <button className="btn primary" onClick={closeModal}>Close</button>
      </div>
    </>
  );
}

function Swatch({ id, name, color, custom, onChange, onReset }: { id: string; name: string; color: string; custom: boolean; onChange: (color: string) => void; onReset: () => void }) {
  const shown = /^#[0-9a-fA-F]{6}$/.test(color) ? color : defaultIconColor(id);
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <span className="inline-flex" style={{ color: shown }}><FileIcon isDir={id === "folder"} extension={id} /></span>
      <span className="w-16 truncate text-sm">{name}</span>
      <input className="fp-color" type="color" aria-label={`${name} color`} value={shown} onChange={(event) => onChange(event.target.value)} />
      <span className="w-16 font-mono text-xs text-[var(--muted)]">{shown}</span>
      {custom ? <button type="button" className="text-xs text-[var(--muted)] hover:text-[var(--text)]" onClick={onReset}>Reset</button> : <span className="w-9" />}
    </div>
  );
}

function PropertiesDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const profiles = useApp((state) => state.sftpProfiles);
  const paths = modal?.type === "properties" ? modal.paths : [];
  const [items, setItems] = useState<ItemDetails[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!paths.length) return;
    let cancel = false;
    void invoke<ItemDetails[]>("describe_items", { paths })
      .then((next) => {
        if (!cancel) setItems(next);
      })
      .catch((reason: unknown) => {
        if (!cancel) setError(message(reason));
      });
    return () => {
      cancel = true;
    };
  }, [paths]);
  const item = items?.length === 1 ? items[0] : null;
  const knownCount = items?.filter((entry) => entry.sizeKnown).length ?? 0;
  const known = items?.reduce((sum, entry) => sum + (entry.sizeKnown ? entry.size : 0), 0) ?? 0;
  const locations = items ? [...new Set(items.map((entry) => entry.location))] : [];
  return (
    <>
      <h2 className="text-base font-semibold">Properties</h2>
      <div className="mt-3">
        {error && <p className="text-sm text-[var(--muted)]">{error}</p>}
        {!error && !items && <p className="text-sm text-[var(--muted)]">Reading…</p>}
        {item && (
          <>
            <Property label="Name" value={item.name} />
            <Property label="Path" value={displayPath(item.path, profiles)} />
            <Property label="Type" value={item.kind} />
            <Property label="Size" value={item.sizeKnown ? formatBytes(item.size) : "—"} />
            {item.counted && <Property label="Contains" value={contains(item)} />}
            <Property label="Modified" value={when(item.modified)} />
            <Property label="Created" value={when(item.created)} />
            <Property label="Accessed" value={when(item.accessed)} />
            <Property label="Attributes" value={attributes(item)} />
          </>
        )}
        {items && items.length > 1 && (
          <>
            <Property label="Items" value={`${items.length} selected`} />
            <Property label="Files" value={String(items.filter((entry) => !entry.isDir).length)} />
            <Property label="Folders" value={String(items.filter((entry) => entry.isDir).length)} />
            <Property label="Size" value={knownCount ? formatBytes(known) : "—"} />
            <Property label="Location" value={locations.length === 1 ? displayPath(locations[0], profiles) : "More than one folder"} />
          </>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <button className="btn primary" onClick={closeModal}>Close</button>
      </div>
    </>
  );
}

function Property({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3 border-b border-[var(--border)] py-1.5 text-sm last:border-0">
      <div className="text-[var(--muted)]">{label}</div>
      <div className="break-all">{value || "—"}</div>
    </div>
  );
}

function contains(item: ItemDetails): string {
  const files = `${item.files} ${item.files === 1 ? "file" : "files"}`;
  if (item.kind === "Zip archive" || item.kind === "Gzip archive") return files;
  const folders = `${item.folders} ${item.folders === 1 ? "folder" : "folders"}`;
  if (!item.folders) return files;
  if (!item.files) return folders;
  return `${folders}, ${files}`;
}

function when(ms: number): string {
  return formatWhen(ms) || "—";
}

function attributes(item: ItemDetails): string {
  if (isPackedPath(item.path)) return "Inside an archive";
  if (item.path.startsWith("sftp:")) return "On a server";
  const flags = [item.hidden ? "Hidden" : "", item.readOnly ? "Read-only" : ""].filter(Boolean);
  return flags.length ? flags.join(", ") : "Normal";
}

function NameDialog({ title, label, action, initial = "", onSubmit }: { title: string; label: string; action: string; initial?: string; onSubmit: (name: string) => void }) {
  const closeModal = useApp((state) => state.closeModal);
  const [name, setName] = useState(initial);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(name);
      }}
    >
      <h2 className="text-base font-semibold">{title}</h2>
      <label className="mt-3 block text-sm text-[var(--muted)]">
        {label}
        <input className="field mt-1 w-full" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" type="button" onClick={closeModal}>Cancel</button>
        <button className="btn primary" type="submit" disabled={!name.trim()}>{action}</button>
      </div>
    </form>
  );
}

function PatternDialog() {
  const modal = useApp((state) => state.modal);
  const saved = useApp((state) => state.nameTemplates);
  const closeModal = useApp((state) => state.closeModal);
  const patternRef = useRef<HTMLInputElement>(null);
  const choices = templateChoices(saved);
  const [pattern, setPattern] = useState("{name}{sep}{date}");
  const [separator, setSeparator] = useState("_");
  const [dateFormat, setDateFormat] = useState("YYYYMMDD");
  const [label, setLabel] = useState("");
  const [picked, setPicked] = useState("Name and date");
  const planned = useMemo(() => {
    if (modal?.type !== "renameMany") return [];
    return planNames(modal.items, { pattern, separator, dateFormat }, modal.taken);
  }, [modal, pattern, separator, dateFormat]);
  if (modal?.type !== "renameMany") return null;
  const ready = planned.length > 0 && planned.every((item) => item.name && !item.error);
  const apply = (template: NameTemplate) => {
    setPattern(template.pattern);
    setSeparator(template.separator);
    setDateFormat(template.dateFormat);
    setPicked(template.label);
  };
  const insert = (token: string) => {
    const input = patternRef.current;
    const start = input?.selectionStart ?? pattern.length;
    const end = input?.selectionEnd ?? start;
    const next = pattern.slice(0, start) + token + pattern.slice(end);
    setPattern(next);
    setPicked("");
    requestAnimationFrame(() => {
      input?.focus();
      const caret = start + token.length;
      input?.setSelectionRange(caret, caret);
    });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void useApp.getState().confirmRenameMany(planned.map((item) => ({ path: item.path, name: item.name })));
      }}
    >
      <h2 className="text-base font-semibold">Rename {modal.items.length} items</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">Date uses each file's modified time. Matching names get 2, 3, and so on.</p>
      <label className="mt-3 block text-sm text-[var(--muted)]">
        Saved template
        <select
          className="field mt-1 w-full"
          value={picked}
          onChange={(event) => {
            const next = choices.find((template) => template.label === event.target.value);
            if (next) apply(next);
            else setPicked("");
          }}
        >
          <option value="">Custom</option>
          {choices.map((template) => <option key={template.label} value={template.label}>{template.label}</option>)}
        </select>
      </label>
      <label className="mt-3 block text-sm text-[var(--muted)]">
        Pattern
        <input ref={patternRef} className="field mt-1 w-full" autoFocus value={pattern} spellCheck={false} onChange={(event) => { setPattern(event.target.value); setPicked(""); }} />
      </label>
      <div className="mt-2 flex flex-wrap gap-1">
        <button className="fp-token" type="button" onClick={() => insert("{name}")}>Name</button>
        <button className="fp-token" type="button" onClick={() => insert("{sep}")}>Separator</button>
        <button className="fp-token" type="button" onClick={() => insert("{date}")}>Date</button>
        <button className="fp-token" type="button" onClick={() => insert("{n:2}")}>Number</button>
        <button className="fp-token" type="button" onClick={() => insert("{ext}")}>Extension</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block text-sm text-[var(--muted)]">
          Separator
          <input className="field mt-1 w-full" value={separator} spellCheck={false} maxLength={8} onChange={(event) => { setSeparator(event.target.value); setPicked(""); }} />
        </label>
        <label className="block text-sm text-[var(--muted)]">
          Date format
          <input className="field mt-1 w-full" value={dateFormat} spellCheck={false} maxLength={32} onChange={(event) => { setDateFormat(event.target.value); setPicked(""); }} />
        </label>
      </div>
      <div className="mt-3 max-h-36 overflow-auto rounded-md border border-[var(--border)] text-sm">
        {planned.slice(0, 8).map((item) => (
          <div key={item.path} className="flex gap-2 border-b border-[var(--border)] px-2 py-1 last:border-0">
            <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{item.from}</span>
            <span className="min-w-0 flex-1 truncate">{item.error ?? item.name}</span>
          </div>
        ))}
        {planned.length > 8 && <div className="px-2 py-1 text-[var(--muted)]">and {planned.length - 8} more</div>}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          className="field min-w-0 flex-1"
          placeholder="Template name"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const name = label.trim();
            if (!name) {
              toast("warning", "Name the template first.");
              return;
            }
            useApp.getState().saveNameTemplate({ label: name, pattern, separator, dateFormat });
            setPicked(name);
          }}
        />
        <button
          className="btn"
          type="button"
          onClick={() => {
            const name = label.trim();
            if (!name) {
              toast("warning", "Name the template first.");
              return;
            }
            useApp.getState().saveNameTemplate({ label: name, pattern, separator, dateFormat });
            setPicked(name);
          }}
        >
          Save
        </button>
        <button
          className="btn"
          type="button"
          disabled={!saved.some((template) => template.label === picked)}
          onClick={() => {
            useApp.getState().deleteNameTemplate(picked);
            setPicked("");
          }}
        >
          Delete
        </button>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" type="button" onClick={closeModal}>Cancel</button>
        <button className="btn primary" type="submit" disabled={!ready}>Rename</button>
      </div>
    </form>
  );
}

const convertFormats = [
  { id: "jpg", label: "JPG" },
  { id: "png", label: "PNG" },
  { id: "webp", label: "WebP" },
  { id: "avif", label: "AVIF" },
  { id: "bmp", label: "BMP" },
  { id: "gif", label: "GIF" },
];

function ConvertDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const [format, setFormat] = useState("jpg");
  const [quality, setQuality] = useState(85);
  const [background, setBackground] = useState<"white" | "black">("white");
  const [replace, setReplace] = useState(false);
  if (modal?.type !== "convert") return null;
  const pictures = modal.paths.filter(isStillImage);
  const gif = pictures.some((path) => path.toLowerCase().endsWith(".gif"));
  const lossy = format === "jpg" || format === "bmp";
  const qualityOn = format === "jpg" || format === "avif";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void useApp.getState().confirmConvert(format, quality, background, replace);
      }}
    >
      <h2 className="text-base font-semibold">Convert {pictures.length === 1 ? "picture" : `${pictures.length} pictures`}</h2>
      {pictures.length !== modal.paths.length && <p className="mt-2 text-sm text-[var(--muted)]">Other selected files are left as they are.</p>}
      <div className="seg mt-3 flex-wrap">
        {convertFormats.map((item) => (
          <button key={item.id} type="button" data-active={format === item.id} onClick={() => setFormat(item.id)}>{item.label}</button>
        ))}
      </div>
      {qualityOn && (
        <label className="mt-3 flex items-center gap-2 text-sm text-[var(--muted)]">
          Quality
          <input className="min-w-0 flex-1" type="range" min={1} max={100} value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
          <span className="w-8 text-right text-[var(--text)]">{quality}</span>
        </label>
      )}
      {lossy && (
        <div className="mt-3 flex items-center gap-2 text-sm">
          <span className="text-[var(--muted)]">Background</span>
          <span className="seg">
            <button type="button" data-active={background === "white"} onClick={() => setBackground("white")}>White</button>
            <button type="button" data-active={background === "black"} onClick={() => setBackground("black")}>Black</button>
          </span>
        </div>
      )}
      {gif && <p className="mt-3 text-sm text-[var(--muted)]">Animated GIFs become a single frame.</p>}
      {(format === "png" || format === "webp") && <p className="mt-3 text-sm text-[var(--muted)]">This keeps every pixel. Photos are often larger than a JPG.</p>}
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} />
        Replace files that are already there
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" type="button" onClick={closeModal}>Cancel</button>
        <button className="btn primary" type="submit">Convert</button>
      </div>
    </form>
  );
}

function OverwriteDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const confirmOverwrite = useApp((state) => state.confirmOverwrite);
  if (modal?.type !== "overwrite") return null;
  return (
    <>
      <h2 className="text-base font-semibold">Replace existing items?</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">These names are already in the destination.</p>
      <ul className="mt-3 max-h-40 overflow-auto text-sm">
        {modal.conflicts.slice(0, 8).map((name) => <li key={name} className="truncate">{name}</li>)}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn primary" onClick={() => void confirmOverwrite()}>Replace</button>
      </div>
    </>
  );
}
