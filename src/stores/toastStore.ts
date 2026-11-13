import { create } from "zustand";
import type { ToastKind } from "../types";

type NoticeKind = ToastKind | "progress";

interface ToastItem {
  id: string;
  kind: NoticeKind;
  text: string;
  ratio?: number | null;
}

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, text: string) => void;
  job: (text: string) => string;
  jobRatio: (id: string, ratio: number | null, text?: string) => void;
  settle: (id: string, kind: ToastKind, text: string) => void;
  dismiss: (id: string) => void;
}

const HOLD = 3000;

function dropLater(id: string) {
  window.setTimeout(() => {
    useToasts.setState((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
  }, HOLD);
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, text) => {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts, { id, kind, text }] }));
    dropLater(id);
  },
  job: (text) => {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts, { id, kind: "progress", text, ratio: null }] }));
    return id;
  },
  jobRatio: (id, ratio, text) => set((state) => ({
    toasts: state.toasts.map((item) => item.id === id && item.kind === "progress"
      ? { ...item, ratio, text: text ?? item.text }
      : item),
  })),
  settle: (id, kind, text) => {
    set((state) => {
      const next = { id, kind, text };
      const exists = state.toasts.some((item) => item.id === id);
      return { toasts: exists ? state.toasts.map((item) => item.id === id ? next : item) : [...state.toasts, next] };
    });
    dropLater(id);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
}));

export function toast(kind: ToastKind, text: string) {
  useToasts.getState().push(kind, text);
}

export function jobStart(text: string) {
  return useToasts.getState().job(text);
}

export function jobUpdate(id: string, ratio: number | null, text?: string) {
  useToasts.getState().jobRatio(id, ratio, text);
}

export function jobFinish(id: string, kind: ToastKind, text: string) {
  useToasts.getState().settle(id, kind, text);
}

export function jobCancel(id: string) {
  useToasts.getState().dismiss(id);
}
