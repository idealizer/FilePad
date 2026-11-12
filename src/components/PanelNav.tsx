import { Disc, Download, FileText, Folder, HardDrive, House, Images, MemoryStick, Monitor, Network, Usb } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { pathKey, remoteParts } from "../lib/format";
import { useApp } from "../stores/appStore";
import type { Place, Side } from "../types";

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

function pinIcon(path: string, places: Place[]) {
  const place = places.find((item) => pathKey(item.path) === pathKey(path));
  return place ? placeIcon(place) : <Folder />;
}

export function PanelNav({ side }: { side: Side }) {
  const places = useApp((state) => state.places);
  const pins = useApp((state) => state.pins);
  const profiles = useApp((state) => state.sftpProfiles);
  const here = useApp((state) => state.panels[side].path);
  const navigate = useApp((state) => state.navigate);
  const setActive = useApp((state) => state.setActive);
  const loadPlaces = useApp((state) => state.loadPlaces);
  const openContext = useApp((state) => state.openContext);
  const movePin = useApp((state) => state.movePin);
  const listRef = useRef<HTMLDivElement>(null);
  const skipClick = useRef(false);
  const stopDrag = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const home = places.find((place) => place.role === "home");
  const gallery = places.find((place) => place.role === "pictures");
  const drives = places.filter((place) => place.kind === "drive");
  const remoteId = remoteParts(here)?.id ?? "";

  useEffect(() => {
    void loadPlaces();
    return () => stopDrag.current?.();
  }, [loadPlaces]);

  const open = (path: string) => {
    setActive(side);
    void navigate(side, path);
  };

  const onPinPointerDown = (event: React.PointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0) return;
    skipClick.current = false;
    const startY = event.clientY;
    let to = index;
    let moved = false;
    const hit = (clientY: number) => {
      const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-pin-index]");
      if (!rows?.length) return index;
      let next = to;
      rows.forEach((row) => {
        const rect = row.getBoundingClientRect();
        if (clientY >= rect.top && clientY < rect.bottom) next = Number(row.dataset.pinIndex);
      });
      return Number.isInteger(next) ? next : index;
    };
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < 4) return;
      moved = true;
      to = hit(ev.clientY);
      setDrag({ from: index, to });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      stopDrag.current = null;
      if (Math.abs(ev.clientY - startY) >= 4) moved = true;
      if (moved) to = hit(ev.clientY);
      setDrag(null);
      if (moved && to !== index) {
        skipClick.current = true;
        movePin(index, to);
      }
    };
    stopDrag.current?.();
    stopDrag.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <nav className="fp-nav" aria-label={`${side} sidebar`}>
      {home && <NavButton icon={<House />} label="Home" title={home.path} active={pathKey(home.path) === pathKey(here)} onClick={() => open(home.path)} />}
      {gallery && <NavButton icon={<Images />} label="Gallery" title={gallery.path} active={pathKey(gallery.path) === pathKey(here)} onClick={() => open(gallery.path)} />}
      <div className="fp-nav-sep" />
      <div className="fp-nav-pins" ref={listRef}>
        {pins.map((pin, index) => (
          <NavButton
            key={pin.path}
            icon={pinIcon(pin.path, places)}
            label={pin.name}
            title={pin.path}
            pin
            pinIndex={index}
            active={pathKey(pin.path) === pathKey(here)}
            drag={drag?.from === index}
            over={drag !== null && drag.to === index && drag.from !== index}
            onClick={() => {
              if (skipClick.current) {
                skipClick.current = false;
                return;
              }
              open(pin.path);
            }}
            onPointerDown={(event) => onPinPointerDown(event, index)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setActive(side);
              openContext({ x: event.clientX, y: event.clientY, side, paths: [pin.path], pin: pin.path });
            }}
          />
        ))}
      </div>
      <div className="fp-nav-sep" />
      {drives.map((drive) => (
        <NavButton key={drive.path} icon={placeIcon(drive)} label={drive.name} title={drive.path} active={pathKey(drive.path) === pathKey(here)} onClick={() => open(drive.path)} />
      ))}
      {profiles.length > 0 && <div className="fp-nav-sep" />}
      {profiles.map((profile) => (
        <NavButton
          key={profile.id}
          icon={<Network />}
          label={profile.label}
          title={`${profile.username}@${profile.host}`}
          active={remoteId === profile.id}
          onClick={() => {
            setActive(side);
            void useApp.getState().submitSftp({
              profileId: profile.id,
              label: profile.label,
              host: profile.host,
              port: String(profile.port),
              username: profile.username,
              password: "",
              privateKey: "",
              passphrase: "",
              remotePath: profile.remotePath,
            });
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setActive(side);
            openContext({ x: event.clientX, y: event.clientY, side, paths: [], connectionId: profile.id });
          }}
        />
      ))}
      {profiles.length > 0 && <NavButton icon={<Network />} label="Manage" title="Manage connections" active={false} onClick={() => { setActive(side); useApp.getState().askConnections(); }} />}
    </nav>
  );
}

function NavButton({
  icon,
  label,
  title,
  active,
  pin,
  pinIndex,
  drag,
  over,
  onClick,
  onPointerDown,
  onContextMenu,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  active: boolean;
  pin?: boolean;
  pinIndex?: number;
  drag?: boolean;
  over?: boolean;
  onClick: () => void;
  onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className="fp-nav-item"
      title={title}
      data-active={active}
      data-pin={pin || undefined}
      data-pin-index={pinIndex}
      data-drag={drag || undefined}
      data-over={over || undefined}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
