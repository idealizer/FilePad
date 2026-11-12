import type { NavPin, ThemeMode, ViewMode } from "../types";
import { ICON_COLUMNS_DEFAULT } from "./iconSize";
import type { NameTemplate } from "./names";
import { inTauri } from "./platform";

export interface SessionData {
  theme: ThemeMode;
  leftPath: string;
  rightPath: string;
  leftView: ViewMode;
  rightView: ViewMode;
  showHidden: boolean;
  iconColors: boolean;
  iconSize: number;
  leftIconSize: number;
  rightIconSize: number;
  keyBar: boolean;
  scrollLock: boolean;
  iconTints: Record<string, string>;
  leftHistory: string[];
  rightHistory: string[];
  leftHistoryAt: number;
  rightHistoryAt: number;
  recent: string[];
  commandHistory: string[];
  split: number;
  outputHeight: number;
  terminalHeight: number;
  nameTemplates: NameTemplate[];
  leftNav: boolean;
  rightNav: boolean;
  pins?: NavPin[];
}

const FALLBACK = "filepad-session";

export function defaultSession(): SessionData {
  return {
    theme: "system",
    leftPath: "",
    rightPath: "",
    leftView: "details",
    rightView: "details",
    showHidden: false,
    iconColors: true,
    iconSize: ICON_COLUMNS_DEFAULT,
    leftIconSize: ICON_COLUMNS_DEFAULT,
    rightIconSize: ICON_COLUMNS_DEFAULT,
    keyBar: true,
    scrollLock: false,
    iconTints: {},
    leftHistory: [],
    rightHistory: [],
    leftHistoryAt: 0,
    rightHistoryAt: 0,
    recent: [],
    commandHistory: [],
    split: 0.5,
    outputHeight: 160,
    terminalHeight: 240,
    nameTemplates: [],
    leftNav: false,
    rightNav: false,
  };
}

function withIconSizes(saved: Partial<SessionData> | null | undefined, merged: SessionData): SessionData {
  const legacy = typeof saved?.iconSize === "number" ? saved.iconSize : merged.iconSize;
  return {
    ...merged,
    leftIconSize: typeof saved?.leftIconSize === "number" ? saved.leftIconSize : legacy,
    rightIconSize: typeof saved?.rightIconSize === "number" ? saved.rightIconSize : legacy,
  };
}

export async function readSession(): Promise<SessionData> {
  const defaults = defaultSession();
  try {
    if (!inTauri()) {
      const raw = localStorage.getItem(FALLBACK);
      const saved = raw ? (JSON.parse(raw) as Partial<SessionData>) : null;
      return withIconSizes(saved, { ...defaults, ...(saved ?? {}) });
    }
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("settings.json", { autoSave: true, defaults: {} });
    const saved = await store.get<Partial<SessionData>>("session");
    return withIconSizes(saved, { ...defaults, ...(saved ?? {}) });
  } catch {
    return defaults;
  }
}

export async function writeSession(session: SessionData): Promise<void> {
  if (!inTauri()) {
    localStorage.setItem(FALLBACK, JSON.stringify(session));
    return;
  }
  const { load } = await import("@tauri-apps/plugin-store");
  const store = await load("settings.json", { autoSave: true, defaults: {} });
  await store.set("session", session);
  await store.save();
}
