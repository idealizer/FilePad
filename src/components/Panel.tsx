import { AlignJustify, ChevronDown, ChevronLeft, ChevronRight, Disc, Download, Eye, FileText, Folder, FolderTree, HardDrive, House, LayoutGrid, List, MemoryStick, Monitor, Network, Search, Usb } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useDragSession } from "../lib/drag";
import { displayPath, isRemotePath, storePath } from "../lib/format";
import { fileRows } from "../lib/rows";
import { useApp } from "../stores/appStore";
import type { Side, ViewMode } from "../types";
import { DirTree } from "./DirTree";
import { FileList } from "./FileList";
import { IconView } from "./IconView";
import { Dropdown, MenuItem } from "./Menu";
import { PreviewPane } from "./PreviewPane";
import { PanelStatus } from "./StatusBar";

function placeIcon(place: { name: string; kind: string; role?: string }) {
  switch (place.role || place.name.toLowerCase()) {
    case "home": return <House />;
    case "desktop": return <Monitor />;
    case "documents": return <FileText />;
    case "downloads": return <Download />;
    case "removable": return <Usb />;
    case "remote": return <Network />;
    case "cd": return <Disc />;
    case "ram": return <MemoryStick />;
    default: return place.kind === "drive" ? <HardDrive /> : <Folder />;
  }
}

const views: { id: ViewMode; label: string; icon: ReactNode }[] = [
  { id: "files", label: "Files", icon: <List /> },
  { id: "details", label: "Details", icon: <AlignJustify /> },
  { id: "icons", label: "Icons", icon: <LayoutGrid /> },
  { id: "tree", label: "Tree", icon: <FolderTree /> },
  { id: "preview", label: "Preview", icon: <Eye /> },
];

export function Panel({ side }: { side: Side }) {
  const panel = useApp((state) => state.panels[side]);
  const active = useApp((state) => state.active === side);
  const setActive = useApp((state) => state.setActive);
  const navigate = useApp((state) => state.navigate);
  const setFilter = useApp((state) => state.setFilter);
  const setView = useApp((state) => state.setView);
  const goHistory = useApp((state) => state.goHistory);
  const places = useApp((state) => state.places);
  const recent = useApp((state) => state.recent);
  const sftpProfiles = useApp((state) => state.sftpProfiles);
  const loadPlaces = useApp((state) => state.loadPlaces);
  const openContext = useApp((state) => state.openContext);
  const drag = useDragSession();
  const shown = displayPath(panel.path);
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(shown);
  }, [shown, editing]);

  return (
    <section
      data-panel={side}
      data-active={active}
      data-drop={Boolean(drag && drag.side === side && drag.over === panel.path)}
      data-drop-path={panel.path}
      tabIndex={-1}
      className="fp-panel flex min-w-0 flex-1 flex-col outline-none"
      onMouseDownCapture={(event) => {
        if (event.button !== 3 && event.button !== 4) return;
        event.preventDefault();
        event.stopPropagation();
        setActive(side);
        void goHistory(side, event.button === 3 ? -1 : 1);
      }}
      onMouseDown={(event) => {
        setActive(side);
        const target = event.target;
        if (target instanceof HTMLElement && !target.closest("input, textarea, button")) event.currentTarget.focus();
      }}
      onContextMenu={(event) => {
        if (event.target instanceof Element && event.target.closest(".fp-row, input, button, a")) return;
        event.preventDefault();
        setActive(side);
        const state = useApp.getState();
        const rows = panel.view === "tree" ? [] : fileRows(panel, state.showHidden);
        const row = rows[panel.cursor];
        const paths = panel.marked.length ? panel.marked : row && !row.up ? [row.path] : [];
        openContext({ x: event.clientX, y: event.clientY, side, paths });
      }}
    >
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            setEditing(false);
            void navigate(side, storePath(draft, panel.path));
          }}
        >
          <input
            className="field fp-path h-7 w-full"
            value={draft}
            spellCheck={false}
            aria-label={`${side} folder`}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
        <Dropdown
          align="end"
          button={({ open, toggle }) => (
            <button className="tb-btn" data-active={open} data-tip="Places" onClick={() => { void loadPlaces(); toggle(); }}>
              <ChevronDown />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="menu-label">Places</div>
              {places.filter((place) => place.kind === "place").map((place) => (
                <MenuItem key={place.path} icon={placeIcon(place)} label={place.name} title={place.path} onClick={() => { close(); void navigate(side, place.path); }} />
              ))}
              <div className="menu-sep" />
              <div className="menu-label">Drives</div>
              {places.filter((place) => place.kind === "drive").map((place) => (
                <MenuItem key={place.path} icon={placeIcon(place)} label={place.name} title={place.path} onClick={() => { close(); void navigate(side, place.path); }} />
              ))}
              {recent.length > 0 && <div className="menu-sep" />}
              {recent.length > 0 && <div className="menu-label">Recent</div>}
              {recent.map((path) => (
                <MenuItem key={path} icon={<Folder />} label={displayPath(path)} title={displayPath(path)} onClick={() => { close(); void navigate(side, path); }} />
              ))}
              <div className="menu-sep" />
              <MenuItem icon={<Network />} label="Connect to SFTP" onClick={() => { close(); setActive(side); useApp.getState().askSftp(); }} />
              {isRemotePath(panel.path) && <MenuItem icon={<Network />} label="Disconnect" onClick={() => { close(); setActive(side); void useApp.getState().disconnectSftp(side); }} />}
              {sftpProfiles.map((profile) => (
                <MenuItem key={profile.id} icon={<Network />} label={profile.label} title={`${profile.username}@${profile.host}`} onClick={() => {
                  close();
                  setActive(side);
                  void useApp.getState().submitSftp({ profileId: profile.id, label: profile.label, host: profile.host, port: String(profile.port), username: profile.username, password: "", privateKey: "", passphrase: "", remotePath: profile.remotePath });
                }} />
              ))}
            </>
          )}
        </Dropdown>
      </div>
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1">
        <div className="flex items-center">
          <button className="tb-btn" data-tip="Back (Alt+Left)" disabled={panel.historyAt <= 0} onClick={() => void goHistory(side, -1)}><ChevronLeft /></button>
          <button className="tb-btn" data-tip="Forward (Alt+Right)" disabled={panel.historyAt >= panel.history.length - 1} onClick={() => void goHistory(side, 1)}><ChevronRight /></button>
        </div>
        <div className="seg">
          {views.map((view) => (
            <button
              key={view.id}
              data-active={panel.view === view.id}
              data-tip={view.id === "preview" && panel.view === "preview" ? "Back" : view.label}
              onClick={() => {
                if (view.id === "preview" && panel.view === "preview") {
                  setView(side, panel.savedView !== "preview" ? panel.savedView : panel.listView);
                  return;
                }
                setView(side, view.id);
              }}
            >
              {view.icon}
            </button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-[var(--muted)]" />
          <input className="field fp-filter h-7 w-full pl-7" placeholder="Filter" value={panel.filter} onChange={(event) => setFilter(side, event.target.value)} />
        </div>
      </div>
      {panel.view === "preview" ? <PreviewPane side={side} /> : panel.view === "tree" ? <DirTree side={side} /> : panel.view === "icons" ? <IconView side={side} /> : <FileList side={side} />}
      <PanelStatus side={side} />
    </section>
  );
}
