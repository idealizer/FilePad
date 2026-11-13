import { ChevronRight, Folder, HardDrive, House } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { displayPath, pathCrumbs, pathKey, storePath } from "../lib/format";
import { invoke, isTyping, message } from "../lib/platform";
import { useApp } from "../stores/appStore";
import type { Entry, Side } from "../types";
import { Dropdown, MenuItem } from "./Menu";

export function PathBar({ side }: { side: Side }) {
  const panelPath = useApp((state) => state.panels[side].path);
  const pathStyle = useApp((state) => state.pathStyle);
  const places = useApp((state) => state.places);
  const sftpProfiles = useApp((state) => state.sftpProfiles);
  const navigate = useApp((state) => state.navigate);
  const setActive = useApp((state) => state.setActive);
  const shown = displayPath(panelPath, sftpProfiles);
  const [draft, setDraft] = useState(shown);
  const [editing, setEditing] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const seal = useRef(false);
  const openedAt = useRef(0);
  useEffect(() => {
    if (!editing) setDraft(shown);
  }, [shown, editing]);
  useEffect(() => {
    if (editing) seal.current = false;
  }, [editing]);
  useEffect(() => {
    const node = bar.current;
    if (node) node.scrollLeft = node.scrollWidth;
  }, [panelPath, editing, pathStyle]);
  useLayoutEffect(() => {
    if (!editing || pathStyle !== "breadcrumb") return;
    const node = field.current;
    if (!node || document.activeElement === node) return;
    node.focus();
    node.select();
  }, [editing, pathStyle]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || isTyping(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      const edit = (mod && !event.altKey && event.key.toLowerCase() === "l") || (event.altKey && !mod && event.key.toLowerCase() === "d");
      if (!edit || useApp.getState().active !== side) return;
      event.preventDefault();
      event.stopPropagation();
      const state = useApp.getState();
      openedAt.current = performance.now();
      setDraft(displayPath(state.panels[side].path, state.sftpProfiles));
      setEditing(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [side]);

  const beginEdit = () => {
    openedAt.current = performance.now();
    setActive(side);
    setDraft(shown);
    setEditing(true);
  };
  const commit = (text: string) => {
    if (seal.current) return;
    seal.current = true;
    setEditing(false);
    const current = useApp.getState().panels[side].path;
    const next = storePath(text, current);
    if (next.trim() && pathKey(next) !== pathKey(current)) void navigate(side, next);
  };

  if (pathStyle === "text" || editing) {
    return (
      <form
        className="min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          commit(draft);
        }}
      >
        <input
          ref={field}
          className="field fp-path h-7 w-full"
          value={draft}
          spellCheck={false}
          aria-label={`${side} folder`}
          onMouseDown={(event) => event.stopPropagation()}
          onFocus={() => {
            seal.current = false;
            setEditing(true);
          }}
          onBlur={() => {
            if (seal.current) return;
            if (performance.now() - openedAt.current < 300) {
              requestAnimationFrame(() => field.current?.focus());
              return;
            }
            commit(draft);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            seal.current = true;
            setDraft(shown);
            setEditing(false);
          }}
          onChange={(event) => {
            seal.current = false;
            setDraft(event.target.value);
          }}
        />
      </form>
    );
  }

  const home = places.find((place) => place.role === "home");
  const crumbs = pathCrumbs(panelPath, places, sftpProfiles);
  return (
    <div ref={bar} className="field fp-path fp-crumbs h-7 min-w-0 flex-1" aria-label={`${side} folder`}>
      {home && (
        <button type="button" className="fp-crumb" data-tip="Home" onClick={() => { setActive(side); void navigate(side, home.path); }}>
          <House />
        </button>
      )}
      <CrumbMenu side={side} label="Places and drives" kind="places" />
      {crumbs.map((crumb, index) => (
        <CrumbMenu key={crumb.path} side={side} label={`Folders in ${crumb.name}`} path={crumb.path} name={crumb.name} current={index === crumbs.length - 1} />
      ))}
      <div
        className="fp-crumb-rest"
        title="Type a path"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          beginEdit();
        }}
      />
    </div>
  );
}

function CrumbMenu({ side, label, path, name, current = false, kind = "folders" }: { side: Side; label: string; path?: string; name?: string; current?: boolean; kind?: "places" | "folders" }) {
  const loadPlaces = useApp((state) => state.loadPlaces);
  const navigate = useApp((state) => state.navigate);
  const setActive = useApp((state) => state.setActive);
  return (
    <Dropdown
      hover
      onOpen={() => {
        if (kind === "places") void loadPlaces();
      }}
      button={({ open, toggle }) => (
        <>
          {name && path && (
            <button
              type="button"
              className="fp-crumb"
              data-current={current}
              data-active={open}
              title={name}
              onClick={() => { setActive(side); void navigate(side, path); }}
            >
              <span>{name}</span>
            </button>
          )}
          <button
            type="button"
            className="fp-crumb-sep"
            data-active={open}
            aria-label={label}
            onClick={toggle}
          >
            <ChevronRight />
          </button>
        </>
      )}
    >
      {(close) => (kind === "places" ? <PlacesMenu side={side} close={close} /> : <FolderMenu side={side} path={path ?? ""} close={close} />)}
    </Dropdown>
  );
}

function PlacesMenu({ side, close }: { side: Side; close: () => void }) {
  const places = useApp((state) => state.places);
  const navigate = useApp((state) => state.navigate);
  const setActive = useApp((state) => state.setActive);
  const go = (path: string) => {
    close();
    setActive(side);
    void navigate(side, path);
  };
  const spots = places.filter((place) => place.kind === "place");
  const drives = places.filter((place) => place.kind === "drive");
  return (
    <>
      {spots.length > 0 && <div className="menu-label">Places</div>}
      {spots.map((place) => (
        <MenuItem key={place.path} icon={place.role === "home" ? <House /> : <Folder />} label={place.name} title={place.path} onClick={() => go(place.path)} />
      ))}
      {drives.length > 0 && <div className="menu-sep" />}
      {drives.length > 0 && <div className="menu-label">Drives</div>}
      {drives.map((place) => (
        <MenuItem key={place.path} icon={<HardDrive />} label={place.name} title={place.path} onClick={() => go(place.path)} />
      ))}
    </>
  );
}

function FolderMenu({ side, path, close }: { side: Side; path: string; close: () => void }) {
  const showHidden = useApp((state) => state.showHidden);
  const navigate = useApp((state) => state.navigate);
  const setActive = useApp((state) => state.setActive);
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    const id = request.current + 1;
    request.current = id;
    setRows(null);
    setError("");
    const timer = window.setTimeout(() => {
      void invoke<Entry[]>("list_subdirs", { path })
        .then((entries) => {
          if (request.current !== id) return;
          const dirs = entries.filter((entry) => showHidden || !entry.hidden);
          dirs.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
          setRows(dirs);
        })
        .catch((reason: unknown) => {
          if (request.current === id) setError(message(reason));
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      request.current += 1;
    };
  }, [path, showHidden]);
  if (error) return <div className="menu-label">{error}</div>;
  if (!rows) return <div className="menu-label">Reading…</div>;
  if (!rows.length) return <div className="menu-label">No folders</div>;
  return (
    <>
      {rows.map((row) => (
        <MenuItem
          key={row.path}
          icon={<Folder />}
          label={row.name}
          title={row.name}
          onClick={() => {
            close();
            setActive(side);
            void navigate(side, row.path);
          }}
        />
      ))}
    </>
  );
}
