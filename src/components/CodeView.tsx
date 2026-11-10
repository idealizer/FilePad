import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { defaultHighlightStyle, LanguageSupport, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { c, cpp, csharp, java } from "@codemirror/legacy-modes/mode/clike";
import { go } from "@codemirror/legacy-modes/mode/go";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { Decoration, EditorView, ViewPlugin, lineNumbers, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { ThemeMode } from "../types";

const COLOR_LIMIT = 750_000;

export function CodeView({ text, extension, truncated, theme }: { text: string; extension: string; truncated: boolean; theme: ThemeMode }) {
  const host = useRef<HTMLDivElement>(null);
  const colored = text.length <= COLOR_LIMIT;
  useEffect(() => {
    const node = host.current;
    if (!node || !colored) return;
    const dark = theme === "dark" || theme === "retro" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const view = new EditorView({
      parent: node,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "var(--editor)", color: "var(--text)" },
            ".cm-scroller": { fontFamily: "var(--mono)", fontSize: "12px", lineHeight: "1.55" },
            ".cm-gutters": { backgroundColor: "var(--editor)", color: "var(--muted)", border: "none" },
            ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
            ".cm-content": { padding: "8px 0 24px" },
            ".cm-cursor": { display: "none" },
            "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--selection)" },
          }, { dark }),
          syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle, { fallback: true }),
          languageFor(extension),
          extension === "log" ? logLines : [],
        ],
      }),
    });
    return () => view.destroy();
  }, [text, extension, theme, colored]);

  if (!colored) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="px-3 py-1 text-xs text-[var(--muted)]">Too long to color.</div>
        <pre className="fp-pre">{text}{truncated ? "\n\n… preview stopped at 8 MB" : ""}</pre>
      </div>
    );
  }
  return (
    <div className="fp-code">
      <div ref={host} className="fp-code-host" />
      {truncated && <div className="border-t border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)]">Preview stopped at 8 MB</div>}
    </div>
  );
}

function languageFor(extension: string): LanguageSupport | [] {
  switch (extension) {
    case "html":
    case "htm":
    case "xml":
      return html({ matchClosingTags: true, selfClosingTags: true });
    case "json":
    case "jsonl":
      return json();
    case "md":
    case "markdown":
      return markdown();
    case "css":
      return css();
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: extension === "jsx" });
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: extension === "tsx" });
    case "php":
      return php();
    case "py":
      return python();
    case "rs":
      return stream(rust);
    case "go":
      return stream(go);
    case "java":
      return stream(java);
    case "c":
    case "h":
      return stream(c);
    case "cpp":
    case "hpp":
      return stream(cpp);
    case "cs":
      return stream(csharp);
    case "rb":
      return stream(ruby);
    case "sh":
      return stream(shell);
    case "ps1":
      return stream(powerShell);
    case "sql":
      return stream(standardSQL);
    case "yaml":
    case "yml":
      return stream(yaml);
    case "toml":
      return stream(toml);
    case "ini":
      return stream(properties);
    default:
      return [];
  }
}

function stream(parser: Parameters<typeof StreamLanguage.define>[0]): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(parser));
}

const errorLine = Decoration.line({ class: "cm-log-error" });
const warnLine = Decoration.line({ class: "cm-log-warn" });

const logLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = logDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.viewportChanged) this.decorations = logDecorations(update.view);
    }
  },
  { decorations: (value) => value.decorations },
);

function logDecorations(view: EditorView) {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of view.visibleRanges) {
    let pos = range.from;
    while (pos <= range.to) {
      const line = view.state.doc.lineAt(pos);
      if (/\b(fatal|error|exception|uncaught|critical)\b/i.test(line.text)) builder.add(line.from, line.from, errorLine);
      else if (/\b(warn|warning|deprecated)\b/i.test(line.text)) builder.add(line.from, line.from, warnLine);
      if (line.to >= view.state.doc.length) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}
