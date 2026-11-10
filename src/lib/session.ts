import type { ThemeMode, ViewMode } from "../types";
import type { NameTemplate } from "./names";
import { inTauri } from "./platform";

export interface SessionData {
  theme: ThemeMode;
  leftPath: string;
  rightPath: string;
  leftView: ViewMode;
  rightView: ViewMode;
  showHidden: boolean;
  recent: string[];
  commandHistory: string[];
  split: number;
  outputHeight: number;
  terminalHeight: number;
  nameTemplates: NameTemplate[];
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
    recent: [],
    commandHistory: [],
    split: 0.5,
    outputHeight: 160,
    terminalHeight: 240,
    nameTemplates: [],
  };
}

export async function readSession(): Promise<SessionData> {
  const defaults = defaultSession();
  try {
    if (!inTauri()) {
      const raw = localStorage.getItem(FALLBACK);
      return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<SessionData>) } : defaults;
    }
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load("settings.json", { autoSave: true, defaults: {} });
    const saved = await store.get<Partial<SessionData>>("session");
    return { ...defaults, ...(saved ?? {}) };
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
