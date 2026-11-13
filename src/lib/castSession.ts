import { invoke, message } from "./platform";
import { toast } from "../stores/toastStore";

let active = false;
const watchers = new Set<(on: boolean) => void>();
let seekTimer = 0;
let seekAt = 0;

export function setCastActive(on: boolean) {
  active = on;
  watchers.forEach((watch) => watch(on));
}

export function watchCast(watch: (on: boolean) => void) {
  watchers.add(watch);
  watch(active);
  return () => {
    watchers.delete(watch);
  };
}

function fail(reason: unknown) {
  toast("error", message(reason));
}

export function castResume() {
  if (!active) return;
  void invoke("cast_resume").catch(fail);
}

export function castPause() {
  if (!active) return;
  void invoke("cast_pause").catch(fail);
}

export function castSeek(ms: number) {
  if (!active) return;
  seekAt = Math.max(0, Math.round(ms));
  window.clearTimeout(seekTimer);
  seekTimer = window.setTimeout(() => {
    if (!active) return;
    void invoke("cast_seek", { ms: seekAt }).catch(fail);
  }, 160);
}
