import { useEffect, type RefObject } from "react";
import type { Side } from "../types";

type Slot = {
  locked: boolean;
  panes: Partial<Record<Side, HTMLElement>>;
  leader: Side | null;
  release: number;
  epoch: number;
  suspend: number;
};

function slot(): Slot {
  const host = globalThis as typeof globalThis & { __filepadScroll?: Slot };
  if (!host.__filepadScroll) {
    host.__filepadScroll = { locked: false, panes: {}, leader: null, release: 0, epoch: 0, suspend: 0 };
  }
  return host.__filepadScroll;
}

slot().epoch += 1;
const epoch = slot().epoch;

export function setScrollLock(value: boolean) {
  const state = slot();
  state.locked = value;
  state.leader = null;
  window.clearTimeout(state.release);
}

export function scrollLockEnabled(): boolean {
  return slot().locked;
}

export function alignScroll(side: Side) {
  const state = slot();
  state.leader = null;
  followScroll(side);
}

export function holdScrollSync() {
  const state = slot();
  state.suspend = (state.suspend ?? 0) + 1;
  window.setTimeout(() => {
    state.suspend = Math.max(0, (state.suspend ?? 1) - 1);
  }, 60);
}

export function followScroll(side: Side) {
  const state = slot();
  if (!state.locked || (state.suspend ?? 0) > 0) {
    if (!state.locked) state.leader = null;
    return;
  }
  if (state.leader && state.leader !== side) return;
  const source = state.panes[side];
  const otherSide: Side = side === "left" ? "right" : "left";
  const other = state.panes[otherSide];
  if (!source || !other) return;
  const max = Math.max(0, other.scrollHeight - other.clientHeight);
  const top = Math.min(source.scrollTop, max);
  state.leader = side;
  window.clearTimeout(state.release);
  state.release = window.setTimeout(() => {
    if (slot().leader === side) slot().leader = null;
  }, 120);
  if (Math.abs(other.scrollTop - top) < 1) return;
  other.scrollTop = top;
}

export function useLinkedScroll(side: Side, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    slot().panes[side] = node;
    const onScroll = () => followScroll(side);
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (slot().panes[side] === node) delete slot().panes[side];
    };
  }, [side, epoch]);
}
