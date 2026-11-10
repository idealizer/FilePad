import { useApp } from "../stores/appStore";

const keys = [
  { key: "F2", label: "Rename", run: (store: ReturnType<typeof useApp.getState>) => store.askRename() },
  { key: "F3", label: "View", run: (store: ReturnType<typeof useApp.getState>) => store.previewOther() },
  { key: "F4", label: "Open", run: (store: ReturnType<typeof useApp.getState>) => void store.openCurrent() },
  { key: "F5", label: "Copy", run: (store: ReturnType<typeof useApp.getState>) => void store.copyToOther() },
  { key: "F6", label: "Move", run: (store: ReturnType<typeof useApp.getState>) => void store.moveToOther() },
  { key: "F7", label: "New", run: (store: ReturnType<typeof useApp.getState>) => store.askMkdir() },
  { key: "F8", label: "Delete", run: (store: ReturnType<typeof useApp.getState>) => store.askDelete() },
];

export function KeyBar() {
  return (
    <div className="flex h-8 shrink-0 items-stretch overflow-hidden border-t border-[var(--border)] bg-[var(--bg)]">
      {keys.map((item) => (
        <button key={item.key} className="fp-key min-w-0 flex-1" onClick={() => item.run(useApp.getState())}>
          <b>{item.key}</b>{item.label}
        </button>
      ))}
    </div>
  );
}
