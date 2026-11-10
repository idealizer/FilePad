import { create } from "zustand";
import type { ToastKind } from "../types";

interface ToastItem {
  id: string;
  kind: ToastKind;
  text: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, text: string) => void;
  dismiss: (id: string) => void;
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, text) => {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts, { id, kind, text }] }));
    window.setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) }));
    }, 3000);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((item) => item.id !== id) })),
}));

export function toast(kind: ToastKind, text: string) {
  useToasts.getState().push(kind, text);
}
