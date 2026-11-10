export interface NameSource {
  path: string;
  name: string;
  modified: number;
  isDir: boolean;
}

export interface NameTemplate {
  label: string;
  pattern: string;
  separator: string;
  dateFormat: string;
}

export interface NameRule {
  pattern: string;
  separator: string;
  dateFormat: string;
}

export interface PlannedName {
  path: string;
  from: string;
  name: string;
  error: string | null;
}

export const builtinTemplates: NameTemplate[] = [
  { label: "Name and date", pattern: "{name}{sep}{date}", separator: "_", dateFormat: "YYYYMMDD" },
  { label: "Date and name", pattern: "{date}{sep}{name}", separator: "_", dateFormat: "YYYYMMDD" },
  { label: "Numbered", pattern: "{name}{sep}{n:2}", separator: "_", dateFormat: "YYYYMMDD" },
];

export function templateChoices(saved: NameTemplate[]): NameTemplate[] {
  const labels = new Set(saved.map((template) => template.label));
  return [...builtinTemplates.filter((template) => !labels.has(template.label)), ...saved];
}

export function planNames(files: NameSource[], rule: NameRule, taken: string[]): PlannedName[] {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  for (const file of files) used.delete(file.name.toLowerCase());
  const planned = files.map((file, index) => {
    const { stem, ext } = splitName(file.name, file.isDir);
    const rendered = renderPattern(rule, stem, ext, file.modified, index);
    const name = finishName(rendered, ext, rule.pattern);
    return { path: file.path, from: file.name, name, error: name ? null : "That pattern made an empty name." };
  });
  for (const item of planned) {
    if (!item.name) continue;
    let name = item.name;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      name = withSuffix(item.name, suffix);
      suffix += 1;
      if (suffix > 10000) {
        item.error = "Too many files would share this name.";
        break;
      }
    }
    if (!item.error) {
      item.name = name;
      used.add(name.toLowerCase());
    }
  }
  return planned;
}

function renderPattern(rule: NameRule, stem: string, ext: string, modified: number, index: number): string {
  const separator = rule.separator.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "");
  return rule.pattern.replace(/\{([a-z]+)(?::([^}]+))?\}/gi, (full, key: string, arg?: string) => {
    const token = key.toLowerCase();
    if (token === "name") return stem;
    if (token === "ext") return ext;
    if (token === "sep") return separator;
    if (token === "date") return formatDate(modified, arg || rule.dateFormat || "YYYYMMDD");
    if (token === "n" || token === "num") {
      const width = Number(arg);
      const text = String(index + 1);
      return width > 0 ? text.padStart(width, "0") : text;
    }
    return full;
  });
}

function finishName(rendered: string, ext: string, pattern: string): string {
  const base = sanitize(rendered);
  if (!base) return "";
  if (!ext || /\{ext\}/i.test(pattern)) return base;
  if (base.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return base;
  return `${base}.${ext}`;
}

function sanitize(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/[. ]+$/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "";
  return cleaned;
}

function withSuffix(name: string, suffix: number): string {
  const dot = name.lastIndexOf(".");
  if (dot > 0) return `${name.slice(0, dot)}_${suffix}${name.slice(dot)}`;
  return `${name}_${suffix}`;
}

function splitName(name: string, isDir: boolean): { stem: string; ext: string } {
  if (isDir) return { stem: name, ext: "" };
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot + 1) };
}

export function formatDate(ms: number, pattern: string): string {
  const date = new Date(ms || 0);
  const parts: [string, string][] = [
    ["YYYY", String(date.getFullYear())],
    ["MM", pad(date.getMonth() + 1)],
    ["DD", pad(date.getDate())],
    ["HH", pad(date.getHours())],
    ["mm", pad(date.getMinutes())],
    ["ss", pad(date.getSeconds())],
  ];
  let out = "";
  for (let index = 0; index < pattern.length;) {
    const found = parts.find(([token]) => pattern.startsWith(token, index));
    if (found) {
      out += found[1];
      index += found[0].length;
    } else {
      out += pattern[index];
      index += 1;
    }
  }
  return out;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
