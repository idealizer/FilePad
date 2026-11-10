import { useMemo, useRef, useState } from "react";
import { baseName } from "../lib/format";
import { planNames, templateChoices, type NameTemplate } from "../lib/names";
import { useApp } from "../stores/appStore";
import { toast } from "../stores/toastStore";

export function ModalHost() {
  const modal = useApp((state) => state.modal);
  if (!modal) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 p-6">
      <div className={`w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl ${modal.type === "renameMany" ? "max-w-xl" : "max-w-md"}`}>
        {modal.type === "delete" && <DeleteDialog />}
        {modal.type === "mkdir" && <NameDialog key="mkdir" title="New folder" label="Folder name" action="Create" onSubmit={(name) => void useApp.getState().confirmMkdir(name)} />}
        {modal.type === "rename" && <NameDialog key={modal.path} title="Rename" label="New name" action="Rename" initial={modal.name} onSubmit={(name) => void useApp.getState().confirmRename(name)} />}
        {modal.type === "renameMany" && <PatternDialog />}
        {modal.type === "zip" && <NameDialog key={modal.name} title="Send to zip" label="Zip name" action="Create" initial={modal.name} onSubmit={(name) => void useApp.getState().confirmZip(name)} />}
        {modal.type === "overwrite" && <OverwriteDialog />}
      </div>
    </div>
  );
}

function DeleteDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const confirmDelete = useApp((state) => state.confirmDelete);
  if (modal?.type !== "delete") return null;
  const shown = modal.paths.slice(0, 8).map(baseName);
  return (
    <>
      <h2 className="text-base font-semibold">Delete {modal.paths.length === 1 ? "this item" : `${modal.paths.length} items`}?</h2>
      <ul className="mt-3 max-h-40 overflow-auto text-sm text-[var(--muted)]">
        {modal.paths.slice(0, 8).map((path) => <li key={path} className="truncate">{baseName(path)}</li>)}
        {modal.paths.length > shown.length && <li>and {modal.paths.length - shown.length} more</li>}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn danger" onClick={() => void confirmDelete()}>Delete</button>
      </div>
    </>
  );
}

function NameDialog({ title, label, action, initial = "", onSubmit }: { title: string; label: string; action: string; initial?: string; onSubmit: (name: string) => void }) {
  const closeModal = useApp((state) => state.closeModal);
  const [name, setName] = useState(initial);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(name);
      }}
    >
      <h2 className="text-base font-semibold">{title}</h2>
      <label className="mt-3 block text-sm text-[var(--muted)]">
        {label}
        <input className="field mt-1 w-full" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" type="button" onClick={closeModal}>Cancel</button>
        <button className="btn primary" type="submit" disabled={!name.trim()}>{action}</button>
      </div>
    </form>
  );
}

function PatternDialog() {
  const modal = useApp((state) => state.modal);
  const saved = useApp((state) => state.nameTemplates);
  const closeModal = useApp((state) => state.closeModal);
  const patternRef = useRef<HTMLInputElement>(null);
  const choices = templateChoices(saved);
  const [pattern, setPattern] = useState("{name}{sep}{date}");
  const [separator, setSeparator] = useState("_");
  const [dateFormat, setDateFormat] = useState("YYYYMMDD");
  const [label, setLabel] = useState("");
  const [picked, setPicked] = useState("Name and date");
  const planned = useMemo(() => {
    if (modal?.type !== "renameMany") return [];
    return planNames(modal.items, { pattern, separator, dateFormat }, modal.taken);
  }, [modal, pattern, separator, dateFormat]);
  if (modal?.type !== "renameMany") return null;
  const ready = planned.length > 0 && planned.every((item) => item.name && !item.error);
  const apply = (template: NameTemplate) => {
    setPattern(template.pattern);
    setSeparator(template.separator);
    setDateFormat(template.dateFormat);
    setPicked(template.label);
  };
  const insert = (token: string) => {
    const input = patternRef.current;
    const start = input?.selectionStart ?? pattern.length;
    const end = input?.selectionEnd ?? start;
    const next = pattern.slice(0, start) + token + pattern.slice(end);
    setPattern(next);
    setPicked("");
    requestAnimationFrame(() => {
      input?.focus();
      const caret = start + token.length;
      input?.setSelectionRange(caret, caret);
    });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void useApp.getState().confirmRenameMany(planned.map((item) => ({ path: item.path, name: item.name })));
      }}
    >
      <h2 className="text-base font-semibold">Rename {modal.items.length} items</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">Date uses each file's modified time. Matching names get 2, 3, and so on.</p>
      <label className="mt-3 block text-sm text-[var(--muted)]">
        Saved template
        <select
          className="field mt-1 w-full"
          value={picked}
          onChange={(event) => {
            const next = choices.find((template) => template.label === event.target.value);
            if (next) apply(next);
            else setPicked("");
          }}
        >
          <option value="">Custom</option>
          {choices.map((template) => <option key={template.label} value={template.label}>{template.label}</option>)}
        </select>
      </label>
      <label className="mt-3 block text-sm text-[var(--muted)]">
        Pattern
        <input ref={patternRef} className="field mt-1 w-full" autoFocus value={pattern} spellCheck={false} onChange={(event) => { setPattern(event.target.value); setPicked(""); }} />
      </label>
      <div className="mt-2 flex flex-wrap gap-1">
        <button className="fp-token" type="button" onClick={() => insert("{name}")}>Name</button>
        <button className="fp-token" type="button" onClick={() => insert("{sep}")}>Separator</button>
        <button className="fp-token" type="button" onClick={() => insert("{date}")}>Date</button>
        <button className="fp-token" type="button" onClick={() => insert("{n:2}")}>Number</button>
        <button className="fp-token" type="button" onClick={() => insert("{ext}")}>Extension</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block text-sm text-[var(--muted)]">
          Separator
          <input className="field mt-1 w-full" value={separator} spellCheck={false} maxLength={8} onChange={(event) => { setSeparator(event.target.value); setPicked(""); }} />
        </label>
        <label className="block text-sm text-[var(--muted)]">
          Date format
          <input className="field mt-1 w-full" value={dateFormat} spellCheck={false} maxLength={32} onChange={(event) => { setDateFormat(event.target.value); setPicked(""); }} />
        </label>
      </div>
      <div className="mt-3 max-h-36 overflow-auto rounded-md border border-[var(--border)] text-sm">
        {planned.slice(0, 8).map((item) => (
          <div key={item.path} className="flex gap-2 border-b border-[var(--border)] px-2 py-1 last:border-0">
            <span className="min-w-0 flex-1 truncate text-[var(--muted)]">{item.from}</span>
            <span className="min-w-0 flex-1 truncate">{item.error ?? item.name}</span>
          </div>
        ))}
        {planned.length > 8 && <div className="px-2 py-1 text-[var(--muted)]">and {planned.length - 8} more</div>}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          className="field min-w-0 flex-1"
          placeholder="Template name"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const name = label.trim();
            if (!name) {
              toast("warning", "Name the template first.");
              return;
            }
            useApp.getState().saveNameTemplate({ label: name, pattern, separator, dateFormat });
            setPicked(name);
          }}
        />
        <button
          className="btn"
          type="button"
          onClick={() => {
            const name = label.trim();
            if (!name) {
              toast("warning", "Name the template first.");
              return;
            }
            useApp.getState().saveNameTemplate({ label: name, pattern, separator, dateFormat });
            setPicked(name);
          }}
        >
          Save
        </button>
        <button
          className="btn"
          type="button"
          disabled={!saved.some((template) => template.label === picked)}
          onClick={() => {
            useApp.getState().deleteNameTemplate(picked);
            setPicked("");
          }}
        >
          Delete
        </button>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" type="button" onClick={closeModal}>Cancel</button>
        <button className="btn primary" type="submit" disabled={!ready}>Rename</button>
      </div>
    </form>
  );
}

function OverwriteDialog() {
  const modal = useApp((state) => state.modal);
  const closeModal = useApp((state) => state.closeModal);
  const confirmOverwrite = useApp((state) => state.confirmOverwrite);
  if (modal?.type !== "overwrite") return null;
  return (
    <>
      <h2 className="text-base font-semibold">Replace existing items?</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">These names are already in the destination.</p>
      <ul className="mt-3 max-h-40 overflow-auto text-sm">
        {modal.conflicts.slice(0, 8).map((name) => <li key={name} className="truncate">{name}</li>)}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={closeModal}>Cancel</button>
        <button className="btn primary" onClick={() => void confirmOverwrite()}>Replace</button>
      </div>
    </>
  );
}
