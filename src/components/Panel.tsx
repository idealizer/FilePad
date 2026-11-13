import { AlignJustify, ChevronDown, ChevronLeft, ChevronRight, Disc, Download, Eye, FileText, Folder, FolderTree, HardDrive, House, Images, LayoutGrid, List, MemoryStick, Monitor, Network, PanelLeft, Pencil, Plus, Search, Trash2, Unplug, Usb } from "lucide-react";
import { type CSSProperties, type ReactNode } from "react";
import { takeDragMenu, useDragSession } from "../lib/drag";
import { displayPath, isRemotePath } from "../lib/format";
import { ICON_COLUMNS_MAX, ICON_COLUMNS_MIN, iconColumnsFromZoom, iconColumnsOf, iconZoomOf } from "../lib/iconSize";
import { fileRows, previewTarget } from "../lib/rows";
import { useApp } from "../stores/appStore";
import type { Side, ViewMode } from "../types";
import { DirTree } from "./DirTree";
import { PanelNav } from "./PanelNav";
import { FileList } from "./FileList";
import { IconView } from "./IconView";
import { Dropdown, MenuItem } from "./Menu";
import { PathBar } from "./PathBar";
import { PreviewPane } from "./PreviewPane";
import { PanelStatus } from "./StatusBar";

function placeIcon(place: { name: string; kind: string; role?: string }) {
  switch (place.role || place.name.toLowerCase()) {
    case "home": return <House />;
    case "desktop": return <Monitor />;
    case "documents": return <FileText />;
    case "downloads": return <Download />;
    case "pictures": return <Images />;
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
];

export function Panel({ side }: { side: Side }) {
  const panel = useApp((state) => state.panels[side]);
  const active = useApp((state) => state.active === side);
  const setActive = useApp((state) => state.setActive);
  const navigate = useApp((state) => state.navigate);
  const setFilter = useApp((state) => state.setFilter);
  const setView = useApp((state) => state.setView);
  const previewOther = useApp((state) => state.previewOther);
  const goHistory = useApp((state) => state.goHistory);
  const otherView = useApp((state) => state.panels[side === "left" ? "right" : "left"].view);
  const previewing = otherView === "preview" && panel.view !== "preview";
  const places = useApp((state) => state.places);
  const navOpen = useApp((state) => (side === "left" ? state.leftNav : state.rightNav));
  const toggleNav = useApp((state) => state.toggleNav);
  const recent = useApp((state) => state.recent);
  const sftpProfiles = useApp((state) => state.sftpProfiles);
  const loadPlaces = useApp((state) => state.loadPlaces);
  const openContext = useApp((state) => state.openContext);
  const drag = useDragSession();

  return (
    <section
      data-panel={side}
      data-active={active}
      data-remote={isRemotePath(panel.path)}
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
        if (target instanceof HTMLElement && !target.closest("input, textarea, button, .fp-path")) event.currentTarget.focus();
      }}
      onContextMenu={(event) => {
        if (takeDragMenu(event)) return;
        if (event.target instanceof Element && event.target.closest(".fp-row, .fp-nav, input, button, a")) return;
        event.preventDefault();
        setActive(side);
        const state = useApp.getState();
        if (panel.view === "preview") {
          const source = side === "left" ? "right" : "left";
          const target = previewTarget(state.panels[source], state.showHidden);
          openContext({ x: event.clientX, y: event.clientY, side, paths: target ? [target.path] : [] });
          return;
        }
        const rows = panel.view === "tree" ? [] : fileRows(panel, state.showHidden);
        const row = rows[panel.cursor];
        const paths = panel.marked.length ? panel.marked : row && !row.up ? [row.path] : [];
        openContext({ x: event.clientX, y: event.clientY, side, paths });
      }}
    >
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-1.5">
        <button type="button" className="tb-btn" data-active={navOpen} data-tip="Sidebar" data-tip-align="start" onClick={() => { setActive(side); toggleNav(side); }}>
          <PanelLeft />
        </button>
        <PathBar side={side} />
        {isRemotePath(panel.path) && (
          <button className="tb-btn fp-disconnect" data-tip="Disconnect" onClick={() => { setActive(side); void useApp.getState().disconnectSftp(side); }}>
            <Unplug />
          </button>
        )}
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
              {recent.length > 0 && (
                <div className="menu-label menu-label-row">
                  <span>Recent</span>
                  <button type="button" className="menu-label-btn" onClick={() => useApp.getState().clearRecent()}>Clear</button>
                </div>
              )}
              {recent.map((path) => {
                const label = displayPath(path, sftpProfiles);
                return (
                  <div key={path} className="menu-recent">
                    <button type="button" title={label} onClick={() => { close(); void navigate(side, path); }}>
                      <Folder />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                    </button>
                    <button type="button" className="menu-drop" data-tip="Remove" aria-label={`Remove ${label}`} onClick={() => useApp.getState().forgetRecent(path)}>
                      <Trash2 />
                    </button>
                  </div>
                );
              })}
              <div className="menu-sep" />
              <div className="menu-label menu-label-row">
                <span>Connections</span>
                <span className="menu-label-actions">
                  <button type="button" className="menu-label-btn" data-tip="New" aria-label="New connection" onClick={() => { close(); setActive(side); useApp.getState().askSftp(); }}><Plus /></button>
                  <button type="button" className="menu-label-btn" data-tip="Edit" aria-label="Edit connections" onClick={() => { close(); setActive(side); useApp.getState().askConnections(); }}><Pencil /></button>
                </span>
              </div>
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
            <button key={view.id} data-active={panel.view === view.id} data-tip={view.label} onClick={() => setView(side, view.id)}>
              {view.icon}
            </button>
          ))}
        </div>
        <button
          className="tb-btn"
          data-active={previewing}
          data-tip={panel.view === "preview" ? "Back" : previewing ? "Close preview" : "Preview in the other panel"}
          onClick={() => {
            setActive(side);
            if (panel.view === "preview") {
              setView(side, panel.savedView !== "preview" ? panel.savedView : panel.listView);
              return;
            }
            previewOther();
          }}
        >
          <Eye />
        </button>
        {panel.view === "icons" && <IconSize side={side} />}
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-[var(--muted)]" />
          <input
            className="field fp-filter h-7 w-full pl-7"
            placeholder="Filter or search"
            data-tip="Type to filter this folder. Enter searches inside it."
            data-tip-pos="top"
            value={panel.filter}
            onChange={(event) => setFilter(side, event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              useApp.getState().searchDeeper(side);
            }}
          />
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        {navOpen && <PanelNav side={side} />}
        {panel.view === "preview" ? <PreviewPane side={side} /> : panel.view === "tree" ? <DirTree side={side} /> : panel.view === "icons" ? <IconView side={side} /> : <FileList side={side} />}
      </div>
      <PanelStatus side={side} />
    </section>
  );
}

function IconSize({ side }: { side: Side }) {
  const columns = iconColumnsOf(useApp((state) => state.panels[side].iconSize));
  const setIconSize = useApp((state) => state.setIconSize);
  const zoom = iconZoomOf(columns);
  return (
    <input
      className="fp-icon-size"
      style={{ "--fp-icon-fill": `${((zoom - ICON_COLUMNS_MIN) / (ICON_COLUMNS_MAX - ICON_COLUMNS_MIN)) * 100}%` } as CSSProperties}
      type="range"
      min={ICON_COLUMNS_MIN}
      max={ICON_COLUMNS_MAX}
      step={1}
      value={zoom}
      aria-label="Icons per row"
      data-tip={`${columns} per row`}
      onPointerDown={() => useApp.getState().setActive(side)}
      onChange={(event) => setIconSize(side, iconColumnsFromZoom(Number(event.target.value)))}
    />
  );
}
